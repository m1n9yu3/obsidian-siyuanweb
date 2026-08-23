import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Notebook } from '../src/siyuan-api';
import {
  childBlockIds,
  dropSyncStateKeys,
  isRemovableRemoteDoc,
  planNoteSync,
  recordOf,
  remapSyncStateKeys,
  resolveNotebook,
  shouldSkipUnchanged,
} from '../src/sync-logic';

function nb(partial: Partial<Notebook> & Pick<Notebook, 'id' | 'name'>): Notebook {
  return {
    icon: '',
    sort: 0,
    sortMode: 0,
    closed: false,
    ...partial,
  };
}

describe('resolveNotebook', () => {
  const notebooks = [nb({ id: 'aaa', name: 'Work' }), nb({ id: 'bbb', name: 'obsidian' })];

  it('uses the selected notebook by id', () => {
    const choice = resolveNotebook(notebooks, 'aaa', false);
    assert.equal(choice.type, 'use');
    if (choice.type === 'use') assert.equal(choice.notebook.name, 'Work');
  });

  it('uses a typed notebook name so each vault can target a different notebook', () => {
    const choice = resolveNotebook(notebooks, 'Work', false);
    assert.equal(choice.type, 'use');
    if (choice.type === 'use') assert.equal(choice.notebook.id, 'aaa');
  });

  it('errors when the selected id is gone instead of silently switching to obsidian', () => {
    const choice = resolveNotebook(notebooks, '20200101000000-deleted', true);
    assert.equal(choice.type, 'error');
    if (choice.type === 'error') assert.match(choice.message, /not found/i);
  });

  it('creates the typed name when create-missing is on', () => {
    const choice = resolveNotebook(notebooks, 'kerui-notes', true);
    assert.equal(choice.type, 'create');
    if (choice.type === 'create') assert.equal(choice.name, 'kerui-notes');
  });

  it('falls back to a notebook named obsidian only when nothing is selected', () => {
    const choice = resolveNotebook(notebooks, '', false);
    assert.equal(choice.type, 'use');
    if (choice.type === 'use') assert.equal(choice.notebook.id, 'bbb');
  });

  it('creates only when unselected, no obsidian notebook, and the flag is on', () => {
    const choice = resolveNotebook([nb({ id: 'aaa', name: 'Work' })], '', true);
    assert.equal(choice.type, 'create');
    if (choice.type === 'create') assert.equal(choice.name, 'obsidian');
    assert.equal(resolveNotebook([nb({ id: 'aaa', name: 'Work' })], '', false).type, 'error');
  });

  it('still returns a closed notebook so the caller can open it', () => {
    const choice = resolveNotebook([nb({ id: 'c', name: 'Work', closed: true })], 'c', false);
    assert.equal(choice.type, 'use');
    if (choice.type === 'use') assert.equal(choice.notebook.closed, true);
  });
});

describe('shouldSkipUnchanged / planNoteSync', () => {
  it('skips only when fingerprint matches and the remote doc exists', () => {
    assert.equal(shouldSkipUnchanged('a', 'a', true), true);
    assert.equal(shouldSkipUnchanged('a', 'a', false), false);
    assert.equal(shouldSkipUnchanged('a', 'b', true), false);
    assert.equal(shouldSkipUnchanged(undefined, 'a', true), false);
  });

  it('plans update vs create', () => {
    assert.equal(planNoteSync({ currentFingerprint: 'x', remoteExists: true }), 'update');
    assert.equal(planNoteSync({ currentFingerprint: 'x', remoteExists: false }), 'create');
    assert.equal(
      planNoteSync({ storedFingerprint: 'x', currentFingerprint: 'x', remoteExists: true }),
      'skip',
    );
  });

  it('retries when the previous sync failed to download images', () => {
    assert.equal(
      planNoteSync({
        storedFingerprint: 'x',
        currentFingerprint: 'x',
        remoteExists: true,
        imageFailures: 2,
      }),
      'update',
    );
  });
});

describe('isRemovableRemoteDoc', () => {
  const claimed = new Set(['/folder/plan', '/folder', '/root']);

  it('removes an unclaimed leaf even if the web title still has .md', () => {
    assert.equal(isRemovableRemoteDoc('/folder/gone.md', 0, claimed), true);
  });

  it('keeps local notes and their parent folders', () => {
    assert.equal(isRemovableRemoteDoc('/folder/plan', 0, claimed), false);
    assert.equal(isRemovableRemoteDoc('/folder', 0, claimed), false);
    assert.equal(isRemovableRemoteDoc('/folder', 2, claimed), false);
    assert.equal(isRemovableRemoteDoc('/', 0, claimed), false);
  });

  it('treats leftover empty docs as removable', () => {
    assert.equal(isRemovableRemoteDoc('/old-note', 0, claimed), true);
  });

  it('does not remove docs outside the configured SiYuan directory', () => {
    assert.equal(isRemovableRemoteDoc('/x/ab', 0, claimed, '/folder'), false);
    assert.equal(isRemovableRemoteDoc('/folder/gone', 0, claimed, '/folder'), true);
  });
});

describe('recordOf', () => {
  it('migrates legacy string fingerprints', () => {
    assert.deepEqual(recordOf('abc'), { fp: 'abc' });
    assert.deepEqual(recordOf({ fp: 'x', id: 'id1' }), { fp: 'x', id: 'id1' });
    assert.deepEqual(recordOf({ fp: 'x', id: 'id1', imgFail: 3 }), { fp: 'x', id: 'id1', imgFail: 3 });
    assert.deepEqual(recordOf(undefined), {});
  });
});

describe('remapSyncStateKeys / dropSyncStateKeys', () => {
  it('retargets a note and a whole folder after a vault rename', () => {
    const state = {
      'old/a.md': { fp: '1', id: 'a' },
      'old/sub/b.md': { fp: '2', id: 'b' },
      'other.md': { fp: '3', id: 'c' },
    };
    const renamed = remapSyncStateKeys(state, 'old/a.md', 'old/renamed.md');
    assert.deepEqual(renamed['old/renamed.md'], { fp: '1', id: 'a' });
    assert.equal(renamed['old/a.md'], undefined);
    assert.deepEqual(renamed['other.md'], { fp: '3', id: 'c' });

    const moved = remapSyncStateKeys(state, 'old', 'moved');
    assert.deepEqual(moved['moved/a.md'], { fp: '1', id: 'a' });
    assert.deepEqual(moved['moved/sub/b.md'], { fp: '2', id: 'b' });
    assert.deepEqual(moved['other.md'], { fp: '3', id: 'c' });
    assert.equal(moved['old/a.md'], undefined);
  });

  it('drops a deleted note and everything under a deleted folder', () => {
    const state = {
      'old/a.md': { fp: '1', id: 'a' },
      'old/sub/b.md': { fp: '2', id: 'b' },
      'other.md': { fp: '3', id: 'c' },
    };
    assert.equal(dropSyncStateKeys(state, 'other.md')['other.md'], undefined);
    const dropped = dropSyncStateKeys(state, 'old');
    assert.equal(dropped['old/a.md'], undefined);
    assert.equal(dropped['old/sub/b.md'], undefined);
    assert.deepEqual(dropped['other.md'], { fp: '3', id: 'c' });
  });
});

describe('childBlockIds', () => {
  it('deletes from the end so earlier siblings stay addressable', () => {
    assert.deepEqual(childBlockIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), ['c', 'b', 'a']);
    assert.deepEqual(childBlockIds(null), []);
    assert.deepEqual(childBlockIds(undefined), []);
  });
});
