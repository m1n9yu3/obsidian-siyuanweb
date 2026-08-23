import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RemoteTree } from '../src/remote-tree';
import {
  collapseAllDuplicates,
  collapseDuplicates,
  ensureFolder,
  noteNeedsRelocate,
  UpsertApi,
  writeNote,
} from '../src/upsert';

class FakeApi implements UpsertApi {
  creates: Array<{ path: string; markdown: string; parentID?: string }> = [];
  updates: string[] = [];
  moves: Array<{ from: string[]; to: string }> = [];
  removes: string[] = [];
  renames: Array<{ id: string; title: string }> = [];
  failUpdate = false;
  liveIds = new Map<string, string[]>();
  livePaths = new Map<string, string>();
  hiddenUntilCreate = new Map<string, string[]>();
  listAt = new Map<string, Array<{ id: string; path: string }>>();
  private n = 0;

  async createDocWithMd(
    _notebookId: string,
    path: string,
    markdown: string,
    opts?: { parentID?: string },
  ): Promise<string> {
    this.n += 1;
    const id = `${String(20200101000000 + this.n).padStart(14, '0')}-aaaaaaa`;
    this.creates.push({ path, markdown, parentID: opts?.parentID });
    const hidden = this.hiddenUntilCreate.get(path) ?? [];
    if (hidden.length > 0) {
      this.liveIds.set(path, [...new Set([...hidden, ...(this.liveIds.get(path) ?? []), id])]);
    }
    return id;
  }

  async updateDocMarkdown(id: string): Promise<void> {
    if (this.failUpdate) throw new Error('update failed');
    this.updates.push(id);
  }

  async renameDocByID(id: string, title: string): Promise<void> {
    this.renames.push({ id, title });
  }

  async moveDocsByID(fromIDs: string[], toID: string): Promise<void> {
    this.moves.push({ from: fromIDs, to: toID });
  }

  async removeDocByID(id: string): Promise<void> {
    this.removes.push(id);
  }

  async getIDsByHPath(_notebookId: string, hPath: string): Promise<string[]> {
    return this.liveIds.get(hPath) ?? [];
  }

  async getPathByID(id: string): Promise<string> {
    return this.livePaths.get(id) ?? `/${id}.sy`;
  }

  async listDocsByPath(_notebookId: string, path: string): Promise<Array<{ id: string; path: string }>> {
    return this.listAt.get(path) ?? [];
  }
}

const NB = '20200101000000-notebook';

describe('ensureFolder / writeNote vs duplicate directories', () => {
  it('reuses the same parent folder when two notes share a local directory', async () => {
    const api = new FakeApi();
    const tree = new RemoteTree();
    const a = await writeNote({
      api,
      notebookId: NB,
      localPath: 'projects/alpha/plan.md',
      markdown: '# plan',
      tree,
    });
    const b = await writeNote({
      api,
      notebookId: NB,
      localPath: 'projects/alpha/readme.md',
      markdown: '# readme',
      tree,
    });

    const folderCreates = api.creates.filter((c) => c.markdown === '');
    const noteCreates = api.creates.filter((c) => c.markdown !== '');
    const alphaId = tree.findOne('/projects/alpha')?.id;
    assert.equal(folderCreates.filter((c) => c.path === '/projects').length, 1);
    assert.equal(folderCreates.filter((c) => c.path === '/projects/alpha').length, 1);
    assert.equal(noteCreates.length, 2);
    assert.equal(noteCreates[0].parentID, alphaId);
    assert.equal(noteCreates[1].parentID, alphaId);
    assert.equal(a.created, true);
    assert.equal(b.created, true);
    assert.equal(tree.findAll('/projects').length, 1);
    assert.equal(tree.findAll('/projects/alpha').length, 1);
  });

  it('updates an existing note instead of createDocWithMd (which would duplicate)', async () => {
    const api = new FakeApi();
    const tree = RemoteTree.fromRows([
      { id: '20200101000001-aaaaaaa', hpath: '/projects', path: '/20200101000001-aaaaaaa.sy' },
      {
        id: '20200101000002-aaaaaaa',
        hpath: '/projects/plan',
        path: '/20200101000001-aaaaaaa/20200101000002-aaaaaaa.sy',
      },
    ]);
    const result = await writeNote({
      api,
      notebookId: NB,
      localPath: 'projects/plan.md',
      markdown: '# new',
      storedId: '20200101000002-aaaaaaa',
      tree,
    });
    assert.equal(result.created, false);
    assert.deepEqual(api.updates, ['20200101000002-aaaaaaa']);
    assert.equal(api.creates.length, 0);
  });

  it('renames legacy /plan.md titles to /plan instead of creating a sibling', async () => {
    const api = new FakeApi();
    const tree = RemoteTree.fromRows([
      { id: '20200101000001-aaaaaaa', hpath: '/inbox.md', path: '/20200101000001-aaaaaaa.sy' },
    ]);
    const result = await writeNote({
      api,
      notebookId: NB,
      localPath: 'inbox.md',
      markdown: 'hi',
      tree,
    });
    assert.equal(result.created, false);
    assert.deepEqual(api.renames, [{ id: '20200101000001-aaaaaaa', title: 'inbox' }]);
    assert.equal(api.creates.length, 0);
    assert.equal(tree.findById('20200101000001-aaaaaaa')?.hpath, '/inbox');
  });

  it('merges duplicate folder docs and moves their children onto the oldest one', async () => {
    const api = new FakeApi();
    const older = '20200101000001-aaaaaaa';
    const newer = '20200101000002-bbbbbbb';
    const child = '20200101000003-ccccccc';
    const tree = RemoteTree.fromRows([
      { id: older, hpath: '/projects', path: `/${older}.sy` },
      { id: newer, hpath: '/projects', path: `/${newer}.sy` },
      { id: child, hpath: '/projects/plan', path: `/${newer}/${child}.sy` },
    ]);
    const merged = await collapseAllDuplicates(api, NB, tree);
    assert.equal(merged, 1);
    assert.deepEqual(api.moves, [{ from: [child], to: older }]);
    assert.deepEqual(api.removes, [newer]);
    assert.equal(tree.findAll('/projects').length, 1);
    assert.equal(tree.findById(child)?.path, `/${older}/${child}.sy`);
    assert.equal(tree.findById(newer), undefined);
  });

  it('merges buu刷题 folders whether SQL stored && or &amp;&amp;', async () => {
    const api = new FakeApi();
    const older = '20200101000001-aaaaaaa';
    const newer = '20200101000002-bbbbbbb';
    const child = '20200101000003-ccccccc';
    const tree = RemoteTree.fromRows([
      {
        id: older,
        hpath: '/youdao-note/网络安全/CTF &amp;&amp; 靶场/CTF 刷题/buu刷题',
        path: `/${older}.sy`,
      },
      {
        id: newer,
        hpath: '/youdao-note/网络安全/CTF && 靶场/CTF 刷题/buu刷题',
        path: `/${newer}.sy`,
      },
      {
        id: child,
        hpath: '/youdao-note/网络安全/CTF && 靶场/CTF 刷题/buu刷题/pwn',
        path: `/${newer}/${child}.sy`,
      },
    ]);
    const id = await ensureFolder(
      api,
      NB,
      '/youdao-note/网络安全/CTF && 靶场/CTF 刷题/buu刷题',
      tree,
    );
    assert.equal(id, older);
    assert.equal(api.creates.length, 0);
    assert.deepEqual(api.removes, [newer]);
    assert.equal(tree.findAll('/youdao-note/网络安全/CTF && 靶场/CTF 刷题/buu刷题').length, 1);
    assert.equal(tree.findAll('/youdao-note/网络安全/CTF &amp;&amp; 靶场/CTF 刷题/buu刷题').length, 1);
  });

  it('collapses duplicate 数据结构 folders reported by getIDsByHPath even if the SQL tree missed them', async () => {
    const api = new FakeApi();
    const keep = '20260822161014-vrw9hpa';
    const extra = '20260823030423-nsv7duv';
    api.liveIds.set('/科锐逆向笔记/数据结构', [keep, extra]);
    api.livePaths.set(keep, `/20260822140037-zvtvzob/${keep}.sy`);
    api.livePaths.set(extra, `/20260822140037-zvtvzob/${extra}.sy`);
    const tree = new RemoteTree();
    const id = await ensureFolder(api, '20260822135039-pzl85i3', '/科锐逆向笔记/数据结构', tree);
    assert.equal(id, keep);
    assert.equal(api.creates.length, 0);
    assert.deepEqual(api.removes, [extra]);
    assert.equal(tree.findAll('/科锐逆向笔记/数据结构').length, 1);
  });

  it('merges 数据结构 and " 数据结构" into one folder on the web tree', async () => {
    const api = new FakeApi();
    const older = '20200101000001-aaaaaaa';
    const newer = '20200101000002-bbbbbbb';
    const child = '20200101000003-ccccccc';
    const tree = RemoteTree.fromRows([
      { id: older, hpath: '/科锐逆向笔记/数据结构', path: `/${older}.sy` },
      { id: newer, hpath: '/科锐逆向笔记/ 数据结构', path: `/${newer}.sy` },
      { id: child, hpath: '/科锐逆向笔记/ 数据结构/note', path: `/${newer}/${child}.sy` },
    ]);
    const merged = await collapseAllDuplicates(api, NB, tree);
    assert.equal(merged, 1);
    assert.equal(tree.findAll('/科锐逆向笔记/数据结构').length, 1);
    assert.equal(tree.findAll('/科锐逆向笔记/ 数据结构').length, 1);
    assert.deepEqual(api.moves, [{ from: [child], to: older }]);
    assert.deepEqual(api.removes, [newer]);
  });

  it('maps a local folder with a leading space onto the existing trimmed web folder', async () => {
    const api = new FakeApi();
    const folder = '20200101000001-aaaaaaa';
    const sub = '20200101000002-bbbbbbb';
    const tree = RemoteTree.fromRows([
      { id: folder, hpath: '/科锐逆向笔记', path: `/${folder}.sy` },
      { id: sub, hpath: '/科锐逆向笔记/数据结构', path: `/${folder}/${sub}.sy` },
    ]);
    const result = await writeNote({
      api,
      notebookId: NB,
      localPath: '科锐逆向笔记/ 数据结构/_01_ 时间复杂度（算法）.md',
      markdown: '# ds',
      tree,
    });
    assert.equal(result.created, true);
    assert.equal(api.creates.length, 1);
    assert.equal(api.creates[0].path, '/科锐逆向笔记/数据结构/_01_ 时间复杂度（算法）');
    assert.equal(api.creates[0].parentID, sub);
    assert.equal(tree.findAll('/科锐逆向笔记/数据结构').length, 1);
  });

  it('does not create a second /projects when the web tree already has one', async () => {
    const api = new FakeApi();
    const folder = '20200101000001-aaaaaaa';
    const tree = RemoteTree.fromRows([{ id: folder, hpath: '/projects', path: `/${folder}.sy` }]);
    const id = await ensureFolder(api, NB, '/projects', tree);
    assert.equal(id, folder);
    assert.equal(api.creates.length, 0);
  });

  it('rewrites grandchild storage paths when a duplicate folder is collapsed', async () => {
    const older = '20200101000001-aaaaaaa';
    const newer = '20200101000002-bbbbbbb';
    const child = '20200101000003-ccccccc';
    const grand = '20200101000004-ddddddd';
    const tree = RemoteTree.fromRows([
      { id: older, hpath: '/buu刷题', path: `/${older}.sy` },
      { id: newer, hpath: '/buu刷题', path: `/${newer}.sy` },
      { id: child, hpath: '/buu刷题/pwn', path: `/${newer}/${child}.sy` },
      { id: grand, hpath: '/buu刷题/pwn/note', path: `/${newer}/${child}/${grand}.sy` },
    ]);
    tree.relocateUnder(child, older);
    assert.equal(tree.findById(child)?.path, `/${older}/${child}.sy`);
    assert.equal(tree.findById(grand)?.path, `/${older}/${child}/${grand}.sy`);
  });

  it('does not delete a duplicate folder while the kernel still lists children', async () => {
    const api = new FakeApi();
    const older = '20200101000001-aaaaaaa';
    const newer = '20200101000002-bbbbbbb';
    const hidden = '20200101000009-hidden1';
    api.listAt.set(`/${newer}.sy`, [{ id: hidden, path: `/${newer}/${hidden}.sy` }]);
    const tree = RemoteTree.fromRows([
      { id: older, hpath: '/buu刷题', path: `/${older}.sy` },
      { id: newer, hpath: '/buu刷题', path: `/${newer}.sy` },
    ]);
    const collapsed = await collapseDuplicates(api, NB, tree, '/buu刷题', older);
    assert.equal(collapsed, 0);
    assert.equal(tree.findById(newer)?.id, newer);
    assert.equal(api.removes.includes(newer), false);
    assert.deepEqual(api.moves, [{ from: [hidden], to: older }]);
  });

  it('keeps the oldest folder after createDocWithMd accidentally adds another', async () => {
    const api = new FakeApi();
    const older = '20200101000000-oldkeep';
    api.hiddenUntilCreate.set('/inbox', [older]);
    api.livePaths.set(older, `/${older}.sy`);
    const tree = new RemoteTree();
    const id = await ensureFolder(api, NB, '/inbox', tree);
    assert.equal(id, older);
    assert.equal(api.creates.length, 1);
    assert.equal(api.removes.length, 1);
    assert.equal(tree.findAll('/inbox').length, 1);
    assert.equal(tree.findOne('/inbox')?.id, older);
  });

  it('writes content onto the oldest note when create races an existing doc', async () => {
    const api = new FakeApi();
    const older = '20200101000000-oldkeep';
    api.hiddenUntilCreate.set('/inbox', [older]);
    api.livePaths.set(older, `/${older}.sy`);
    const tree = new RemoteTree();
    const result = await writeNote({
      api,
      notebookId: NB,
      localPath: 'inbox.md',
      markdown: '# body',
      tree,
    });
    assert.equal(result.id, older);
    assert.equal(result.created, false);
    assert.deepEqual(api.updates, [older]);
    assert.equal(tree.findAll('/inbox').length, 1);
  });

  it('detects a renamed or moved local note that still needs a SiYuan relocate', () => {
    const doc = {
      id: '20200101000001-aaaaaaa',
      hpath: '/old-folder/note.md',
      path: '/20200101000001-aaaaaaa.sy',
    };
    assert.equal(noteNeedsRelocate(doc, '/old-folder/note'), true);
    assert.equal(
      noteNeedsRelocate({ ...doc, hpath: '/new-folder/note' }, '/old-folder/note'),
      true,
    );
    assert.equal(noteNeedsRelocate({ ...doc, hpath: '/old-folder/note' }, '/old-folder/note'), false);
  });
});
