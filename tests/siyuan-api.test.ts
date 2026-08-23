import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { SiYuanApi, unwrapStoragePath } from '../src/siyuan-api';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('SiYuanApi', () => {
  it('strips trailing slashes from the base URL', async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return jsonResponse({ code: 0, msg: '', data: { notebooks: [] } });
    };
    await new SiYuanApi('http://127.0.0.1:6806///', 'tok').listNotebooks();
    assert.equal(urls[0], 'http://127.0.0.1:6806/api/notebook/lsNotebooks');
  });

  it('listNotebooks returns [] when notebooks is null', async () => {
    globalThis.fetch = async () => jsonResponse({ code: 0, msg: '', data: { notebooks: null } });
    const notebooks = await new SiYuanApi('http://x', 't').listNotebooks();
    assert.deepEqual(notebooks, []);
  });

  it('listDocsByPath returns [] when files is null and requests a high maxListCount', async () => {
    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return jsonResponse({ code: 0, msg: '', data: { files: null } });
    };
    const files = await new SiYuanApi('http://x', 't').listDocsByPath('nb', '/');
    assert.deepEqual(files, []);
    assert.equal(payload?.notebook, 'nb');
    assert.equal(payload?.path, '/');
    assert.equal(payload?.maxListCount, 102400);
    assert.equal(payload?.ignoreMaxListHint, true);
    assert.equal(payload?.showHidden, true);
  });

  it('throws on HTTP errors and non-zero API codes', async () => {
    globalThis.fetch = async () => jsonResponse({}, 500);
    await assert.rejects(() => new SiYuanApi('http://x', 't').listNotebooks(), /HTTP 500/);

    globalThis.fetch = async () => jsonResponse({ code: 1, msg: 'nope', data: null });
    await assert.rejects(() => new SiYuanApi('http://x', 't').listNotebooks(), /nope/);
  });

  it('retries transient fetch failures then succeeds', async () => {
    let n = 0;
    globalThis.fetch = async () => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return jsonResponse({ code: 0, msg: '', data: { notebooks: [] } });
    };
    const notebooks = await new SiYuanApi('http://x', 't').listNotebooks();
    assert.equal(n, 2);
    assert.deepEqual(notebooks, []);
  });

  it('sends Authorization Token on JSON and upload requests', async () => {
    const headers: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const h = init?.headers as Record<string, string>;
      headers.push(h.Authorization || h.authorization);
      return jsonResponse({
        code: 0,
        msg: '',
        data: { errFiles: null, succMap: { 'a.png': 'assets/a.png' } },
      });
    };
    const api = new SiYuanApi('http://x', 'secret');
    await api.openNotebook('nb');
    await api.uploadAsset('a.png', new Uint8Array([1, 2, 3]).buffer, 'image/png');
    assert.deepEqual(headers, ['Token secret', 'Token secret']);
  });

  it('updateDocMarkdown appends the new body before deleting old blocks', async () => {
    const ops: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input).replace('http://x', '');
      const body = JSON.parse(String(init?.body));
      ops.push({ path, body });
      if (path.endsWith('/api/block/getChildBlocks')) {
        return jsonResponse({
          code: 0,
          msg: '',
          data: [
            { id: 'a', type: 'p' },
            { id: 'b', type: 'p' },
          ],
        });
      }
      return jsonResponse({ code: 0, msg: '', data: null });
    };
    await new SiYuanApi('http://x', 't').updateDocMarkdown('doc1', '# hi');
    assert.deepEqual(
      ops.map((o) => o.path),
      ['/api/block/getChildBlocks', '/api/block/appendBlock', '/api/block/deleteBlock', '/api/block/deleteBlock'],
    );
    assert.equal(ops[1].body.parentID, 'doc1');
    assert.equal(ops[1].body.dataType, 'markdown');
    assert.equal(ops[1].body.data, '# hi');
    assert.equal(ops[2].body.id, 'b');
    assert.equal(ops[3].body.id, 'a');
  });

  it('updateDocMarkdown skips append when markdown is empty', async () => {
    const paths: string[] = [];
    globalThis.fetch = async (input) => {
      paths.push(String(input));
      if (String(input).endsWith('/api/block/getChildBlocks')) {
        return jsonResponse({ code: 0, msg: '', data: [] });
      }
      return jsonResponse({ code: 0, msg: '', data: null });
    };
    await new SiYuanApi('http://x', 't').updateDocMarkdown('doc1', '');
    assert.equal(paths.some((p) => p.endsWith('/api/block/appendBlock')), false);
  });

  it('createDocWithMd sends parentID so nested creates pin the existing folder', async () => {
    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return jsonResponse({ code: 0, msg: '', data: '20200101000000-newdoc1' });
    };
    await new SiYuanApi('http://x', 't').createDocWithMd('20200101000000-notebook', '/a/b', '# hi', {
      parentID: '20200101000000-parent1',
    });
    assert.equal(payload?.path, '/a/b');
    assert.equal(payload?.parentID, '20200101000000-parent1');
    assert.equal(payload?.markdown, '# hi');
  });

  it('queryDocs rejects a non-id notebook and unwraps sql rows', async () => {
    const api = new SiYuanApi('http://x', 't');
    await assert.rejects(() => api.queryDocs('../evil'), /Invalid notebook id/);
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/api/sqlite/flushTransaction')) {
        return jsonResponse({ code: 0, msg: '', data: null });
      }
      const body = JSON.parse(String(init?.body));
      assert.match(String(body.stmt), /type = 'd'/);
      assert.match(String(body.stmt), /LIMIT 100000/);
      return jsonResponse({
        code: 0,
        msg: '',
        data: [{ id: '20200101000000-aaaaaaa', hpath: '/a', path: '/20200101000000-aaaaaaa.sy' }],
      });
    };
    const rows = await api.queryDocs('20200101000000-aaaaaaa');
    assert.equal(rows[0].hpath, '/a');
  });

  it('getPathByID accepts both a string and {path, notebook}', async () => {
    const api = new SiYuanApi('http://x', 't');
    globalThis.fetch = async () =>
      jsonResponse({ code: 0, msg: '', data: { path: '/parent/20200101000000-aaaaaaa.sy', notebook: 'nb' } });
    assert.equal(await api.getPathByID('20200101000000-aaaaaaa'), '/parent/20200101000000-aaaaaaa.sy');

    globalThis.fetch = async () =>
      jsonResponse({ code: 0, msg: '', data: '/parent/20200101000000-aaaaaaa.sy' });
    assert.equal(await api.getPathByID('20200101000000-aaaaaaa'), '/parent/20200101000000-aaaaaaa.sy');
  });

  it('unwrapStoragePath falls back when the kernel omits path', () => {
    assert.equal(unwrapStoragePath(null, 'abc'), '/abc.sy');
    assert.equal(unwrapStoragePath({ notebook: 'nb' }, 'abc'), '/abc.sy');
    assert.equal(unwrapStoragePath('/x/abc.sy', 'abc'), '/x/abc.sy');
  });

  it('queryDocs fills in a missing storage path from the id', async () => {
    globalThis.fetch = async (input) => {
      if (String(input).endsWith('/api/sqlite/flushTransaction')) {
        return jsonResponse({ code: 0, msg: '', data: null });
      }
      return jsonResponse({
        code: 0,
        msg: '',
        data: [{ id: '20200101000000-aaaaaaa', hpath: '/a', path: '' }],
      });
    };
    const rows = await new SiYuanApi('http://x', 't').queryDocs('20200101000000-aaaaaaa');
    assert.equal(rows[0].path, '/20200101000000-aaaaaaa.sy');
  });

  it('falls back to path-based filetree APIs when *ByID routes 404', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input).replace('http://x', '');
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      calls.push({ path, body });
      if (path.endsWith('ByID') && !path.endsWith('getPathByID') && !path.endsWith('getHPathByID')) {
        return new Response('', { status: 404, statusText: 'Not Found' });
      }
      if (path.endsWith('/api/filetree/getPathByID')) {
        if (body.id === '20200101000000-from001') {
          return jsonResponse({ code: 0, msg: '', data: '/box/20200101000000-from001.sy' });
        }
        if (body.id === '20200101000000-keep001') {
          return jsonResponse({
            code: 0,
            msg: '',
            data: { path: '/box/20200101000000-keep001.sy', notebook: '20200101000000-note001' },
          });
        }
        if (body.id === '20200101000000-gone001') {
          return jsonResponse({ code: 0, msg: '', data: '/box/20200101000000-gone001.sy' });
        }
        if (body.id === '20200101000000-ren001') {
          return jsonResponse({ code: 0, msg: '', data: '/box/20200101000000-ren001.sy' });
        }
      }
      if (path.endsWith('/api/query/sql')) {
        return jsonResponse({
          code: 0,
          msg: '',
          data: [{ box: '20200101000000-note001' }],
        });
      }
      return jsonResponse({ code: 0, msg: '', data: null });
    };
    const api = new SiYuanApi('http://x', 't');
    await api.moveDocsByID(['20200101000000-from001'], '20200101000000-keep001');
    await api.renameDocByID('20200101000000-ren001', 'new-title');
    await api.removeDocByID('20200101000000-gone001');

    const move = calls.find((c) => c.path.endsWith('/api/filetree/moveDocs'));
    assert.ok(move);
    assert.deepEqual(move?.body.fromPaths, ['/box/20200101000000-from001.sy']);
    assert.equal(move?.body.toNotebook, '20200101000000-note001');
    assert.equal(move?.body.toPath, '/box/20200101000000-keep001.sy');

    const rename = calls.find((c) => c.path.endsWith('/api/filetree/renameDoc'));
    assert.equal(rename?.body.title, 'new-title');
    assert.equal(rename?.body.notebook, '20200101000000-note001');
    assert.equal(rename?.body.path, '/box/20200101000000-ren001.sy');

    const remove = calls.find((c) => c.path.endsWith('/api/filetree/removeDoc'));
    assert.equal(remove?.body.notebook, '20200101000000-note001');
    assert.equal(remove?.body.path, '/box/20200101000000-gone001.sy');

    const byIdAfterDiscover = calls.filter((c) => c.path.endsWith('/api/filetree/moveDocsByID')).length;
    calls.length = 0;
    await api.moveDocsByID(['20200101000000-from001'], '20200101000000-keep001');
    assert.equal(
      calls.some((c) => c.path.endsWith('/api/filetree/moveDocsByID')),
      false,
      'should not retry a 404 ByID route',
    );
    assert.equal(byIdAfterDiscover, 1);
  });

  it('uploadAsset throws when succMap has no entry', async () => {
    globalThis.fetch = async () =>
      jsonResponse({ code: 0, msg: '', data: { errFiles: ['a.png'], succMap: {} } });
    await assert.rejects(
      () => new SiYuanApi('http://x', 't').uploadAsset('a.png', new ArrayBuffer(1), 'image/png'),
      /a\.png/,
    );
  });
});
