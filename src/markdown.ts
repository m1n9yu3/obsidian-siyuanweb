export const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
  'tif',
  'tiff',
  'heic',
  'heif',
  'jfif',
  'apng',
]);

const REMOTE_TARGET = /^(https?:|obsidian:|app:|file:|\/\/)/i;

export type ImageRefSource = 'markdown' | 'wiki' | 'data';

export interface ImageRef {
  raw: string;
  alt: string;
  target: string;
  source: ImageRefSource;
  index: number;
}

export function isImageExt(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ''));
}

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1);
}

export function isRemoteTarget(target: string): boolean {
  return REMOTE_TARGET.test(target.trim());
}

export function isHttpUrl(target: string): boolean {
  return /^https?:\/\//i.test(target.trim());
}

/** Strip display fragments (#height=…) used by Yuque/Obsidian; keep the fetchable URL. */
export function imageFetchUrl(target: string): string {
  const t = target.trim();
  const hash = t.indexOf('#');
  return hash >= 0 ? t.slice(0, hash) : t;
}

export function remoteImageFileName(url: string, mime: string): string {
  let base = 'image';
  try {
    const u = new URL(imageFetchUrl(url));
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last) base = last;
  } catch {
    /* ignore */
  }
  const clean = base.replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, '-');
  const ext = extensionOf(clean);
  if (isImageExt(ext)) return clean.slice(0, 180);
  return `${(clean.replace(/\.[^.]*$/, '') || 'image').slice(0, 160)}.${extensionForMime(mime)}`;
}

export function looksLikeNonImageTarget(target: string): boolean {
  const ext = extensionOf(target.trim());
  if (!ext) return false;
  return !isImageExt(ext);
}

export function mimeForExtension(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '');
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jfif: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    heic: 'image/heic',
    heif: 'image/heif',
    apng: 'image/apng',
  };
  return map[e] || `image/${e}`;
}

export function extensionForMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0].trim();
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/avif': 'avif',
    'image/tiff': 'tiff',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/apng': 'apng',
  };
  if (map[m]) return map[m];
  const subtype = m.split('/')[1] || 'png';
  return subtype.replace('jpeg', 'jpg').replace(/\+xml$/, '');
}

export function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const i = haystack.indexOf(needle);
  if (i < 0) return haystack;
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

export interface CodePart {
  type: 'text' | 'code';
  value: string;
}

/** Split markdown so fenced/inline code can be left untouched. */
export function splitCode(md: string): CodePart[] {
  const re = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`/g;
  const parts: CodePart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m.index > last) parts.push({ type: 'text', value: md.slice(last, m.index) });
    parts.push({ type: 'code', value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < md.length) parts.push({ type: 'text', value: md.slice(last) });
  return parts;
}

export function fencedCodeRanges(md: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

function isInRanges(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
}

/** Scan the full note so Yuque alts with backticks/] are not torn by inline-code splitting. */
export function collectHttpMarkdownImages(md: string): ImageRef[] {
  const refs: ImageRef[] = [];
  const re = /!\[(.*?)\]\(\s*(<(https?:\/\/[^>\n]+)>|(https?:\/\/[^)\s]+))/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const target = (m[3] ?? m[4] ?? '').trim();
    if (!target) continue;
    const end = md.indexOf(')', m.index + m[0].length);
    const raw = end >= 0 ? md.slice(m.index, end + 1) : m[0];
    refs.push(
      expandLinkedImageRaw(md, {
        raw,
        alt: (m[1].split(/[\\/]/).pop() ?? m[1]).trim(),
        target,
        source: 'markdown',
        index: m.index,
      }),
    );
  }
  return refs;
}

export function collectImageRefs(markdown: string): ImageRef[] {
  const refs: ImageRef[] = [];
  let offset = 0;
  for (const part of splitCode(markdown)) {
    if (part.type === 'text') {
      for (const ref of collectImageRefsFromChunk(part.value)) {
        refs.push({ ...ref, index: offset + ref.index });
      }
    }
    offset += part.value.length;
  }
  const fences = fencedCodeRanges(markdown);
  for (const ref of collectHttpMarkdownImages(markdown)) {
    if (isInRanges(ref.index, fences)) continue;
    if (refs.some((r) => isHttpUrl(r.target) && imageFetchUrl(r.target) === imageFetchUrl(ref.target))) {
      continue;
    }
    refs.push(ref);
  }
  refs.sort((a, b) => a.index - b.index);
  return refs;
}

export function collectImageRefsFromChunk(chunk: string): ImageRef[] {
  const refs: ImageRef[] = [];
  const wikiRe = /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRe.exec(chunk))) {
    const target = m[1].trim();
    if (!target || looksLikeNonImageTarget(target)) continue;
    refs.push({
      raw: m[0],
      alt: (m[2] ?? target.split(/[\\/]/).pop() ?? target).trim(),
      target,
      source: 'wiki',
      index: m.index,
    });
  }

  const mdRe =
    /!\[([^\]]*)\]\(\s*(?:<([^>\n]+)>|((?:\\\)|[^)\s])+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  while ((m = mdRe.exec(chunk))) {
    let target = (m[2] ?? m[3] ?? '').replace(/\\([()])/g, '$1').trim();
    if (!target) continue;
    if (!isHttpUrl(target) && !/^data:/i.test(target)) {
      const coerced = coerceHttpTarget(target);
      if (isHttpUrl(coerced)) target = coerced;
    }
    const source: ImageRefSource = /^data:/i.test(target) ? 'data' : 'markdown';
    refs.push(
      expandLinkedImageRaw(chunk, {
        raw: m[0],
        alt: m[1],
        target,
        source,
        index: m.index,
      }),
    );
  }

  const looseRe = /!\[(.*?)\]\(\s*(<(https?:\/\/[^>\n]+)>|(https?:\/\/[^)\s]+))/gs;
  while ((m = looseRe.exec(chunk))) {
    const target = (m[3] ?? m[4] ?? '').trim();
    if (!target) continue;
    const already = refs.some((r) => {
      if (imageFetchUrl(r.target) === imageFetchUrl(target)) return true;
      return r.index === m!.index && isHttpUrl(r.target);
    });
    if (already) continue;
    const end = chunk.indexOf(')', m.index + m[0].length);
    const raw = end >= 0 ? chunk.slice(m.index, end + 1) : m[0];
    refs.push(
      expandLinkedImageRaw(chunk, {
        raw,
        alt: m[1].split('/').pop() ?? m[1],
        target,
        source: 'markdown',
        index: m.index,
      }),
    );
  }

  refs.sort((a, b) => a.index - b.index);
  return refs;
}

function coerceHttpTarget(target: string): string {
  const i = target.search(/https?:\/\//i);
  return i >= 0 ? target.slice(i) : target;
}

/** Yuque often wraps images as [![](url)](url). Rewrite the wrapper too so the CDN URL does not remain. */
function expandLinkedImageRaw(chunk: string, ref: ImageRef): ImageRef {
  if (!isHttpUrl(ref.target) || ref.index <= 0 || chunk[ref.index - 1] !== '[') return ref;
  const after = chunk.slice(ref.index + ref.raw.length);
  const wrap = /^\]\(\s*(<(https?:\/\/[^>\n]+)>|(https?:\/\/[^)\s]+))\s*\)/.exec(after);
  if (!wrap) return ref;
  const linked = (wrap[2] ?? wrap[3] ?? '').trim();
  if (imageFetchUrl(linked) !== imageFetchUrl(ref.target)) return ref;
  return { ...ref, raw: `[${ref.raw}${wrap[0]}`, index: ref.index - 1 };
}

export function decodeDataUri(uri: string): { bytes: ArrayBuffer; mime: string } | null {
  const m = /^data:([^;,]+)?((?:;[^,;]+)*)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const mime = (m[1] || 'application/octet-stream').trim() || 'application/octet-stream';
  const params = (m[2] || '').toLowerCase();
  const payload = m[3] ?? '';
  const isBase64 = /(?:^|;)base64(?:;|$)/.test(params);
  if (!isBase64) {
    try {
      const decoded = decodeURIComponent(payload);
      return { bytes: new TextEncoder().encode(decoded).buffer, mime };
    } catch {
      return null;
    }
  }
  try {
    const bin = atob(payload.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes: bytes.buffer, mime };
  } catch {
    return null;
  }
}

export interface ImageStat {
  path: string;
  mtime: number;
  size: number;
}

/** Fingerprint local note text + embedded local image identity. Never includes uploaded asset paths. */
export function fingerprintNote(rawMd: string, images: ImageStat[]): string {
  const parts = [rawMd];
  const unique = [...images].sort((a, b) => a.path.localeCompare(b.path));
  const seen = new Set<string>();
  for (const img of unique) {
    if (seen.has(img.path)) continue;
    seen.add(img.path);
    parts.push(`${img.path}:${img.mtime}:${img.size}`);
  }
  if (collectImageRefs(rawMd).some((r) => isHttpUrl(r.target))) {
    parts.push('remote-fetch:v1');
  }
  return parts.join('\n---\n');
}
