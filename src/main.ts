import {
  App,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  TFolder,
  requestUrl,
} from 'obsidian';
import { SiYuanApi, Notebook, FileTreeItem } from './siyuan-api';
import { isImageExt } from './markdown';
import {
  collectLocalImages,
  prepareMarkdown,
  fingerprintPrepared,
  ImageResolver,
  MAX_REMOTE_BYTES,
  remoteFetchHeaders,
  sniffImageMime,
} from './prepare';
import { claimedHPaths, isUnderLocalFolder, mapVaultPathToHPath, syncRootHPath } from './paths';
import { RemoteTree } from './remote-tree';
import { collapseAllDuplicates, collapseLineage, noteNeedsRelocate, writeNote } from './upsert';
import {
  dropSyncStateKeys,
  isRemovableRemoteDoc,
  NoteSyncRecord,
  planNoteSync,
  recordOf,
  remapSyncStateKeys,
  resolveNotebook,
} from './sync-logic';

interface SyncSettings {
  baseUrl: string;
  token: string;
  /** User-typed notebook name or ID. Saved per Obsidian vault. */
  notebook: string;
  notebookId: string;
  localFolder: string;
  remoteDir: string;
  createMissingNotebook: boolean;
  removeMissingNotes: boolean;
}

interface SyncState {
  [path: string]: NoteSyncRecord | string;
}

const DEFAULT_SETTINGS: SyncSettings = {
  baseUrl: 'http://127.0.0.1:6806',
  token: '',
  notebook: '',
  notebookId: '',
  localFolder: '',
  remoteDir: '',
  createMissingNotebook: false,
  removeMissingNotes: false,
};

const DEFAULT_STATE: SyncState = {};

function syncRecord(fp: string, id: string, imageFailures: number): NoteSyncRecord {
  return imageFailures > 0 ? { fp, id, imgFail: imageFailures } : { fp, id };
}

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

function decodeLinkTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/** Resolve an image link. Never picks an arbitrary file when several share the same name. */
function resolveImageFile(app: App, sourceFile: TFile, target: string): TFile | null {
  const decoded = decodeLinkTarget(target.trim());
  const byLink = app.metadataCache.getFirstLinkpathDest(decoded, sourceFile.path);
  if (byLink instanceof TFile) return byLink;
  const direct = app.vault.getAbstractFileByPath(decoded);
  if (direct instanceof TFile) return direct;
  const dir = sourceFile.parent?.path ?? '';
  const relative = app.vault.getAbstractFileByPath(dir ? `${dir}/${decoded}` : decoded);
  if (relative instanceof TFile) return relative;
  const name = decoded.split('/').pop() ?? decoded;
  const found = app.vault.getFiles().filter((f) => f.name === name && isImageExt(f.extension));
  return found.length === 1 ? found[0] : null;
}

async function obsidianFetchRemote(url: string): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const resp = await requestUrl({
    url,
    method: 'GET',
    headers: remoteFetchHeaders(url),
    throw: false,
  });
  if (resp.status < 200 || resp.status >= 400) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const headerMime = (resp.headers['content-type'] || resp.headers['Content-Type'] || '')
    .split(';')[0]
    .trim();
  const bytes = resp.arrayBuffer;
  if (!bytes || bytes.byteLength === 0) throw new Error('empty response');
  if (bytes.byteLength > MAX_REMOTE_BYTES) {
    throw new Error(`image too large (${bytes.byteLength} bytes)`);
  }
  return { bytes, mime: sniffImageMime(bytes, headerMime, url) };
}

function makeResolver(app: App, sourceFile: TFile): ImageResolver {
  return {
    resolve: (_sourcePath, target) => {
      const tf = resolveImageFile(app, sourceFile, target);
      if (!tf || !isImageExt(tf.extension)) return null;
      return {
        path: tf.path,
        name: tf.name,
        extension: tf.extension,
        mtime: tf.stat.mtime,
        size: tf.stat.size,
      };
    },
    readBinary: async (path) => {
      const f = app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) throw new Error(`Missing file: ${path}`);
      return app.vault.readBinary(f);
    },
  };
}

export default class SiYuanSyncPlugin extends Plugin {
  settings: SyncSettings = DEFAULT_SETTINGS;
  private syncState: SyncState = { ...DEFAULT_STATE };
  private api!: SiYuanApi;
  private syncing = false;

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

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        const next = remapSyncStateKeys(this.syncState, oldPath, file.path);
        if (next === this.syncState) return;
        this.syncState = next;
        void this.saveSettings();
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        const next = dropSyncStateKeys(this.syncState, file.path);
        if (next === this.syncState) return;
        this.syncState = next;
        void this.saveSettings();
      }),
    );
  }

  onunload(): void {}

  private async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as (SyncSettings & { syncState?: SyncState }) | null;
    const syncState = data?.syncState;
    const rest = { ...(data ?? {}) } as Partial<SyncSettings> & { syncState?: SyncState };
    delete rest.syncState;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, rest);
    this.syncState = Object.assign({}, DEFAULT_STATE, syncState ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings, syncState: this.syncState });
    this.api = new SiYuanApi(this.settings.baseUrl, this.settings.token);
  }

  private noteHPath(file: TFile): string {
    return mapVaultPathToHPath(file.path, this.settings.localFolder, this.settings.remoteDir);
  }

  private syncRoot(): string {
    return syncRootHPath(this.settings.localFolder, this.settings.remoteDir);
  }

  private localSyncFolder(): TFolder {
    const raw = this.settings.localFolder.trim();
    if (!raw) return this.app.vault.getRoot();
    const rel = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const found = this.app.vault.getAbstractFileByPath(rel);
    if (found instanceof TFolder) return found;
    throw new Error(`Local folder not found: ${raw}`);
  }

  private beginSync(): boolean {
    if (this.syncing) {
      new Notice('SiYuan: a sync is already running.');
      return false;
    }
    this.syncing = true;
    return true;
  }

  private endSync(): void {
    this.syncing = false;
  }

  private async loadRemoteTree(notebookId: string): Promise<RemoteTree> {
    try {
      return RemoteTree.fromRows(await this.api.queryDocs(notebookId));
    } catch {
      const all: FileTreeItem[] = [];
      await collectAllDocs(this.api, notebookId, '/', all);
      const rows: Array<{ id: string; hpath: string; path: string }> = [];
      for (const doc of all) {
        try {
          const hPath = await this.api.getHPathByID(doc.id);
          rows.push({ id: doc.id, hpath: hPath || '/', path: doc.path });
        } catch {
          // Skip docs the kernel cannot resolve.
        }
      }
      return RemoteTree.fromRows(rows);
    }
  }

  private async syncFile(file: TFile): Promise<void> {
    if (!this.beginSync()) return;
    try {
      if (!isUnderLocalFolder(file.path, this.settings.localFolder)) {
        new Notice(`SiYuan: ${file.path} is outside the configured local folder.`);
        return;
      }
      const nb = await this.ensureNotebook();
      const hPath = this.noteHPath(file);
      const rawMd = await this.app.vault.read(file);
      const resolver = makeResolver(this.app, file);
      const images = collectLocalImages(file.path, rawMd, resolver);
      const fp = fingerprintPrepared(rawMd, images);
      const rec = recordOf(this.syncState[file.path]);
      const tree = await this.loadRemoteTree(nb.id);
      const existing = tree.findById(rec.id ?? '') ?? tree.findOne(hPath) ?? tree.resolve(file.path, rec.id);
      const action = planNoteSync({
        storedFingerprint: rec.fp,
        currentFingerprint: fp,
        remoteExists: Boolean(existing),
        imageFailures: rec.imgFail,
      });

      if (action === 'skip' && existing && !noteNeedsRelocate(existing, hPath)) {
        await collapseLineage(this.api, nb.id, tree, hPath);
        this.syncState[file.path] = { fp, id: existing.id };
        await this.saveSettings();
        new Notice(`SiYuan: skipped ${file.name} (unchanged)`);
        return;
      }

      const prepared = await prepareMarkdown(file.path, rawMd, resolver, this.api, {
        fetchRemote: { fetch: obsidianFetchRemote },
      });
      const result = await writeNote({
        api: this.api,
        notebookId: nb.id,
        localPath: file.path,
        hPath,
        markdown: prepared.md,
        storedId: rec.id ?? existing?.id,
        tree,
      });
      this.syncState[file.path] = syncRecord(fp, result.id, prepared.failed.length);
      await this.saveSettings();

      const imgNote = prepared.uploaded > 0 ? `, ${prepared.uploaded} images` : '';
      const failNote = prepared.failed.length > 0 ? ` (${prepared.failed.length} image failed)` : '';
      new Notice(
        `SiYuan: ${result.created ? 'created' : 'updated'} ${file.name}${imgNote}${failNote}`,
      );
    } catch (e) {
      new Notice(`SiYuan sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.endSync();
    }
  }

  private async syncAll(): Promise<void> {
    if (!this.beginSync()) return;
    let nb: Notebook;
    try {
      nb = await this.ensureNotebook();
    } catch (e) {
      this.endSync();
      new Notice(`SiYuan sync failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const files: TFile[] = [];
    let folder: TFolder;
    try {
      folder = this.localSyncFolder();
    } catch (e) {
      this.endSync();
      new Notice(`SiYuan sync failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await collectMarkdownFiles(folder, files);
    const claimed = claimedHPaths(files.map((f) => this.noteHPath(f)));
    const root = this.syncRoot();
    const tree = await this.loadRemoteTree(nb.id);

    let ok = 0;
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let removed = 0;
    let collapsed = 0;
    let images = 0;
    const errors: string[] = [];
    const notice = new Notice(`Syncing to SiYuan... 0/${files.length}`, 0);

    try {
      collapsed += await collapseAllDuplicates(this.api, nb.id, tree, root);

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        notice.setMessage(`Syncing to SiYuan... ${i + 1}/${files.length}: ${file.path}`);
        try {
          const rawMd = await this.app.vault.read(file);
          const resolver = makeResolver(this.app, file);
          const localImages = collectLocalImages(file.path, rawMd, resolver);
          const fp = fingerprintPrepared(rawMd, localImages);
          const rec = recordOf(this.syncState[file.path]);
          const hPath = this.noteHPath(file);
          const existing =
            tree.findById(rec.id ?? '') ?? tree.findOne(hPath) ?? tree.resolve(file.path, rec.id);
          const action = planNoteSync({
            storedFingerprint: rec.fp,
            currentFingerprint: fp,
            remoteExists: Boolean(existing),
            imageFailures: rec.imgFail,
          });

          if (action === 'skip' && existing && !noteNeedsRelocate(existing, hPath)) {
            this.syncState[file.path] = { fp, id: existing.id };
            skipped++;
            continue;
          }

          const prepared = await prepareMarkdown(file.path, rawMd, resolver, this.api, {
            fetchRemote: { fetch: obsidianFetchRemote },
          });
          images += prepared.uploaded;
          if (prepared.failed.length > 0) {
            errors.push(`${file.path}: images failed: ${prepared.failed.join(', ')}`);
          }
          const result = await writeNote({
            api: this.api,
            notebookId: nb.id,
            localPath: file.path,
            hPath,
            markdown: prepared.md,
            storedId: rec.id ?? existing?.id,
            tree,
          });
          this.syncState[file.path] = syncRecord(fp, result.id, prepared.failed.length);
          collapsed += result.collapsed;
          if (result.created) created++;
          else updated++;
          ok++;
        } catch (e) {
          errors.push(`${file.path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (this.settings.removeMissingNotes) {
        const ordered = tree
          .all()
          .sort((a, b) => b.hpath.split('/').length - a.hpath.split('/').length);
        for (const doc of ordered) {
          if (!isRemovableRemoteDoc(doc.hpath, tree.childCount(doc.id), claimed, root)) continue;
          try {
            await this.api.removeDocByID(doc.id);
            tree.remove(doc.id);
            removed++;
          } catch (e) {
            errors.push(`remove ${doc.hpath}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      const livePaths = new Set(files.map((f) => f.path));
      for (const key of Object.keys(this.syncState)) {
        if (!livePaths.has(key)) delete this.syncState[key];
      }

      await this.saveSettings();
    } finally {
      notice.hide();
      this.endSync();
    }

    if (errors.length === 0) {
      new Notice(
        `SiYuan: synced ${ok} (${created} created, ${updated} updated, ${skipped} skipped${removed ? `, ${removed} removed` : ''}${collapsed ? `, ${collapsed} duplicates merged` : ''}${images ? `, ${images} images` : ''}).`,
      );
    } else {
      new Notice(`SiYuan: synced ${ok}, skipped ${skipped}, failed ${errors.length}.`);
      console.error('SiYuan sync errors', errors);
    }
  }

  private async ensureNotebook(): Promise<Notebook> {
    const notebooks = await this.api.listNotebooks();
    const target = this.settings.notebook.trim() || this.settings.notebookId;
    const choice = resolveNotebook(
      notebooks,
      target,
      this.settings.createMissingNotebook,
    );
    if (choice.type === 'error') throw new Error(choice.message);
    let nb: Notebook;
    if (choice.type === 'create') {
      nb = await this.api.createNotebook(choice.name);
      this.settings.notebook = choice.name;
      this.settings.notebookId = nb.id;
      await this.saveSettings();
    } else {
      nb = choice.notebook;
      if (this.settings.notebookId !== nb.id || (!this.settings.notebook && nb.name)) {
        this.settings.notebookId = nb.id;
        if (!this.settings.notebook.trim()) this.settings.notebook = nb.name;
        await this.saveSettings();
      }
    }
    if (nb.closed) {
      await this.api.openNotebook(nb.id);
      nb.closed = false;
    }
    return nb;
  }
}

class SiYuanSyncSettingTab extends PluginSettingTab {
  private plugin: SiYuanSyncPlugin;
  private notebookText!: import('obsidian').TextComponent;
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
      .setName('Local folder')
      .setDesc('Vault folder to sync. Leave empty for the whole vault. Example: 科锐逆向笔记')
      .addText((text) =>
        text
          .setPlaceholder('科锐逆向笔记')
          .setValue(this.plugin.settings.localFolder)
          .onChange(async (value) => {
            this.plugin.settings.localFolder = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Use current file folder')
      .addButton((btn) =>
        btn.setButtonText('Fill from active note').onClick(async () => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          const folder = view?.file?.parent?.path ?? '';
          if (!folder || folder === '/') {
            new Notice('Open a note inside the folder you want to sync.');
            return;
          }
          this.plugin.settings.localFolder = folder;
          await this.plugin.saveSettings();
          await this.display();
          new Notice(`Local folder set to ${folder}`);
        }),
      );

    new Setting(containerEl)
      .setName('SiYuan directory')
      .setDesc('Target path inside the notebook. Leave empty to keep vault-relative paths.')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.remoteDir)
          .onChange(async (value) => {
            const v = value.trim();
            this.plugin.settings.remoteDir = v && !v.startsWith('/') ? `/${v}` : v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Target notebook')
      .setDesc(
        'Notebook name or ID. Saved in this Obsidian vault, so each vault can sync to a different notebook. Type it yourself; the list below is optional.',
      )
      .addText((text) => {
        this.notebookText = text;
        text
          .setPlaceholder('obsidian')
          .setValue(this.plugin.settings.notebook || this.plugin.settings.notebookId)
          .onChange(async (value) => {
            this.plugin.settings.notebook = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Fill from server list')
      .setDesc('Optional. Refresh SiYuan and pick a name to copy into the field above.')
      .addDropdown((dd) => {
        this.notebookDropdown = dd;
        dd.addOption('', 'Optional…');
        dd.onChange(async (value) => {
          if (!value) return;
          const nb = this.notebooks.find((n) => n.id === value);
          this.plugin.settings.notebook = nb?.name || value;
          this.plugin.settings.notebookId = value;
          this.notebookText.setValue(this.plugin.settings.notebook);
          await this.plugin.saveSettings();
        });
        void this.refreshNotebooks();
      })
      .addButton((btn) =>
        btn.setButtonText('Refresh').onClick(async () => {
          await this.refreshNotebooks();
          new Notice('Notebook list refreshed.');
        }),
      );

    new Setting(containerEl)
      .setName('Create missing notebook')
      .setDesc('Create the notebook you typed above if it does not exist yet.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.createMissingNotebook).onChange(async (value) => {
          this.plugin.settings.createMissingNotebook = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Remove missing notes')
      .setDesc(
        'During full sync, remove SiYuan docs whose source note was deleted. Only affects this notebook; use with care.',
      )
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
      this.notebookDropdown.addOption('', this.notebooks.length === 0 ? 'No notebooks' : 'Optional…');
      this.notebooks.forEach((nb) => {
        this.notebookDropdown.addOption(nb.id, nb.closed ? `${nb.name} (closed)` : nb.name);
      });
      const current = this.plugin.settings.notebook.trim() || this.plugin.settings.notebookId;
      const match = this.notebooks.find((n) => n.id === current || n.name === current);
      this.notebookDropdown.setValue(match ? match.id : '');
    } catch (e) {
      this.notebookDropdown.selectEl.empty();
      this.notebookDropdown.addOption('', `Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
