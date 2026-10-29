import { unified } from 'unified';
import remarkParse from 'remark-parse';

export type RelativeReference = { path: string; resourceId: string; revision: number };
/** URL aliases only. These paths are never used to read the local filesystem. */
export function relativeAssetPath(url: string): string | null {
  if (!url || url.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(url) || /^[\/\\]/.test(url)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(url.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!decoded || decoded.length > 1024 || /[\\\x00-\x1f]/.test(decoded) || decoded.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return null;
  const parts: string[] = [];
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop(); else parts.push(part);
  }
  return parts.length && parts.length <= 64 ? parts.join('/') : null;
}

export function resolveBatchAsset(documentPath: string, alias: string): string | null {
  const base = documentPath.split('/').slice(0, -1);
  for (const part of alias.split('/')) {
    if (part === '..') { if (!base.length) return null; base.pop(); }
    else if (part && part !== '.') base.push(part);
  }
  return base.join('/') || null;
}

export function markdownAssetPaths(source: string): string[] {
  const tree = unified().use(remarkParse).parse(source);
  const result = new Set<string>();
  const queue: Array<{ type?: string; url?: string; children?: unknown[] }> = [tree];
  for (let index = 0; index < queue.length; index += 1) {
    if (index > 100_000) throw new Error('MARKDOWN_IMPORT_TOO_COMPLEX');
    const node = queue[index];
    if (['image', 'link', 'definition'].includes(node.type ?? '') && typeof node.url === 'string') {
      const path = relativeAssetPath(node.url); if (path) result.add(path);
    }
    for (const child of node.children ?? []) { if (queue.length >= 100_000) throw new Error('MARKDOWN_IMPORT_TOO_COMPLEX'); queue.push(child as typeof node); }
  }
  return [...result];
}
