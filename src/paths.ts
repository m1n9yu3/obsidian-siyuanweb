/** Map Obsidian vault files onto SiYuan hPaths.
 *
 * Local:  folder/note.md          (filesystem file)
 * SiYuan: /folder/note            (folder is a document; title has no .md)
 *
 * createDocWithMd uses hPath and always creates a NEW leaf if we do not
 * look it up first — that is what produced duplicate folders.
 */

/** SiYuan SQL often stores & as &amp; in hpath. Decode so vault `CTF && 靶场` matches. */
export function decodeHPathEntities(input: string): string {
  let prev = '';
  let cur = input;
  for (let i = 0; i < 3 && cur !== prev; i++) {
    prev = cur;
    cur = cur
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'");
  }
  return cur;
}

export function escapeHPathAmp(hPath: string): string {
  return hPath.replace(/&/g, '&amp;');
}

/** Both the decoded path and the SQL-escaped form, for getIDsByHPath. */
export function hPathLookupVariants(hPath: string): string[] {
  const n = normalizeHPath(hPath);
  return [...new Set([n, escapeHPathAmp(n), hPath])];
}

/** Trim each path segment. SiYuan's TrimSpaceInPath does the same, so
 * a local folder named " 数据结构" becomes the web doc 数据结构. */
export function trimPathSegments(input: string): string {
  const parts = decodeHPathEntities(input)
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length ? `/${parts.join('/')}` : '/';
}

export function toHPath(obsidianPath: string): string {
  const trimmed = trimPathSegments(obsidianPath);
  const withoutMd = trimmed.replace(/\.md$/i, '');
  return withoutMd || '/';
}

export function normalizeHPath(hPath: string): string {
  return toHPath(hPath.replace(/^\/+/, ''));
}

export function hPathTitle(hPath: string): string {
  const parts = normalizeHPath(hPath).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Last path segment as SiYuan currently stores it (may still end with .md). */
export function rawLeafName(hPath: string): string {
  const parts = decodeHPathEntities(hPath)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export function parentHPath(hPath: string): string | null {
  const n = normalizeHPath(hPath);
  if (n === '/') return null;
  const i = n.lastIndexOf('/');
  if (i <= 0) return null;
  return n.slice(0, i);
}

/** Parent folder docs that must exist before a leaf, e.g. /a/b/c → [/a, /a/b]. */
export function ancestorHPaths(hPath: string): string[] {
  const n = normalizeHPath(hPath);
  const parts = n.split('/').filter(Boolean);
  const out: string[] = [];
  let acc = '';
  for (let i = 0; i < parts.length - 1; i++) {
    acc += `/${parts[i]}`;
    out.push(acc);
  }
  return out;
}

/** Canonical hPath plus the legacy `.md` title used by earlier plugin versions. */
export function hPathCandidates(obsidianPath: string): string[] {
  const canonical = toHPath(obsidianPath);
  const raw = `/${obsidianPath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const set = new Set<string>([canonical]);
  if (!canonical.endsWith('.md')) set.add(`${canonical}.md`);
  set.add(raw);
  set.add(normalizeHPath(raw));
  // Untrimmed segment form, e.g. /科锐逆向笔记/ 数据结构
  const untrimmedMd = raw.replace(/\.md$/i, '');
  if (untrimmedMd !== canonical) set.add(untrimmedMd);
  return [...set];
}

export function claimedHPaths(obsidianPaths: Iterable<string>): Set<string> {
  const claimed = new Set<string>();
  for (const p of obsidianPaths) {
    const hp = toHPath(p.startsWith('/') ? p.slice(1) : p);
    claimed.add(hp);
    for (const a of ancestorHPaths(hp)) claimed.add(a);
  }
  return claimed;
}

export function isUnderLocalFolder(vaultPath: string, localFolder: string): boolean {
  const folder = localFolder.trim() ? toHPath(localFolder) : '/';
  if (folder === '/') return true;
  const file = toHPath(vaultPath);
  return file === folder || file.startsWith(`${folder}/`);
}

/** Where this vault file should live in SiYuan. */
export function mapVaultPathToHPath(
  vaultPath: string,
  localFolder: string,
  remoteDir: string,
): string {
  const fileHp = toHPath(vaultPath);
  const localHp = localFolder.trim() ? toHPath(localFolder) : '/';
  const remoteHp = remoteDir.trim() ? toHPath(remoteDir) : '/';
  if (remoteHp === '/') return fileHp;
  let rel = fileHp;
  if (localHp !== '/' && (fileHp === localHp || fileHp.startsWith(`${localHp}/`))) {
    rel = fileHp === localHp ? '/' : fileHp.slice(localHp.length);
  }
  if (rel === '/') return remoteHp;
  return `${remoteHp}${rel}`;
}

/** Remote subtree this sync owns. Empty folder settings → whole notebook. */
export function syncRootHPath(localFolder: string, remoteDir: string): string {
  if (remoteDir.trim()) return toHPath(remoteDir);
  if (localFolder.trim()) return toHPath(localFolder);
  return '/';
}

export function pickOldestId(ids: string[]): string {
  return [...ids].sort()[0];
}
