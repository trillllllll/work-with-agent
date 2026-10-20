import sharp from 'sharp';

export const MAX_IMAGES_PER_TASK = 6;
export const MAX_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 2000;
export const MAX_TEXT_ATTACHMENT_CHARS = 100_000;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const JPEG_QUALITY = 80;
const FALLBACK_DIMENSION = 1280;
const FALLBACK_QUALITY = 60;

const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'csv', 'json', 'log', 'yaml', 'yml', 'xml',
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'css', 'html', 'htm', 'svg',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
  'sh', 'bash', 'zsh', 'toml', 'ini', 'cfg', 'conf', 'sql', 'graphql', 'gql',
  'vue', 'svelte', 'php', 'swift', 'scala', 'lua', 'pl', 'dart', 'diff', 'patch',
  'rst', 'adoc', 'tex', 'r', 'properties', 'env', 'gitignore',
]);

const EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  log: 'text/plain',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  jsx: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/tsx',
};

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/yaml',
  'application/x-yaml',
  'application/csv',
  'application/xhtml+xml',
  'application/ld+json',
  'application/graphql',
  'application/sql',
  'application/x-sh',
  'application/toml',
  'application/x-toml',
  'application/ecmascript',
]);

export type PreparedImage =
  | { ok: true; data: string; mimeType: string; resized: boolean; byteSize: number }
  | { ok: false; reason: string };

/** Ordered unique image ids referenced for this task. Other tasks' ids are ignored. */
export function extractTaskImageRefs(taskId: string, description: string | null | undefined): string[] {
  if (!description) return [];
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:https?:\\/\\/[^\\s"'<>)]+)?\\/api\\/tasks\\/${escaped}\\/images\\/([A-Za-z0-9_-]+)`, 'g');
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of description.matchAll(pattern)) {
    const imageId = match[1];
    if (seen.has(imageId)) continue;
    seen.add(imageId);
    ids.push(imageId);
  }
  return ids;
}

async function longestSide(bytes: Buffer): Promise<number | null> {
  try {
    const meta = await sharp(bytes, { failOn: 'none', animated: false }).metadata();
    if (!meta.width || !meta.height) return null;
    return Math.max(meta.width, meta.height);
  } catch {
    return null;
  }
}

async function encodeJpeg(bytes: Buffer, maxSide: number, quality: number) {
  return sharp(bytes, { failOn: 'none', animated: false })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}

export async function prepareImage(bytes: Buffer, mimeType: string): Promise<PreparedImage> {
  const side = await longestSide(bytes);
  if (bytes.byteLength <= MAX_IMAGE_BYTES && side !== null && side <= MAX_IMAGE_DIMENSION) {
    return { ok: true, data: bytes.toString('base64'), mimeType, resized: false, byteSize: bytes.byteLength };
  }
  try {
    const attempts = [
      { maxSide: MAX_IMAGE_DIMENSION, quality: JPEG_QUALITY },
      { maxSide: FALLBACK_DIMENSION, quality: FALLBACK_QUALITY },
    ];
    let lastSize = 0;
    for (const attempt of attempts) {
      const encoded = await encodeJpeg(bytes, attempt.maxSide, attempt.quality);
      lastSize = encoded.byteLength;
      if (encoded.byteLength <= MAX_IMAGE_BYTES) {
        return { ok: true, data: encoded.toString('base64'), mimeType: 'image/jpeg', resized: true, byteSize: encoded.byteLength };
      }
    }
    return { ok: false, reason: `too large after resize (${lastSize} bytes exceeds ${MAX_IMAGE_BYTES} bytes)` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'sharp failed';
    return { ok: false, reason: `skipped: could not decode image (${detail})` };
  }
}

export function fileExtension(fileName: string) {
  const base = fileName.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function guessMimeFromFileName(fileName: string): string | null {
  const extension = fileExtension(fileName);
  if (EXTENSION_MIME[extension]) return EXTENSION_MIME[extension];
  if (TEXT_EXTENSIONS.has(extension)) return 'text/plain';
  return null;
}

export function resolveAttachmentMime(header: string | null | undefined, fileName: string) {
  const cleaned = header?.split(',')[0]?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (cleaned && cleaned !== 'application/octet-stream') return cleaned;
  return guessMimeFromFileName(fileName) ?? (cleaned || 'application/octet-stream');
}

export function canonicalInlineImageMime(mimeType: string) {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  if (base === 'image/jpg' || base === 'image/pjpeg') return 'image/jpeg';
  return base;
}

export function isInlineImageMime(mimeType: string) {
  const base = canonicalInlineImageMime(mimeType);
  return base === 'image/png' || base === 'image/jpeg' || base === 'image/webp' || base === 'image/gif';
}

export function isTextLikeAttachment(mimeType: string, fileName: string) {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  if (isInlineImageMime(base)) return false;
  if (base.startsWith('text/')) return true;
  if (TEXT_MIME_TYPES.has(base) || base.endsWith('+json') || base.endsWith('+xml')) return true;
  if (!base || base === 'application/octet-stream') return TEXT_EXTENSIONS.has(fileExtension(fileName));
  return false;
}

export function truncateUtf8(bytes: Buffer, maxChars = MAX_TEXT_ATTACHMENT_CHARS) {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const chars = Array.from(decoded);
  if (chars.length <= maxChars) return { text: decoded, truncated: false };
  return { text: chars.slice(0, maxChars).join(''), truncated: true };
}

export function attachmentFileName(contentDisposition: string | null | undefined) {
  if (!contentDisposition) return 'attachment';
  const extended = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i.exec(contentDisposition);
  if (extended) {
    const raw = extended[1].trim().replace(/^"(.*)"$/, '$1');
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(contentDisposition);
  if (quoted) return quoted[1];
  const plain = /filename\s*=\s*([^;]+)/i.exec(contentDisposition);
  return plain ? plain[1].trim() : 'attachment';
}

export function taskImageCaption(index: number, total: number, taskId: string, imageId: string) {
  return `Image ${index}/${total} (imageId=${imageId}, referenced in description as /api/tasks/${taskId}/images/${imageId})`;
}

export function taskImageSummary(skipped: Array<{ imageId: string; reason: string }>) {
  const lines = skipped.length
    ? ['Skipped images:', ...skipped.map((item) => `- imageId=${item.imageId}: ${item.reason}`)]
    : ['No description images were skipped.'];
  lines.push('Use get_task_image to fetch a specific image.');
  return lines.join('\n');
}

export function countCapReason() {
  return `count cap (at most ${MAX_IMAGES_PER_TASK} description images)`;
}

export function totalSizeCapReason() {
  return `total-size cap (at most ${MAX_TOTAL_IMAGE_BYTES} bytes of returned images)`;
}

export function materialMetadata(input: { materialId: string; revision: number; fileName: string; mimeType: string; byteSize: number }) {
  return [
    `materialId=${input.materialId}`,
    `revision=${input.revision}`,
    `fileName=${input.fileName}`,
    `mimeType=${input.mimeType}`,
    `byteSize=${input.byteSize}`,
  ].join('\n');
}
