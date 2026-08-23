import type { Notebook } from './siyuan-api';
import { normalizeHPath } from './paths';

export type NotebookChoice =
  | { type: 'use'; notebook: Notebook }
  | { type: 'create'; name: string }
  | { type: 'error'; message: string };

const MISSING_NOTEBOOK =
  'Target notebook not found. Type a notebook name in settings, or enable create-missing.';

export function looksLikeNotebookId(value: string): boolean {
  return /^\d{14}-[a-z0-9]+$/i.test(value.trim());
}

/** Resolve by typed name or ID. Each Obsidian vault stores its own target. */
export function resolveNotebook(
  notebooks: Notebook[],
  target: string,
  createMissing: boolean,
): NotebookChoice {
  const t = target.trim();
  if (t) {
    const byId = notebooks.find((n) => n.id === t);
    if (byId) return { type: 'use', notebook: byId };
    const byName = notebooks.find((n) => n.name === t);
    if (byName) return { type: 'use', notebook: byName };
    if (createMissing && !looksLikeNotebookId(t)) return { type: 'create', name: t };
    return {
      type: 'error',
      message: `Target notebook "${t}" not found. Check the name, or enable create-missing.`,
    };
  }
  const named = notebooks.find((n) => n.name === 'obsidian');
  if (named) return { type: 'use', notebook: named };
  if (!createMissing) return { type: 'error', message: MISSING_NOTEBOOK };
  return { type: 'create', name: 'obsidian' };
}

export function shouldSkipUnchanged(
  storedFingerprint: string | undefined,
  currentFingerprint: string,
  remoteExists: boolean,
): boolean {
  return Boolean(storedFingerprint) && storedFingerprint === currentFingerprint && remoteExists;
}

export type NoteSyncAction = 'skip' | 'create' | 'update';

export function planNoteSync(opts: {
  storedFingerprint?: string;
  currentFingerprint: string;
  remoteExists: boolean;
  imageFailures?: number;
}): NoteSyncAction {
  if ((opts.imageFailures ?? 0) > 0) {
    return opts.remoteExists ? 'update' : 'create';
  }
  if (shouldSkipUnchanged(opts.storedFingerprint, opts.currentFingerprint, opts.remoteExists)) {
    return 'skip';
  }
  return opts.remoteExists ? 'update' : 'create';
}

export interface NoteSyncRecord {
  fp: string;
  id: string;
  imgFail?: number;
}

export function recordOf(
  value: NoteSyncRecord | string | undefined,
): { fp?: string; id?: string; imgFail?: number } {
  if (!value) return {};
  if (typeof value === 'string') return { fp: value };
  const out: { fp?: string; id?: string; imgFail?: number } = { fp: value.fp, id: value.id };
  if (value.imgFail) out.imgFail = value.imgFail;
  return out;
}

export function remapSyncStateKeys<T>(
  state: Record<string, T>,
  oldPath: string,
  newPath: string,
): Record<string, T> {
  if (oldPath === newPath) return state;
  const next: Record<string, T> = {};
  let changed = false;
  for (const [key, val] of Object.entries(state)) {
    if (key === oldPath || key.startsWith(`${oldPath}/`)) {
      next[`${newPath}${key.slice(oldPath.length)}`] = val;
      changed = true;
    } else {
      next[key] = val;
    }
  }
  return changed ? next : state;
}

export function dropSyncStateKeys<T>(state: Record<string, T>, path: string): Record<string, T> {
  const next: Record<string, T> = {};
  let changed = false;
  for (const [key, val] of Object.entries(state)) {
    if (key === path || key.startsWith(`${path}/`)) {
      changed = true;
      continue;
    }
    next[key] = val;
  }
  return changed ? next : state;
}

/**
 * Unclaimed leaf-or-empty docs. `claimed` is canonical hPaths of local notes and their parent folders.
 */
export function isRemovableRemoteDoc(
  hPath: string,
  childCount: number,
  claimed: Set<string>,
  syncRoot = '/',
): boolean {
  if (childCount > 0) return false;
  const n = normalizeHPath(hPath);
  if (!n || n === '/') return false;
  const root = normalizeHPath(syncRoot);
  if (root !== '/' && n !== root && !n.startsWith(`${root}/`)) return false;
  return !claimed.has(n);
}

export function childBlockIds(children: Array<{ id: string }> | null | undefined): string[] {
  return [...(children ?? [])].map((c) => c.id).reverse();
}
