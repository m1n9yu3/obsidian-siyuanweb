import { hPathCandidates, normalizeHPath, pickOldestId } from './paths';

export interface RemoteDoc {
  id: string;
  hpath: string;
  path: string;
}

export class RemoteTree {
  private byId = new Map<string, RemoteDoc>();
  private byHPath = new Map<string, string[]>();

  static fromRows(rows: Array<{ id?: string; hpath?: string; path?: string }>): RemoteTree {
    const tree = new RemoteTree();
    for (const row of rows) {
      if (!row.id) continue;
      tree.add({
        id: row.id,
        hpath: row.hpath || '/',
        path: row.path || `/${row.id}.sy`,
      });
    }
    return tree;
  }

  add(doc: RemoteDoc): void {
    const prev = this.byId.get(doc.id);
    if (prev) this.unindex(prev);
    const stored: RemoteDoc = {
      id: doc.id,
      hpath: doc.hpath || '/',
      path: doc.path,
    };
    this.byId.set(stored.id, stored);
    this.index(stored);
  }

  remove(id: string): void {
    const doc = this.byId.get(id);
    if (!doc) return;
    this.unindex(doc);
    this.byId.delete(id);
  }

  updateHPath(id: string, hpath: string): void {
    const doc = this.byId.get(id);
    if (!doc) return;
    this.unindex(doc);
    doc.hpath = hpath;
    this.index(doc);
  }

  setStoragePath(id: string, path: string): void {
    const doc = this.byId.get(id);
    if (doc) doc.path = path;
  }

  /** After a SiYuan move, rewrite this doc and every descendant storage path. */
  relocateUnder(id: string, newParentId: string | undefined): void {
    const doc = this.byId.get(id);
    if (!doc) return;
    const oldPath = doc.path;
    const newPath = newParentId ? `/${newParentId}/${id}.sy` : `/${id}.sy`;
    if (oldPath === newPath) return;
    const oldPrefix = oldPath.replace(/\.sy$/i, '/');
    const newPrefix = newPath.replace(/\.sy$/i, '/');
    this.setStoragePath(id, newPath);
    for (const child of this.all()) {
      if (child.id === id) continue;
      if (child.path.startsWith(oldPrefix)) {
        this.setStoragePath(child.id, newPrefix + child.path.slice(oldPrefix.length));
      }
    }
  }

  findById(id: string): RemoteDoc | undefined {
    return this.byId.get(id);
  }

  findAll(hPath: string): RemoteDoc[] {
    const ids = this.byHPath.get(normalizeHPath(hPath)) ?? [];
    return ids.map((id) => this.byId.get(id)).filter((d): d is RemoteDoc => Boolean(d));
  }

  findOne(hPath: string): RemoteDoc | undefined {
    const all = this.findAll(hPath);
    if (all.length === 0) return undefined;
    const id = pickOldestId(all.map((d) => d.id));
    return all.find((d) => d.id === id);
  }

  /** Resolve a local vault file to an existing SiYuan doc (id first, then hPath / legacy .md). */
  resolve(localPath: string, storedId?: string): RemoteDoc | undefined {
    if (storedId) {
      const byId = this.findById(storedId);
      if (byId) return byId;
    }
    for (const hp of hPathCandidates(localPath)) {
      const hit = this.findOne(hp);
      if (hit) return hit;
    }
    return undefined;
  }

  extras(hPath: string, keepId: string): RemoteDoc[] {
    return this.findAll(hPath).filter((d) => d.id !== keepId);
  }

  all(): RemoteDoc[] {
    return [...this.byId.values()];
  }

  directChildren(parentId: string): RemoteDoc[] {
    const parent = this.byId.get(parentId);
    const prefix = parent ? parent.path.replace(/\.sy$/i, '/') : `/${parentId}/`;
    return this.all().filter((d) => {
      if (d.id === parentId) return false;
      if (!d.path.startsWith(prefix)) return false;
      const rest = d.path.slice(prefix.length);
      return rest.length > 0 && !rest.includes('/');
    });
  }

  childCount(parentId: string): number {
    return this.all().filter((d) => d.id !== parentId && d.path.includes(`/${parentId}/`)).length;
  }

  private index(doc: RemoteDoc): void {
    const key = normalizeHPath(doc.hpath);
    const list = this.byHPath.get(key) ?? [];
    if (!list.includes(doc.id)) list.push(doc.id);
    this.byHPath.set(key, list);
  }

  private unindex(doc: RemoteDoc): void {
    const key = normalizeHPath(doc.hpath);
    const list = this.byHPath.get(key);
    if (!list) return;
    const next = list.filter((id) => id !== doc.id);
    if (next.length === 0) this.byHPath.delete(key);
    else this.byHPath.set(key, next);
  }
}
