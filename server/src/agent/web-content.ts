import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const webSearchInput = z.object({ query: z.string().trim().min(1).max(128), count: z.number().int().min(1).max(10).default(5) }).strict();
const webUrl = z.string().trim().min(1).max(8192).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, '仅支持不带凭据的 http/https 公开链接');
export const webReadInput = z.object({ url: webUrl, cursor: z.string().max(2048).optional(), query: z.string().trim().min(1).max(500).optional() }).strict()
  .refine(value => !(value.cursor && value.query), 'query 和 cursor 不能同时使用');
export const webHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function normalizeWebUrl(value: string) {
  const url = new URL(value);
  let fragment = '';
  try { fragment = decodeURIComponent(url.hash.slice(1)); } catch { fragment = url.hash.slice(1); }
  url.hash = '';
  return { url: url.href, fragment };
}

export type WebPage = { id: string; runId: string; url: string; version: string; title: string | null; content: string; fetchedAt: string };
const PAGE_SIZE = 12000;
function cursorFor(page: WebPage, offset: number) {
  const data = JSON.stringify({ run: page.runId, page: page.id, offset });
  const mac = createHmac('sha256', page.version).update(data).digest('base64url');
  return Buffer.from(JSON.stringify({ data, mac })).toString('base64url');
}
function readCursor(page: WebPage, cursor: string): number | null {
  try {
    const { data, mac } = z.object({ data: z.string(), mac: z.string() }).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    const expected = createHmac('sha256', page.version).update(data).digest();
    const actual = Buffer.from(mac, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const value = z.object({ run: z.string(), page: z.string(), offset: z.number().int().nonnegative() }).parse(JSON.parse(data));
    return value.run === page.runId && value.page === page.id ? value.offset : null;
  } catch { return null; }
}
function headingsOf(content: string) {
  let offset = 0;
  return content.split('\n').flatMap(line => {
    const start = offset; offset += [...line].length + 1;
    return /^\s{0,3}#{1,6}\s+\S/.test(line) ? [{ title: line.replace(/^\s*#+\s*/, '').slice(0, 200), offset: start }] : [];
  });
}
const normalized = (value: string) => value.normalize('NFKC').toLowerCase();

/** Read/query a cached document only. All positions count Unicode code points. */
export function readCachedPage(page: WebPage, input: { cursor?: string; query?: string }) {
  const chars = [...page.content];
  const totalChars = chars.length;
  const base = { url: page.url, title: page.title, fetchedAt: page.fetchedAt, totalChars, sourceType: 'webpage', headings: headingsOf(page.content).slice(0, 20) };
  if (input.query) {
    const needle = normalized(input.query);
    const terms = [...new Set(needle.match(/[\p{L}\p{N}_]+/gu) ?? [])];
    const candidates: Array<{ offset: number; score: number }> = [];
    let offset = 0;
    for (const line of page.content.split('\n')) {
      const text = normalized(line);
      const score = text.includes(needle) ? 100 : terms.filter(term => text.includes(term)).length;
      if (score) {
        const matchAt = text.includes(needle) ? text.indexOf(needle) : Math.min(...terms.filter(term => text.includes(term)).map(term => text.indexOf(term)));
        let sourcePosition = 0, normalizedPosition = 0;
        for (const character of line) {
          if (normalizedPosition >= matchAt) break;
          normalizedPosition += normalized(character).length;
          sourcePosition++;
        }
        candidates.push({ offset: offset + sourcePosition, score: score + (/^\s*#{1,6}\s/.test(line) ? 1000 : 0) });
      }
      offset += [...line].length + 1;
    }
    const windows: Array<{ start: number; end: number }> = [];
    for (const candidate of candidates.sort((a, b) => b.score - a.score || a.offset - b.offset)) {
      const start = Math.max(0, candidate.offset - 500), end = Math.min(totalChars, start + 4000);
      if (windows.some(window => start < window.end && end > window.start)) continue;
      windows.push({ start, end });
      if (windows.length === 3) break;
    }
    return { ...base, status: windows.length ? 'ok' : 'no_match', query: input.query,
      windows: windows.sort((a, b) => a.start - b.start).map(window => ({ ...window, content: chars.slice(window.start, window.end).join(''), cursor: cursorFor(page, window.start), nextCursor: window.end < totalChars ? cursorFor(page, window.end) : null })),
      ...(windows.length ? {} : { note: '未匹配到原文，请参考标题并使用原文术语定位；不具备跨语言语义匹配。' }) };
  }
  const offset = input.cursor ? readCursor(page, input.cursor) : 0;
  if (offset === null || offset >= totalChars && offset !== 0) return { ...base, status: 'invalid_cursor', note: '游标无效或不属于此页面；使用返回的游标，不要自行构造。', firstCursor: cursorFor(page, 0) };
  const end = Math.min(totalChars, offset + PAGE_SIZE);
  return { ...base, status: 'ok', offset, content: chars.slice(offset, end).join(''), truncated: end < totalChars, nextCursor: end < totalChars ? cursorFor(page, end) : null,
    ...(totalChars < 200 ? { note: '页面内容较少，请判断是否足以支持结论。' } : {}) };
}

export function contentQuality(content: string): 'ok' | 'empty_content' | 'suspected_blocked' {
  if (!content.trim()) return 'empty_content';
  if ([...content].length < 500 && /access denied|verify (?:that )?you are human|checking your browser|captcha|sign in to continue|login required|登录后(?:查看|继续)|请先登录|验证码|拒绝访问|访问被拒绝/i.test(content)) return 'suspected_blocked';
  return 'ok';
}
