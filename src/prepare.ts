import {
  collectHttpMarkdownImages,
  collectImageRefs,
  collectImageRefsFromChunk,
  decodeDataUri,
  extensionForMime,
  extensionOf,
  fencedCodeRanges,
  fingerprintNote,
  ImageRef,
  ImageStat,
  imageFetchUrl,
  isHttpUrl,
  isImageExt,
  isRemoteTarget,
  mimeForExtension,
  remoteImageFileName,
  replaceFirst,
  splitCode,
} from './markdown';

export interface ResolvedImageFile extends ImageStat {
  name: string;
  extension: string;
}

export interface ImageResolver {
  resolve(sourcePath: string, target: string): ResolvedImageFile | null;
  readBinary(path: string): Promise<ArrayBuffer>;
}

export interface AssetUploader {
  uploadAsset(fileName: string, data: ArrayBuffer, mime: string): Promise<string>;
}

export interface RemoteFetcher {
  fetch(url: string): Promise<{ bytes: ArrayBuffer; mime: string }>;
}

export const MAX_REMOTE_BYTES = 20 * 1024 * 1024;

export function remoteFetchHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'image/avif,image/webp,image/apng,image/gif,image/*,*/*;q=0.8',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  };
  if (/nlark\.com|yuque\./i.test(url)) headers.Referer = 'https://www.yuque.com/';
  if (/mmbiz\.qpic\.cn|(?:^|[./])qpic\.cn/i.test(url)) headers.Referer = 'https://mp.weixin.qq.com/';
  return headers;
}

/** Prefer magic bytes so hotlink HTML pages are not uploaded as images. */
export function sniffImageMime(bytes: ArrayBuffer, fallbackMime: string, url: string): string {
  const u8 = new Uint8Array(bytes);
  if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    return 'image/png';
  }
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
  if (u8.length >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'image/gif';
  if (
    u8.length >= 12 &&
    u8[0] === 0x52 &&
    u8[1] === 0x49 &&
    u8[2] === 0x46 &&
    u8[3] === 0x46 &&
    u8[8] === 0x57 &&
    u8[9] === 0x45 &&
    u8[10] === 0x42 &&
    u8[11] === 0x50
  ) {
    return 'image/webp';
  }
  const head = new TextDecoder('utf-8').decode(u8.slice(0, 256)).trimStart();
  if (/^(?:<\?xml\b|<svg\b)/i.test(head)) return 'image/svg+xml';
  if (/^(?:<!DOCTYPE\s+html\b|<html\b)/i.test(head)) {
    throw new Error('not an image (HTML)');
  }
  let mime = (fallbackMime || '').split(';')[0].trim();
  if (!mime.startsWith('image/')) {
    const ext = extensionOf(url.split('?')[0]);
    if (isImageExt(ext)) mime = mimeForExtension(ext);
  }
  if (!mime.startsWith('image/')) throw new Error(`not an image (${fallbackMime || 'unknown type'})`);
  return mime;
}

export async function defaultFetchRemote(url: string): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const resp = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: remoteFetchHeaders(url),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const headerMime = (resp.headers.get('content-type') || '').split(';')[0].trim();
  const bytes = await resp.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error('empty response');
  if (bytes.byteLength > MAX_REMOTE_BYTES) throw new Error(`image too large (${bytes.byteLength} bytes)`);
  return { bytes, mime: sniffImageMime(bytes, headerMime, url) };
}

export interface PreparedMarkdown {
  md: string;
  uploaded: number;
  failed: string[];
  images: ResolvedImageFile[];
}

export interface PrepareOptions {
  /** Stable names for tests. Default uses time + random. */
  dataUriFileName?: (mime: string, index: number) => string;
  fetchRemote?: RemoteFetcher;
}

export function collectLocalImages(
  sourcePath: string,
  md: string,
  resolver: ImageResolver,
): ResolvedImageFile[] {
  const out: ResolvedImageFile[] = [];
  const seen = new Set<string>();
  for (const ref of collectImageRefs(md)) {
    if (ref.source === 'data' || isRemoteTarget(ref.target)) continue;
    const file = resolver.resolve(sourcePath, ref.target);
    if (!file || !isImageExt(file.extension)) continue;
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    out.push(file);
  }
  return out;
}

export function fingerprintPrepared(rawMd: string, images: ImageStat[]): string {
  return fingerprintNote(rawMd, images);
}

async function rewriteRef(
  ref: ImageRef,
  sourcePath: string,
  resolver: ImageResolver,
  uploader: AssetUploader,
  uploads: Map<string, string>,
  failed: string[],
  dataUriNames: Map<string, string>,
  options: PrepareOptions,
): Promise<{ replacement?: string; uploaded: boolean }> {
  if (isHttpUrl(ref.target)) {
    const fetchUrl = imageFetchUrl(ref.target);
    const cached = uploads.get(fetchUrl);
    if (cached) return { replacement: `![${ref.alt}](${cached})`, uploaded: false };
    const fetcher = options.fetchRemote ?? { fetch: defaultFetchRemote };
    try {
      const remote = await fetcher.fetch(fetchUrl);
      const fileName = remoteImageFileName(fetchUrl, remote.mime);
      const assetPath = await uploader.uploadAsset(fileName, remote.bytes, remote.mime);
      uploads.set(fetchUrl, assetPath);
      return { replacement: `![${ref.alt}](${assetPath})`, uploaded: true };
    } catch (e) {
      failed.push(`${fetchUrl}: ${e instanceof Error ? e.message : String(e)}`);
      return { uploaded: false };
    }
  }

  if (isRemoteTarget(ref.target)) return { uploaded: false };
  if (/^(?:\.?\/)?assets\//i.test(ref.target.trim())) return { uploaded: false };

  if (ref.source === 'data' || /^data:/i.test(ref.target)) {
    const cached = uploads.get(ref.target);
    if (cached) return { replacement: `![${ref.alt}](${cached})`, uploaded: false };
    const decoded = decodeDataUri(ref.target);
    if (!decoded) {
      failed.push('invalid data URI');
      return { uploaded: false };
    }
    const fileName =
      dataUriNames.get(ref.target) ??
      options.dataUriFileName?.(decoded.mime, dataUriNames.size) ??
      `obsidian-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extensionForMime(decoded.mime)}`;
    dataUriNames.set(ref.target, fileName);
    try {
      const assetPath = await uploader.uploadAsset(fileName, decoded.bytes, decoded.mime);
      uploads.set(ref.target, assetPath);
      return { replacement: `![${ref.alt}](${assetPath})`, uploaded: true };
    } catch (e) {
      failed.push(`${fileName}: ${e instanceof Error ? e.message : String(e)}`);
      return { uploaded: false };
    }
  }

  const file = resolver.resolve(sourcePath, ref.target);
  const isImageFile = Boolean(file && isImageExt(file.extension));
  if (!isImageFile) {
    if (ref.source === 'wiki' && !isImageExt(extensionOf(ref.target))) {
      return { uploaded: false };
    }
    failed.push(ref.target);
    return { uploaded: false };
  }
  if (!file) return { uploaded: false };

  const cached = uploads.get(file.path);
  if (cached) return { replacement: `![${ref.alt}](${cached})`, uploaded: false };

  try {
    const bytes = await resolver.readBinary(file.path);
    const mime = mimeForExtension(file.extension);
    const assetPath = await uploader.uploadAsset(file.name, bytes, mime);
    uploads.set(file.path, assetPath);
    return { replacement: `![${ref.alt}](${assetPath})`, uploaded: true };
  } catch (e) {
    failed.push(`${file.path}: ${e instanceof Error ? e.message : String(e)}`);
    return { uploaded: false };
  }
}

/** Upload local/data images and rewrite only those links. Code blocks are left intact. */
export async function prepareMarkdown(
  sourcePath: string,
  md: string,
  resolver: ImageResolver,
  uploader: AssetUploader,
  options: PrepareOptions = {},
): Promise<PreparedMarkdown> {
  const uploads = new Map<string, string>();
  const dataUriNames = new Map<string, string>();
  const failed: string[] = [];
  const images = collectLocalImages(sourcePath, md, resolver);
  let uploaded = 0;
  const fences = fencedCodeRanges(md);
  let working = md;
  for (const ref of collectHttpMarkdownImages(working)) {
    if (fences.some((r) => ref.index >= r.start && ref.index < r.end)) continue;
    const result = await rewriteRef(
      ref,
      sourcePath,
      resolver,
      uploader,
      uploads,
      failed,
      dataUriNames,
      options,
    );
    if (result.uploaded) uploaded++;
    if (result.replacement) {
      working = replaceFirst(working, ref.raw, result.replacement);
    }
  }

  const parts: string[] = [];
  for (const part of splitCode(working)) {
    if (part.type === 'code') {
      parts.push(part.value);
      continue;
    }
    let chunk = part.value;
    const refs = collectImageRefsFromChunk(chunk);
    for (const ref of refs) {
      if (isHttpUrl(ref.target)) continue;
      const result = await rewriteRef(
        ref,
        sourcePath,
        resolver,
        uploader,
        uploads,
        failed,
        dataUriNames,
        options,
      );
      if (result.uploaded) uploaded++;
      if (result.replacement) {
        chunk = replaceFirst(chunk, ref.raw, result.replacement);
      }
    }
    parts.push(chunk);
  }

  return { md: parts.join(''), uploaded, failed, images };
}
