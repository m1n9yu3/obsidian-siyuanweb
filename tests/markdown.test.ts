import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  collectImageRefs,
  decodeDataUri,
  extensionForMime,
  extensionOf,
  fingerprintNote,
  imageFetchUrl,
  isHttpUrl,
  isImageExt,
  isRemoteTarget,
  looksLikeNonImageTarget,
  remoteImageFileName,
  mimeForExtension,
  replaceFirst,
  splitCode,
} from '../src/markdown';

describe('isImageExt / extensionOf', () => {
  it('accepts common image extensions case-insensitively', () => {
    for (const ext of ['png', 'JPG', '.jpeg', 'webp', 'svg', 'gif']) {
      assert.equal(isImageExt(ext), true, ext);
    }
  });

  it('rejects notes and other files', () => {
    assert.equal(isImageExt('md'), false);
    assert.equal(isImageExt('pdf'), false);
    assert.equal(extensionOf('folder/pic.png'), 'png');
    assert.equal(extensionOf('noext'), '');
    assert.equal(extensionOf('.hidden'), '');
    assert.equal(looksLikeNonImageTarget('Other Note.md'), true);
    assert.equal(looksLikeNonImageTarget('pic.png'), false);
    assert.equal(looksLikeNonImageTarget('photo'), false);
  });
});

describe('mime mapping', () => {
  it('uses image/jpeg for jpg', () => {
    assert.equal(mimeForExtension('jpg'), 'image/jpeg');
    assert.equal(mimeForExtension('jpeg'), 'image/jpeg');
    assert.equal(mimeForExtension('png'), 'image/png');
    assert.equal(mimeForExtension('svg'), 'image/svg+xml');
  });

  it('maps svg+xml back to svg, not svg+xml', () => {
    assert.equal(extensionForMime('image/svg+xml'), 'svg');
    assert.equal(extensionForMime('image/jpeg'), 'jpg');
    assert.equal(extensionForMime('image/png;charset=utf-8'), 'png');
  });
});

describe('replaceFirst', () => {
  it('does not interpret $ in the replacement (unlike String.replace)', () => {
    const out = replaceFirst('![a](x.png)', '![a](x.png)', '![a](assets/foo-$&-id.png)');
    assert.equal(out, '![a](assets/foo-$&-id.png)');
  });

  it('replaces only the first occurrence', () => {
    assert.equal(replaceFirst('aa', 'a', 'b'), 'ba');
  });
});

describe('splitCode', () => {
  it('keeps fenced and inline code as code parts', () => {
    const md = 'hi `![](x.png)` there\n```\n![](y.png)\n```\nend';
    const parts = splitCode(md);
    const code = parts.filter((p) => p.type === 'code').map((p) => p.value);
    assert.ok(code.some((c) => c.includes('x.png')));
    assert.ok(code.some((c) => c.includes('y.png')));
    assert.equal(parts.filter((p) => p.type === 'text').map((p) => p.value).join('').includes('x.png'), false);
  });
});

describe('collectImageRefs', () => {
  it('does not treat note embeds as images', () => {
    const refs = collectImageRefs('See ![[Other Note]] and ![[Other Note.md]] plus ![[pic.png]].');
    assert.deepEqual(
      refs.map((r) => r.target),
      ['Other Note', 'pic.png'],
    );
    assert.equal(refs.find((r) => r.target === 'Other Note')?.source, 'wiki');
  });

  it('parses wiki alias, path, and hash', () => {
    const refs = collectImageRefs('![[folder/img.png|100]] ![[img.png#right]]');
    assert.equal(refs.length, 2);
    assert.equal(refs[0].target, 'folder/img.png');
    assert.equal(refs[0].alt, '100');
    assert.equal(refs[1].target, 'img.png');
  });

  it('parses markdown titles and angle-bracket paths', () => {
    const refs = collectImageRefs('![alt](foo.png "title") and ![x](<foo bar.png>)');
    assert.equal(refs.length, 2);
    assert.equal(refs[0].target, 'foo.png');
    assert.equal(refs[0].alt, 'alt');
    assert.equal(refs[1].target, 'foo bar.png');
  });

  it('ignores images inside fenced and inline code', () => {
    const md = ['```', '![secret](secret.png)', '```', '', '![real](real.png)', '', '`![inline](inline.png)`'].join(
      '\n',
    );
    const refs = collectImageRefs(md);
    assert.deepEqual(
      refs.map((r) => r.target),
      ['real.png'],
    );
  });

  it('ignores images inside tilde fences', () => {
    const refs = collectImageRefs('~~~\n![](hidden.png)\n~~~\n![](shown.png)');
    assert.deepEqual(
      refs.map((r) => r.target),
      ['shown.png'],
    );
  });

  it('classifies data URIs', () => {
    const refs = collectImageRefs('![x](data:image/png;base64,aaa)');
    assert.equal(refs[0].source, 'data');
  });

  it('collects http(s) images including Yuque fragment URLs', () => {
    const refs = collectImageRefs(
      '![](https://example.com/a.png) ![](local.png) ![x](https://cdn.nlark.com/yuque/0/a.png#height=1)',
    );
    assert.equal(refs.length, 3);
    assert.equal(isRemoteTarget(refs[0].target), true);
    assert.equal(isHttpUrl(refs[0].target), true);
    assert.equal(isRemoteTarget(refs[1].target), false);
    assert.equal(
      imageFetchUrl(refs[2].target),
      'https://cdn.nlark.com/yuque/0/a.png',
    );
    assert.equal(
      remoteImageFileName('https://cdn.nlark.com/yuque/0/a.png#h=1', 'image/png'),
      'a.png',
    );
  });

  it('parses Yuque alts that contain ] or ( and linked [![](url)](url) wrappers', () => {
    const messy = [
      '![_[]COH_RL(B`71LG}P4VS]W.png](https://cdn.nlark.com/yuque/0/a.png#height=1)',
      '![VZE](E`R6$67%9`8$%HC4%C.png](https://cdn.nlark.com/yuque/0/b.png)',
      '[![](https://cdn.nlark.com/yuque/0/c.png)](https://cdn.nlark.com/yuque/0/c.png)',
    ].join('\n');
    const refs = collectImageRefs(messy);
    assert.deepEqual(
      refs.map((r) => imageFetchUrl(r.target)),
      [
        'https://cdn.nlark.com/yuque/0/a.png',
        'https://cdn.nlark.com/yuque/0/b.png',
        'https://cdn.nlark.com/yuque/0/c.png',
      ],
    );
    assert.equal(refs[2].raw.startsWith('['), true);
  });
});

describe('decodeDataUri', () => {
  it('decodes standard base64', () => {
    const decoded = decodeDataUri('data:image/png;base64,aGVsbG8=');
    assert.ok(decoded);
    if (!decoded) return;
    assert.equal(decoded.mime, 'image/png');
    assert.equal(Buffer.from(decoded.bytes).toString('utf8'), 'hello');
  });

  it('decodes base64 with charset parameter', () => {
    const decoded = decodeDataUri('data:image/png;charset=utf-8;base64,aGVsbG8=');
    assert.ok(decoded);
    if (!decoded) return;
    assert.equal(decoded.mime, 'image/png');
    assert.equal(Buffer.from(decoded.bytes).toString('utf8'), 'hello');
  });

  it('strips whitespace in base64 payload', () => {
    const decoded = decodeDataUri('data:image/png;base64,aGVs\nbG8=');
    assert.ok(decoded);
    if (!decoded) return;
    assert.equal(Buffer.from(decoded.bytes).toString('utf8'), 'hello');
  });

  it('returns null for invalid base64 and invalid percent-encoding', () => {
    assert.equal(decodeDataUri('data:image/png;base64,$$$$'), null);
    assert.equal(decodeDataUri('not-a-uri'), null);
    assert.equal(decodeDataUri('data:text/plain,hello%ZZ'), null);
  });

  it('decodes percent-encoded payloads', () => {
    const decoded = decodeDataUri('data:image/svg+xml,%3Csvg%3E');
    assert.ok(decoded);
    if (!decoded) return;
    assert.equal(Buffer.from(decoded.bytes).toString('utf8'), '<svg>');
  });
});

describe('fingerprintNote', () => {
  it('is stable for the same raw markdown and image stats', () => {
    const images = [{ path: 'b.png', mtime: 2, size: 3 }, { path: 'a.png', mtime: 1, size: 2 }];
    const a = fingerprintNote('# hi\n![](a.png)', images);
    const b = fingerprintNote('# hi\n![](a.png)', [...images].reverse());
    assert.equal(a, b);
  });

  it('changes when raw text or image mtime changes, not when an asset path would change', () => {
    const images = [{ path: 'a.png', mtime: 1, size: 2 }];
    const base = fingerprintNote('![](a.png)', images);
    assert.notEqual(base, fingerprintNote('![](a.png) ', images));
    assert.notEqual(base, fingerprintNote('![](a.png)', [{ path: 'a.png', mtime: 9, size: 2 }]));
    assert.equal(base, fingerprintNote('![](a.png)', [{ path: 'a.png', mtime: 1, size: 2 }]));
  });

  it('dedupes the same local image path', () => {
    const fp = fingerprintNote('x', [
      { path: 'a.png', mtime: 1, size: 1 },
      { path: 'a.png', mtime: 1, size: 1 },
    ]);
    assert.equal(fp.split('\n---\n').length, 2);
  });

  it('invalidates old fingerprints when a note contains http images', () => {
    const local = fingerprintNote('hello', []);
    const remote = fingerprintNote('hello ![](https://cdn.nlark.com/a.png)', []);
    assert.equal(local.includes('remote-fetch:v1'), false);
    assert.equal(remote.includes('remote-fetch:v1'), true);
    assert.notEqual(local, remote);
  });
});
