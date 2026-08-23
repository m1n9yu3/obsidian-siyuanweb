import {
  ancestorHPaths,
  hPathLookupVariants,
  hPathTitle,
  normalizeHPath,
  parentHPath,
  rawLeafName,
  toHPath,
} from './paths';
import { RemoteDoc, RemoteTree } from './remote-tree';

export interface UpsertApi {
  createDocWithMd(
    notebookId: string,
    path: string,
    markdown: string,
    opts?: { parentID?: string },
  ): Promise<string>;
  updateDocMarkdown(id: string, markdown: string): Promise<void>;
  renameDocByID(id: string, title: string): Promise<void>;
  moveDocsByID(fromIDs: string[], toID: string): Promise<void>;
  removeDocByID(id: string): Promise<void>;
  getIDsByHPath?(notebookId: string, hPath: string): Promise<string[]>;
  getPathByID?(id: string): Promise<string>;
  listDocsByPath?(notebookId: string, path: string): Promise<Array<{ id: string; path: string }>>;
}

export interface WriteNoteResult {
  id: string;
  created: boolean;
  moved: boolean;
  collapsed: number;
}

function storagePathFor(id: string, parentID?: string): string {
  return parentID ? `/${parentID}/${id}.sy` : `/${id}.sy`;
}

async function moveChildIds(
  api: UpsertApi,
  tree: RemoteTree,
  childIds: string[],
  keepId: string,
): Promise<void> {
  const ids = childIds.filter((id) => id && id !== keepId);
  for (let i = 0; i < ids.length; i += 32) {
    const batch = ids.slice(i, i + 32);
    await api.moveDocsByID(batch, keepId);
    for (const id of batch) tree.relocateUnder(id, keepId);
  }
}

/** Move extra's children onto keep, then delete extra only if it is empty on the kernel. */
export async function collapseDuplicates(
  api: UpsertApi,
  notebookId: string,
  tree: RemoteTree,
  hPath: string,
  keepId: string,
): Promise<number> {
  const extras = tree.extras(hPath, keepId);
  let collapsed = 0;
  for (const extra of extras) {
    try {
      await moveChildIds(
        api,
        tree,
        tree.directChildren(extra.id).map((k) => k.id),
        keepId,
      );
      if (api.listDocsByPath) {
        const live = await api.listDocsByPath(notebookId, extra.path);
        await moveChildIds(
          api,
          tree,
          live.map((f) => f.id).filter((id) => id !== extra.id && id !== keepId),
          keepId,
        );
        const leftover = await api.listDocsByPath(notebookId, extra.path);
        if (leftover.length > 0) continue;
      }
      if (tree.childCount(extra.id) > 0) continue;
      await api.removeDocByID(extra.id);
      tree.remove(extra.id);
      collapsed++;
    } catch (error) {
      console.error('SiYuan: failed to collapse duplicate', extra.hpath, extra.id, error);
    }
  }
  return collapsed;
}

export async function collapseAllDuplicates(
  api: UpsertApi,
  notebookId: string,
  tree: RemoteTree,
  syncRoot = '/',
): Promise<number> {
  const root = normalizeHPath(syncRoot);
  const keys = [
    ...new Set(tree.all().map((d) => normalizeHPath(d.hpath))),
  ]
    .filter((k) => {
      if (k === '/') return false;
      if (root === '/') return true;
      return k === root || k.startsWith(`${root}/`);
    })
    .sort((a, b) => a.split('/').length - b.split('/').length);
  let collapsed = 0;
  for (const key of keys) {
    const keep = tree.findOne(key);
    if (!keep) continue;
    collapsed += await collapseDuplicates(api, notebookId, tree, key, keep.id);
  }
  return collapsed;
}

/** Merge duplicates of this note and every parent folder. */
export async function collapseLineage(
  api: UpsertApi,
  notebookId: string,
  tree: RemoteTree,
  hPath: string,
): Promise<number> {
  let collapsed = 0;
  const keep = tree.findOne(hPath);
  if (keep) collapsed += await collapseDuplicates(api, notebookId, tree, hPath, keep.id);
  for (const ancestor of ancestorHPaths(hPath)) {
    const folder = tree.findOne(ancestor);
    if (folder) collapsed += await collapseDuplicates(api, notebookId, tree, ancestor, folder.id);
  }
  return collapsed;
}

async function hydrateFromKernel(
  api: UpsertApi,
  notebookId: string,
  hPath: string,
  tree: RemoteTree,
): Promise<void> {
  if (!api.getIDsByHPath) return;
  const seen = new Set<string>();
  for (const variant of hPathLookupVariants(hPath)) {
    let ids: string[] = [];
    try {
      ids = await api.getIDsByHPath(notebookId, variant);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (seen.has(id) || tree.findById(id)) continue;
      seen.add(id);
      let storage = `/${id}.sy`;
      if (api.getPathByID) {
        try {
          storage = await api.getPathByID(id);
        } catch {
          /* keep fallback */
        }
      }
      tree.add({ id, hpath: hPath, path: storage });
    }
  }
}

export async function ensureFolder(
  api: UpsertApi,
  notebookId: string,
  hPath: string,
  tree: RemoteTree,
): Promise<string> {
  await hydrateFromKernel(api, notebookId, hPath, tree);
  const existing = tree.findAll(hPath);
  if (existing.length > 0) {
    const keep = tree.findOne(hPath)!;
    await collapseDuplicates(api, notebookId, tree, hPath, keep.id);
    const title = hPathTitle(hPath);
    if (rawLeafName(keep.hpath) !== title) {
      await api.renameDocByID(keep.id, title);
      tree.updateHPath(keep.id, hPath);
    }
    return keep.id;
  }

  const parent = parentHPath(hPath);
  const parentID = parent ? await ensureFolder(api, notebookId, parent, tree) : undefined;
  const id = await api.createDocWithMd(notebookId, hPath, '', parentID ? { parentID } : undefined);
  tree.add({ id, hpath: hPath, path: storagePathFor(id, parentID) });
  await hydrateFromKernel(api, notebookId, hPath, tree);
  const keep = tree.findOne(hPath) ?? tree.findById(id);
  if (!keep) return id;
  await collapseDuplicates(api, notebookId, tree, hPath, keep.id);
  return keep.id;
}

function needsRelocate(doc: RemoteDoc, canonical: string): { move: boolean; rename: boolean } {
  const current = normalizeHPath(doc.hpath);
  const currentParent = parentHPath(current);
  const wantParent = parentHPath(canonical);
  return {
    move: currentParent !== wantParent,
    rename: rawLeafName(doc.hpath) !== hPathTitle(canonical),
  };
}

export function noteNeedsRelocate(doc: RemoteDoc, canonical: string): boolean {
  const r = needsRelocate(doc, canonical);
  return r.move || r.rename;
}

export async function writeNote(opts: {
  api: UpsertApi;
  notebookId: string;
  localPath: string;
  markdown: string;
  storedId?: string;
  tree: RemoteTree;
  hPath?: string;
}): Promise<WriteNoteResult> {
  const canonical = opts.hPath ? normalizeHPath(opts.hPath) : toHPath(opts.localPath);
  await hydrateFromKernel(opts.api, opts.notebookId, canonical, opts.tree);
  const parent = parentHPath(canonical);
  const parentID = parent ? await ensureFolder(opts.api, opts.notebookId, parent, opts.tree) : undefined;

  const existing =
    (opts.storedId ? opts.tree.findById(opts.storedId) : undefined) ??
    opts.tree.findOne(canonical) ??
    opts.tree.resolve(opts.localPath, opts.storedId);
  if (existing) {
    const relocate = needsRelocate(existing, canonical);
    if (relocate.move) {
      await opts.api.moveDocsByID([existing.id], parentID ?? opts.notebookId);
      opts.tree.relocateUnder(existing.id, parentID);
    }
    if (relocate.rename) {
      await opts.api.renameDocByID(existing.id, hPathTitle(canonical));
    }
    if (relocate.move || relocate.rename) {
      opts.tree.updateHPath(existing.id, canonical);
    }
    try {
      await opts.api.updateDocMarkdown(existing.id, opts.markdown);
    } catch {
      await opts.api.removeDocByID(existing.id);
      opts.tree.remove(existing.id);
      return finishCreatedNote(opts.api, opts.notebookId, canonical, opts.markdown, parentID, opts.tree, relocate.move);
    }
    const collapsed = await collapseDuplicates(
      opts.api,
      opts.notebookId,
      opts.tree,
      canonical,
      existing.id,
    );
    return { id: existing.id, created: false, moved: relocate.move, collapsed };
  }

  return finishCreatedNote(opts.api, opts.notebookId, canonical, opts.markdown, parentID, opts.tree, false);
}

async function finishCreatedNote(
  api: UpsertApi,
  notebookId: string,
  canonical: string,
  markdown: string,
  parentID: string | undefined,
  tree: RemoteTree,
  moved: boolean,
): Promise<WriteNoteResult> {
  const id = await api.createDocWithMd(
    notebookId,
    canonical,
    markdown,
    parentID ? { parentID } : undefined,
  );
  tree.add({ id, hpath: canonical, path: storagePathFor(id, parentID) });
  await hydrateFromKernel(api, notebookId, canonical, tree);
  const keep = tree.findOne(canonical) ?? tree.findById(id);
  const keepId = keep?.id ?? id;
  if (keepId !== id) {
    try {
      await api.updateDocMarkdown(keepId, markdown);
    } catch {
      /* keep the newly created doc if the older one cannot take the body */
      const collapsed = await collapseDuplicates(api, notebookId, tree, canonical, id);
      return { id, created: true, moved, collapsed };
    }
  }
  const collapsed = await collapseDuplicates(api, notebookId, tree, canonical, keepId);
  return { id: keepId, created: keepId === id, moved, collapsed };
}
