import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fingerprintNote } from '../src/markdown';
import {
  collectLocalImages,
  prepareMarkdown,
  ImageResolver,
  AssetUploader,
  ResolvedImageFile,
  remoteFetchHeaders,
  sniffImageMime,
} from '../src/prepare';
import { planNoteSync } from '../src/sync-logic';

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function makeResolver(
  files: Record<string, ResolvedImageFile & { bytes?: ArrayBuffer }>,
): ImageResolver {
  const byPath = new Map<string, ResolvedImageFile & { bytes?: ArrayBuffer }>();
  for (const f of Object.values(files)) byPath.set(f.path, f);
  return {
    resolve: (_source, target) => {
      if (files[target]) return files[target];
      const name = target.split('/').pop() ?? target;
      const matches = Object.values(files).filter((f) => f.name === name);
      return matches.length === 1 ? matches[0] : null;
    },
    readBinary: async (path) => {
      const f = byPath.get(path);
      if (!f) throw new Error(`missing ${path}`);
      return f.bytes ?? bytesOf(path);
    },
  };
}

function makeUploader(): AssetUploader & { calls: string[]; paths: string[] } {
  const calls: string[] = [];
  const paths: string[] = [];
  let n = 0;
  return {
    calls,
    paths,
    async uploadAsset(fileName) {
      calls.push(fileName);
      n += 1;
      const path = `assets/${fileName.replace(/\.[^.]+$/, '')}-${n}.png`;
      paths.push(path);
      return path;
    },
  };
}

const pic: ResolvedImageFile = {
  path: 'attach/pic.png',
  name: 'pic.png',
  extension: 'png',
  mtime: 100,
  size: 20,
};

describe('collectLocalImages', () => {
  it('resolves local images and skips remote, data, and note embeds', () => {
    const md = [
      '![[Other Note]]',
      '![[pic.png]]',
      '![](https://ex.com/a.png)',
      '![x](data:image/png;base64,aGVsbG8=)',
      '![](pic.png)',
    ].join('\n');
    const images = collectLocalImages('note.md', md, makeResolver({ 'pic.png': pic }));
    assert.deepEqual(
      images.map((i) => i.path),
      ['attach/pic.png'],
    );
  });

  it('includes extensionless wiki links that resolve to an image', () => {
    const images = collectLocalImages('note.md', '![[photo]]', makeResolver({ photo: { ...pic, name: 'photo.png' } }));
    assert.equal(images.length, 1);
  });

  it('does not include a markdown file resolved from a wiki embed', () => {
    const noteFile: ResolvedImageFile = {
      path: 'Other Note.md',
      name: 'Other Note.md',
      extension: 'md',
      mtime: 1,
      size: 1,
    };
    const images = collectLocalImages('note.md', '![[Other Note]]', makeResolver({ 'Other Note': noteFile }));
    assert.equal(images.length, 0);
  });
});

describe('prepareMarkdown', () => {
  it('does not rewrite note embeds', async () => {
    const uploader = makeUploader();
    const md = 'See ![[Other Note]] and a picture ![[pic.png]].';
    const prepared = await prepareMarkdown('note.md', md, makeResolver({ 'pic.png': pic }), uploader);
    assert.match(prepared.md, /!\[\[Other Note\]\]/);
    assert.doesNotMatch(prepared.md, /!\[\[pic\.png\]\]/);
    assert.match(prepared.md, /!\[pic\.png\]\(assets\/pic-1\.png\)/);
    assert.equal(uploader.calls.length, 1);
  });

  it('leaves fenced images untouched and only uploads body images', async () => {
    const uploader = makeUploader();
    const md = ['```', '![](secret.png)', '```', '', '![](pic.png)'].join('\n');
    const secret: ResolvedImageFile = { ...pic, path: 'secret.png', name: 'secret.png' };
    const prepared = await prepareMarkdown(
      'note.md',
      md,
      makeResolver({ 'secret.png': secret, 'pic.png': pic }),
      uploader,
    );
    assert.match(prepared.md, /!\[\]\(secret\.png\)/);
    assert.match(prepared.md, /assets\/pic-1\.png/);
    assert.deepEqual(uploader.calls, ['pic.png']);
  });

  it('uploads a data URI once when it appears twice, including charset', async () => {
    const uploader = makeUploader();
    const uri = 'data:image/png;charset=utf-8;base64,aGVsbG8=';
    const md = `![a](${uri}) and ![b](${uri})`;
    const prepared = await prepareMarkdown(
      'note.md',
      md,
      makeResolver({}),
      uploader,
      { dataUriFileName: () => 'inline.png' },
    );
    assert.equal(uploader.calls.length, 1);
    assert.equal(prepared.uploaded, 1);
    assert.equal(prepared.failed.length, 0);
    assert.equal((prepared.md.match(/assets\/inline-1\.png/g) || []).length, 2);
  });

  it('records invalid data URIs as failures', async () => {
    const prepared = await prepareMarkdown(
      'note.md',
      '![x](data:image/png;base64,$$$$)',
      makeResolver({}),
      makeUploader(),
    );
    assert.deepEqual(prepared.failed, ['invalid data URI']);
    assert.equal(prepared.uploaded, 0);
  });

  it('parses titled markdown images and uses jpeg mime for jpg', async () => {
    const jpg: ResolvedImageFile = {
      path: 'a.jpg',
      name: 'a.jpg',
      extension: 'jpg',
      mtime: 1,
      size: 1,
    };
    const mimes: string[] = [];
    const uploader: AssetUploader = {
      async uploadAsset(fileName, _data, mime) {
        mimes.push(mime);
        return `assets/${fileName}`;
      },
    };
    const prepared = await prepareMarkdown(
      'note.md',
      '![alt](a.jpg "caption")',
      makeResolver({ 'a.jpg': jpg }),
      uploader,
    );
    assert.deepEqual(mimes, ['image/jpeg']);
    assert.equal(prepared.md, '![alt](assets/a.jpg)');
  });

  it('uploads a local image once when referenced twice', async () => {
    const uploader = makeUploader();
    const prepared = await prepareMarkdown(
      'note.md',
      '![](pic.png) and ![[pic.png]]',
      makeResolver({ 'pic.png': pic }),
      uploader,
    );
    assert.equal(uploader.calls.length, 1);
    assert.equal(prepared.uploaded, 1);
    assert.equal((prepared.md.match(/assets\/pic-1\.png/g) || []).length, 2);
  });

  it('downloads http(s) images, strips Yuque fragments, and leaves obsidian: links', async () => {
    const uploader = makeUploader();
    const fetches: string[] = [];
    const yuque =
      'https://cdn.nlark.com/yuque/0/2021/png/5360235/1623208172854-c333df6d-459c-49ea-a524-6b6ab8b0fd02.png#height=530&id=x&width=623';
    const prepared = await prepareMarkdown(
      'note.md',
      `![image.png](${yuque}) ![](${yuque}) ![](obsidian://open) ![](pic.png)`,
      makeResolver({ 'pic.png': pic }),
      uploader,
      {
        fetchRemote: {
          fetch: async (url) => {
            fetches.push(url);
            return { bytes: bytesOf('png'), mime: 'image/png' };
          },
        },
      },
    );
    assert.deepEqual(fetches, [
      'https://cdn.nlark.com/yuque/0/2021/png/5360235/1623208172854-c333df6d-459c-49ea-a524-6b6ab8b0fd02.png',
    ]);
    assert.equal(
      uploader.calls.includes('1623208172854-c333df6d-459c-49ea-a524-6b6ab8b0fd02.png'),
      true,
    );
    assert.equal(uploader.calls.includes('pic.png'), true);
    assert.match(prepared.md, /assets\/1623208172854-c333df6d-459c-49ea-a524-6b6ab8b0fd02-1\.png/);
    assert.equal((prepared.md.match(/assets\/1623208172854-c333df6d-459c-49ea-a524-6b6ab8b0fd02-1\.png/g) || []).length, 2);
    assert.match(prepared.md, /obsidian:\/\/open/);
    assert.equal(prepared.uploaded, 2);
  });

  it('downloads Yuque images whose alt contains backticks and ]', async () => {
    const uploader = makeUploader();
    const a = 'https://cdn.nlark.com/yuque/0/a.png#height=1';
    const b = 'https://cdn.nlark.com/yuque/0/b.png';
    const prepared = await prepareMarkdown(
      'note.md',
      `![_[]COH_RL(B\`71LG}P4VS]W.png](${a})![VZE](E\`R6$67%9\`8$%HC4%C.png](${b})`,
      makeResolver({}),
      uploader,
      {
        fetchRemote: {
          fetch: async () => ({ bytes: bytesOf('png'), mime: 'image/png' }),
        },
      },
    );
    assert.equal(prepared.uploaded, 2);
    assert.doesNotMatch(prepared.md, /cdn\.nlark\.com/);
    assert.match(prepared.md, /assets\/a-1\.png/);
    assert.match(prepared.md, /assets\/b-2\.png/);
  });

  it('rewrites Yuque linked-image wrappers so the CDN URL does not remain', async () => {
    const uploader = makeUploader();
    const url = 'https://cdn.nlark.com/yuque/0/c.png';
    const prepared = await prepareMarkdown(
      'note.md',
      `[![](${url})](${url})`,
      makeResolver({}),
      uploader,
      {
        fetchRemote: {
          fetch: async () => ({ bytes: bytesOf('png'), mime: 'image/png' }),
        },
      },
    );
    assert.match(prepared.md, /assets\/c-1\.png/);
    assert.doesNotMatch(prepared.md, /cdn\.nlark\.com/);
    assert.equal(prepared.uploaded, 1);
  });

  it('records failed remote image downloads', async () => {
    const prepared = await prepareMarkdown(
      'note.md',
      '![](https://cdn.nlark.com/yuque/missing.png)',
      makeResolver({}),
      makeUploader(),
      {
        fetchRemote: {
          fetch: async () => {
            throw new Error('HTTP 404');
          },
        },
      },
    );
    assert.equal(prepared.uploaded, 0);
    assert.equal(prepared.failed.length, 1);
    assert.match(prepared.failed[0], /HTTP 404/);
  });

  it('fails missing markdown images but keeps missing extensionless wiki embeds', async () => {
    const prepared = await prepareMarkdown(
      'note.md',
      '![](missing.png) ![[Unknown]] ![[gone.png]]',
      makeResolver({}),
      makeUploader(),
    );
    assert.ok(prepared.failed.includes('missing.png'));
    assert.ok(prepared.failed.includes('gone.png'));
    assert.equal(prepared.failed.includes('Unknown'), false);
    assert.match(prepared.md, /!\[\[Unknown\]\]/);
  });

  it('rewrites $ in asset paths without String.replace artifacts', async () => {
    const uploader: AssetUploader = {
      async uploadAsset() {
        return 'assets/foo-$&-id.png';
      },
    };
    const prepared = await prepareMarkdown('note.md', '![](pic.png)', makeResolver({ 'pic.png': pic }), uploader);
    assert.equal(prepared.md, '![](assets/foo-$&-id.png)');
  });
});

describe('remoteFetchHeaders / sniffImageMime', () => {
  it('sets a Yuque Referer and a WeChat Referer', () => {
    assert.equal(
      remoteFetchHeaders('https://cdn.nlark.com/yuque/0/a.png')['Referer'],
      'https://www.yuque.com/',
    );
    assert.equal(
      remoteFetchHeaders('https://mmbiz.qpic.cn/mmbiz_gif/abc/640?wx_fmt=gif')['Referer'],
      'https://mp.weixin.qq.com/',
    );
  });

  it('detects PNG/JPEG/GIF/WEBP/SVG and rejects HTML hotlink pages', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(sniffImageMime(png.buffer, 'text/html', 'https://x/a'), 'image/png');
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    assert.equal(sniffImageMime(jpg.buffer, '', 'https://x/a'), 'image/jpeg');
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    assert.equal(sniffImageMime(gif.buffer, '', 'https://x/a'), 'image/gif');
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]);
    assert.equal(sniffImageMime(webp.buffer, '', 'https://x/a'), 'image/webp');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    assert.equal(sniffImageMime(svg.buffer, 'application/octet-stream', 'https://x/a'), 'image/svg+xml');
    const html = new TextEncoder().encode('<!DOCTYPE html><html>nope</html>');
    assert.throws(() => sniffImageMime(html.buffer, 'image/png', 'https://cdn.nlark.com/a.png'), /HTML/);
  });
});

describe('skip-before-upload contract', () => {
  it('keeps a stable fingerprint when SiYuan asset paths change between prepares', async () => {
    const raw = '# Hello\n\n![](pic.png)\n![[Other Note]]';
    const resolver = makeResolver({ 'pic.png': pic });
    const images = collectLocalImages('note.md', raw, resolver);
    const fp = fingerprintNote(raw, images);

    const first = await prepareMarkdown('note.md', raw, resolver, {
      uploadAsset: async () => 'assets/pic-20210719092549-aaaaaaa.png',
    });
    const second = await prepareMarkdown('note.md', raw, resolver, {
      uploadAsset: async () => 'assets/pic-20210719092549-bbbbbbb.png',
    });
    assert.notEqual(first.md, second.md, 'SiYuan names each upload uniquely');
    assert.equal(fingerprintNote(raw, images), fp);
    assert.equal(planNoteSync({ storedFingerprint: fp, currentFingerprint: fp, remoteExists: true }), 'skip');
    assert.equal(
      planNoteSync({
        storedFingerprint: fp,
        currentFingerprint: fingerprintNote(raw, [{ ...pic, mtime: 999 }]),
        remoteExists: true,
      }),
      'update',
    );
  });

  it('recreates when the fingerprint matches but the remote doc is gone', () => {
    assert.equal(
      planNoteSync({ storedFingerprint: 'abc', currentFingerprint: 'abc', remoteExists: false }),
      'create',
    );
  });

  it('creates on first sync', () => {
    assert.equal(
      planNoteSync({ storedFingerprint: undefined, currentFingerprint: 'abc', remoteExists: false }),
      'create',
    );
  });
});
