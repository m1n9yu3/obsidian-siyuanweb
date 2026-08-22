import { App, MarkdownView, Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder } from 'obsidian';
import { SiYuanApi, Notebook, FileTreeItem } from './siyuan-api';

interface SyncSettings {
  baseUrl: string;
  token: string;
  notebookId: string;
  createMissingNotebook: boolean;
  removeMissingNotes: boolean;
}

interface SyncState {
  [path: string]: string; // local path -> fingerprint
}

const DEFAULT_SETTINGS: SyncSettings = {
  baseUrl: 'http://127.0.0.1:6806',
  token: '',
  notebookId: '',
  createMissingNotebook: false,
  removeMissingNotes: false,
};

const DEFAULT_STATE: SyncState = {};

function siyuanPathFor(file: TFile): string {
  return `/${file.path}`;
}

/** Find the filetree entry whose human-readable path equals the target path. */
async function findDocByHPath(
  api: SiYuanApi,
  notebookId: string,
  target: string,
): Promise<FileTreeItem | null> {
  const segments = target.split('/').filter(Boolean);
  let dirPath = '/';
  let files = await api.listDocsByPath(notebookId, dirPath);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLeaf = i === segments.length - 1;
    const entry = files.find((f) => f.name === segment || f.name === `${segment}.sy`);
    if (!entry) return null;
    if (isLeaf) {
      return entry.name === `${segment}.sy` || entry.subFileCount === 0 ? entry : null;
    }
    if (entry.subFileCount === 0) return null;
    files = await api.listDocsByPath(notebookId, entry.path);
  }
  return null;
}

/** Recursively collect every doc entry (leaf and container) in a notebook. */
async function collectAllDocs(
  api: SiYuanApi,
  notebookId: string,
  path: string,
  out: FileTreeItem[],
): Promise<void> {
  const files = await api.listDocsByPath(notebookId, path);
  for (const file of files) {
    out.push(file);
    if (file.subFileCount > 0) {
      await collectAllDocs(api, notebookId, file.path, out);
    }
  }
}

async function collectMarkdownFiles(folder: TFolder, files: TFile[]): Promise<void> {
  for (const child of folder.children) {
    if (child instanceof TFolder) {
      await collectMarkdownFiles(child, files);
    } else if (child instanceof TFile && child.extension === 'md') {
      files.push(child);
    }
  }
}

/** Replace ![[img.png]] with ![img.png](img.png) so uploader can process it. */
function normalizeWikiImageLinks(md: string): string {
  return md.replace(/!\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]/g, (m, target: string) => {
    const t = target.trim();
    return `![${t}](${t})`;
  });
}

/** Resolve an image link target to a TFile using Obsidian's link resolution first,
 * then vault-relative lookup, then a vault-wide filename search (covers unattached
 * images in folders like attach/ that metadataCache may not have indexed yet). */
function resolveImageFile(app: App, sourceFile: TFile, target: string): TFile | null {
  const byLink = app.metadataCache.getFirstLinkpathDest(target, sourceFile.path);
  if (byLink instanceof TFile) return byLink;
  const direct = app.vault.getAbstractFileByPath(target);
  if (direct instanceof TFile) return direct;
  const dir = sourceFile.parent?.path ?? '';
  const relative = app.vault.getAbstractFileByPath(dir ? `${dir}/${target}` : target);
  if (relative instanceof TFile) return relative;
  const name = target.split('/').pop() ?? target;
  const found = app.vault.getFiles().filter((f) => f.name === name);
  return found.length === 1 ? found[0] : found.length > 1 ? found[0] : null;
}

/** Decode a data: URI payload into bytes and the MIME type. */
function decodeDataUri(uri: string): { bytes: ArrayBuffer; mime: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const payload = m[3];
  if (!m[2]) {
    // Percent-encoded data URI (rare in markdown images).
    const decoded = decodeURIComponent(payload);
    return { bytes: new TextEncoder().encode(decoded).buffer, mime };
  }
  try {
    const bin = atob(payload.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes: bytes.buffer, mime };
  } catch {
    return null;
  }
}

/** Simple stable fingerprint for a markdown note plus the images it embeds. */
async function fingerprintFor(
  app: App,
  sourceFile: TFile,
  md: string,
  imageFiles: TFile[],
): Promise<string> {
  const parts: string[] = [md];
  for (const f of imageFiles) {
    parts.push(`${f.path}:${f.stat.mtime}:${f.stat.size}`);
  }
  return parts.join('\n---\n');
}

interface PreparedMarkdown {
  md: string;
  uploaded: number;
  failed: string[];
  imageFiles: TFile[];
}

/** Upload local and base64 images, rewriting markdown links to SiYuan assets. */
async function prepareMarkdown(
  app: App,
  api: SiYuanApi,
  sourceFile: TFile,
  md: string,
): Promise<PreparedMarkdown> {
  // Work on the normalized string end-to-end so wiki link rewrites and asset rewrites share the same source of truth.
  let normalized = normalizeWikiImageLinks(md);
  const imageRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const uploads = new Map<string, string>();
  const failed: string[] = [];
  const imageFiles: TFile[] = [];
  let uploaded = 0;

  const matches: { raw: string; alt: string; target: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = imageRe.exec(normalized))) {
    matches.push({ raw: m[0], alt: m[1], target: m[2].trim() });
  }

  for (const { raw, alt, target } of matches) {
    if (/^(https?:|obsidian:|app:|file:)/i.test(target)) continue;

    // Inline base64 image: decode and upload as an asset.
    if (/^data:/i.test(target)) {
      const decoded = decodeDataUri(target);
      if (!decoded) {
        failed.push('invalid data URI');
        continue;
      }
      const mime = decoded.mime;
      const extMatch = /^image\/([a-zA-Z0-9+.-]+)/.exec(mime);
      const ext = extMatch ? extMatch[1].replace('jpeg', 'jpg') : 'png';
      const fileName = `obsidian-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      try {
        const assetPath = await api.uploadAsset(fileName, decoded.bytes, mime);
        uploads.set(target, assetPath);
        normalized = normalized.replace(raw, `![${alt}](${assetPath})`);
        uploaded++;
      } catch (e) {
        failed.push(`${fileName}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }

    // Local file image: resolve and upload (dedupe per note by file path).
    const tf = resolveImageFile(app, sourceFile, target);
    if (!tf) {
      failed.push(target);
      continue;
    }

    const cached = uploads.get(tf.path);
    if (cached) {
      normalized = normalized.replace(raw, `![${alt}](${cached})`);
      continue;
    }

    try {
      const bytes = await app.vault.readBinary(tf);
      const mime = `image/${tf.extension}`;
      const assetPath = await api.uploadAsset(tf.name, bytes, mime);
      uploads.set(tf.path, assetPath);
      imageFiles.push(tf);
      normalized = normalized.replace(raw, `![${alt}](${assetPath})`);
      uploaded++;
    } catch (e) {
      failed.push(`${tf.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { md: normalized, uploaded, failed, imageFiles };
}

export default class SiYuanSyncPlugin extends Plugin {
  settings: SyncSettings = DEFAULT_SETTINGS;
  private syncState: SyncState = { ...DEFAULT_STATE };
  private api!: SiYuanApi;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.api = new SiYuanApi(this.settings.baseUrl, this.settings.token);

    this.addRibbonIcon('refresh-cw', 'Sync note to SiYuan', () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || !view.file) {
        new Notice('No active Markdown note to sync.');
        return;
      }
      void this.syncFile(view.file);
    });

    this.addCommand({
      id: 'sync-current-note',
      name: 'Sync current note to SiYuan',
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) {
          new Notice('No active Markdown note to sync.');
          return;
        }
        void this.syncFile(view.file);
      },
    });

    this.addCommand({
      id: 'sync-all-notes',
      name: 'Sync all notes to SiYuan',
      callback: () => {
        void this.syncAll();
      },
    });

    this.addSettingTab(new SiYuanSyncSettingTab(this.app, this));
  }

  onunload(): void {}

  private async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as (SyncSettings & { syncState?: SyncState }) | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    this.syncState = Object.assign({}, DEFAULT_STATE, data?.syncState ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings, syncState: this.syncState });
    this.api = new SiYuanApi(this.settings.baseUrl, this.settings.token);
  }

  private async syncFile(file: TFile): Promise<void> {
    try {
      const nb = await this.ensureNotebook();
      const rawMd = await this.app.vault.read(file);
      const prepared = await prepareMarkdown(this.app, this.api, file, rawMd);
      const fp = await fingerprintFor(this.app, file, prepared.md, prepared.imageFiles);
      const path = siyuanPathFor(file);

      if (this.syncState[file.path] === fp) {
        const existing = await findDocByHPath(this.api, nb.id, path);
        if (existing) {
          new Notice(`SiYuan: skipped ${file.name} (unchanged)`);
          return;
        }
      }

      const existing = await findDocByHPath(this.api, nb.id, path);
      if (existing) {
        await this.api.removeDoc(nb.id, existing.path);
      }
      await this.api.createDocWithMd(nb.id, path, prepared.md);
      this.syncState[file.path] = fp;
      await this.saveSettings();

      const imgNote = prepared.uploaded > 0 ? `, ${prepared.uploaded} images` : '';
      const failNote = prepared.failed.length > 0 ? ` (${prepared.failed.length} image failed)` : '';
      new Notice(`SiYuan: ${existing ? 'updated' : 'created'} ${file.name}${imgNote}${failNote}`);
    } catch (e) {
      new Notice(`SiYuan sync failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async syncAll(): Promise<void> {
    let nb: Notebook;
    try {
      nb = await this.ensureNotebook();
    } catch (e) {
      new Notice(`SiYuan sync failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const files: TFile[] = [];
    await collectMarkdownFiles(this.app.vault.getRoot(), files);
    const localPaths = new Set(files.map((f) => `/${f.path}`));

    let ok = 0;
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let removed = 0;
    let images = 0;
    const errors: string[] = [];
    const notice = new Notice(`Syncing to SiYuan... 0/${files.length}`, 0);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      notice.setMessage(`Syncing to SiYuan... ${i + 1}/${files.length}: ${file.path}`);
      try {
        const rawMd = await this.app.vault.read(file);
        const prepared = await prepareMarkdown(this.app, this.api, file, rawMd);
        images += prepared.uploaded;
        if (prepared.failed.length > 0) {
          errors.push(`${file.path}: images failed: ${prepared.failed.join(', ')}`);
        }
        const fp = await fingerprintFor(this.app, file, prepared.md, prepared.imageFiles);
        const path = siyuanPathFor(file);

        if (this.syncState[file.path] === fp) {
          const existing = await findDocByHPath(this.api, nb.id, path);
          if (existing) {
            skipped++;
            continue;
          }
        }

        const existing = await findDocByHPath(this.api, nb.id, path);
        if (existing) {
          await this.api.removeDoc(nb.id, existing.path);
          updated++;
        } else {
          created++;
        }
        await this.api.createDocWithMd(nb.id, path, prepared.md);
        this.syncState[file.path] = fp;
        ok++;
      } catch (e) {
        errors.push(`${file.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (this.settings.removeMissingNotes) {
      const allDocs: FileTreeItem[] = [];
      await collectAllDocs(this.api, nb.id, '/', allDocs);
      const leafDocs = allDocs.filter((d) => d.subFileCount === 0 && d.name.endsWith('.sy'));
      for (const doc of leafDocs) {
        const hPath = await this.api.getHPathByID(doc.id);
        if (hPath !== '/' && !localPaths.has(hPath) && !hPath.endsWith('/')) {
          try {
            await this.api.removeDoc(nb.id, doc.path);
            removed++;
          } catch (e) {
            errors.push(`remove ${hPath}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }

    await this.saveSettings();
    notice.hide();

    if (errors.length === 0) {
      new Notice(`SiYuan: synced ${ok} (${created} created, ${updated} updated, ${skipped} skipped${removed ? `, ${removed} removed` : ''}${images ? `, ${images} images` : ''}).`);
    } else {
      new Notice(`SiYuan: synced ${ok}, skipped ${skipped}, failed ${errors.length}.`);
      console.error('SiYuan sync errors', errors);
    }
  }

  private async ensureNotebook(): Promise<Notebook> {
    const notebooks = await this.api.listNotebooks();
    if (this.settings.notebookId) {
      const nb = notebooks.find((n) => n.id === this.settings.notebookId);
      if (nb) return nb;
    }
    const named = notebooks.find((n) => n.name === 'obsidian');
    if (named) {
      this.settings.notebookId = named.id;
      await this.saveSettings();
      return named;
    }
    if (!this.settings.createMissingNotebook) {
      throw new Error('Target notebook not found. Enable create-missing or pick a notebook in settings.');
    }
    const created = await this.api.createNotebook('obsidian');
    this.settings.notebookId = created.id;
    await this.saveSettings();
    return created;
  }
}

class SiYuanSyncSettingTab extends PluginSettingTab {
  private plugin: SiYuanSyncPlugin;
  private notebookDropdown!: import('obsidian').DropdownComponent;
  private notebooks: Notebook[] = [];

  constructor(app: App, plugin: SiYuanSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'SiYuan Sync settings' });

    new Setting(containerEl)
      .setName('SiYuan API URL')
      .setDesc('Example: http://your-siyuan-host:6806')
      .addText((text) =>
        text
          .setPlaceholder('http://your-siyuan-host:6806')
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('API token')
      .setDesc('Token shown in SiYuan Settings > Access Authorization > API token.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('siyuan api token')
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Target notebook')
      .setDesc('Notes will sync into this notebook.')
      .addDropdown((dd) => {
        this.notebookDropdown = dd;
        dd.addOption('', 'Loading...');
        void this.refreshNotebooks();
      });

    new Setting(containerEl)
      .setName('Refresh notebook list')
      .addButton((btn) =>
        btn.setButtonText('Refresh').onClick(async () => {
          await this.refreshNotebooks();
          new Notice('Notebook list refreshed.');
        }),
      );

    new Setting(containerEl)
      .setName('Create missing notebook')
      .setDesc('Automatically create a notebook named "obsidian" if it does not exist.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.createMissingNotebook).onChange(async (value) => {
          this.plugin.settings.createMissingNotebook = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Remove missing notes')
      .setDesc('During full sync, remove SiYuan docs whose source note was deleted. Only affects this notebook; use with care.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.removeMissingNotes).onChange(async (value) => {
          this.plugin.settings.removeMissingNotes = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  private async refreshNotebooks(): Promise<void> {
    try {
      const api = new SiYuanApi(this.plugin.settings.baseUrl, this.plugin.settings.token);
      this.notebooks = await api.listNotebooks();
      this.notebookDropdown.selectEl.empty();
      this.notebooks.forEach((nb) => {
        this.notebookDropdown.addOption(nb.id, nb.name);
      });
      const current = this.plugin.settings.notebookId;
      if (this.notebooks.some((n) => n.id === current)) {
        this.notebookDropdown.setValue(current);
      }
      this.notebookDropdown.selectEl.addEventListener('change', () => {
        this.plugin.settings.notebookId = this.notebookDropdown.getValue();
        void this.plugin.saveSettings();
      });
    } catch (e) {
      this.notebookDropdown.selectEl.empty();
      this.notebookDropdown.addOption('', `Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}





