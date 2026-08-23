import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ancestorHPaths,
  claimedHPaths,
  hPathCandidates,
  hPathLookupVariants,
  hPathTitle,
  isUnderLocalFolder,
  mapVaultPathToHPath,
  normalizeHPath,
  parentHPath,
  rawLeafName,
  syncRootHPath,
  toHPath,
} from '../src/paths';

describe('Obsidian file → SiYuan hPath', () => {
  it('strips .md so vault files become SiYuan document titles', () => {
    assert.equal(toHPath('projects/alpha/plan.md'), '/projects/alpha/plan');
    assert.equal(toHPath('/projects/alpha/plan.md'), '/projects/alpha/plan');
    assert.equal(toHPath('inbox.md'), '/inbox');
    assert.equal(toHPath('中文/笔记.MD'), '/中文/笔记');
  });

  it('does not treat a folder named like a markdown file as a title suffix except the leaf', () => {
    assert.equal(toHPath('foo.md/bar.md'), '/foo.md/bar');
  });

  it('lists parent folder docs that SiYuan must reuse', () => {
    assert.deepEqual(ancestorHPaths('/projects/alpha/plan'), ['/projects', '/projects/alpha']);
    assert.deepEqual(ancestorHPaths('/inbox'), []);
    assert.equal(parentHPath('/projects/alpha/plan'), '/projects/alpha');
    assert.equal(parentHPath('/inbox'), null);
  });

  it('claims local notes and their folder ancestors, never raw .md titles as the canonical set', () => {
    const claimed = claimedHPaths(['projects/alpha/plan.md', 'inbox.md']);
    assert.ok(claimed.has('/projects'));
    assert.ok(claimed.has('/projects/alpha'));
    assert.ok(claimed.has('/projects/alpha/plan'));
    assert.ok(claimed.has('/inbox'));
    assert.equal(claimed.has('/projects/alpha/plan.md'), false);
  });

  it('still looks up legacy .md titles created by the old plugin', () => {
    const c = hPathCandidates('projects/alpha/plan.md');
    assert.ok(c.includes('/projects/alpha/plan'));
    assert.ok(c.includes('/projects/alpha/plan.md'));
  });

  it('normalizes duplicate-looking web hPaths onto the same key', () => {
    assert.equal(normalizeHPath('/projects/alpha/plan.md'), '/projects/alpha/plan');
    assert.equal(normalizeHPath('projects/alpha/plan'), '/projects/alpha/plan');
    assert.equal(hPathTitle('/projects/alpha/plan.md'), 'plan');
  });

  it('keeps the raw leaf so legacy .md titles can be renamed', () => {
    assert.equal(rawLeafName('/inbox.md'), 'inbox.md');
    assert.equal(rawLeafName('/inbox'), 'inbox');
  });

  it('maps a configured local folder onto a SiYuan directory', () => {
    const vault = '科锐逆向笔记/数据结构/_01_ 时间复杂度（算法）.md';
    assert.equal(isUnderLocalFolder(vault, '科锐逆向笔记'), true);
    assert.equal(isUnderLocalFolder('ctf-/writeup.md', '科锐逆向笔记'), false);
    assert.equal(mapVaultPathToHPath(vault, '', ''), '/科锐逆向笔记/数据结构/_01_ 时间复杂度（算法）');
    assert.equal(
      mapVaultPathToHPath(vault, '科锐逆向笔记', ''),
      '/科锐逆向笔记/数据结构/_01_ 时间复杂度（算法）',
    );
    assert.equal(
      mapVaultPathToHPath(vault, '科锐逆向笔记', '/科锐逆向笔记'),
      '/科锐逆向笔记/数据结构/_01_ 时间复杂度（算法）',
    );
    assert.equal(
      mapVaultPathToHPath(vault, '科锐逆向笔记', '/youdao-note/博客搬运文章/科锐逆向笔记'),
      '/youdao-note/博客搬运文章/科锐逆向笔记/数据结构/_01_ 时间复杂度（算法）',
    );
    assert.equal(syncRootHPath('科锐逆向笔记', ''), '/科锐逆向笔记');
    assert.equal(syncRootHPath('科锐逆向笔记', '/笔记'), '/笔记');
    assert.equal(syncRootHPath('', ''), '/');
  });

  it('treats SQL-escaped CTF &amp;&amp; 靶场 as the same path as vault CTF && 靶场', () => {
    const vault = 'youdao-note/网络安全/CTF && 靶场/CTF 刷题/buu刷题/pwn/a.md';
    const sql = '/youdao-note/网络安全/CTF &amp;&amp; 靶场/CTF 刷题/buu刷题';
    assert.equal(
      toHPath(vault),
      '/youdao-note/网络安全/CTF && 靶场/CTF 刷题/buu刷题/pwn/a',
    );
    assert.equal(normalizeHPath(sql), '/youdao-note/网络安全/CTF && 靶场/CTF 刷题/buu刷题');
    assert.equal(normalizeHPath(sql), toHPath('youdao-note/网络安全/CTF && 靶场/CTF 刷题/buu刷题'));
    const variants = hPathLookupVariants(toHPath('youdao-note/网络安全/CTF && 靶场/CTF 刷题/buu刷题'));
    assert.ok(variants.includes('/youdao-note/网络安全/CTF && 靶场/CTF 刷题/buu刷题'));
    assert.ok(variants.includes('/youdao-note/网络安全/CTF &amp;&amp; 靶场/CTF 刷题/buu刷题'));
  });

  it('trims per-segment spaces so 科锐逆向笔记/ 数据结构 matches web /科锐逆向笔记/数据结构', () => {
    assert.equal(
      toHPath('科锐逆向笔记/ 数据结构/_01_ 时间复杂度（算法）.md'),
      '/科锐逆向笔记/数据结构/_01_ 时间复杂度（算法）',
    );
    assert.equal(normalizeHPath('/科锐逆向笔记/ 数据结构'), '/科锐逆向笔记/数据结构');
    assert.equal(normalizeHPath('/科锐逆向笔记/数据结构'), '/科锐逆向笔记/数据结构');
    assert.deepEqual(ancestorHPaths(toHPath('科锐逆向笔记/ 数据结构/a.md')), [
      '/科锐逆向笔记',
      '/科锐逆向笔记/数据结构',
    ]);
    const claimed = claimedHPaths(['科锐逆向笔记/ 数据结构/a.md']);
    assert.ok(claimed.has('/科锐逆向笔记/数据结构'));
    assert.equal(claimed.has('/科锐逆向笔记/ 数据结构'), false);
  });
});
