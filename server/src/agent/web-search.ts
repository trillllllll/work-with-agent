import { deepseekKey } from '../application/deepseek-settings.js';
import { DomainError } from '../domain/task.js';
import { fetch as proxyFetch, ProxyAgent } from 'undici';
import { z } from 'zod';

// DeepSeek tools API：search 与 fetch 都是服务端代抓，本服务不向目标站点发请求，
// 因此没有 assertSafeTarget 的 SSRF 面；这里只做 URL 形状校验。
// 接口契约见 docs/2026-10-27_learning-web-access-research.md。
const API_BASE = 'https://api.deepseek.com/v1/tools';
const SEARCH_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
export const WEB_PAGE_CHARS = 12000;
export const WEB_PAGE_MAX_CHARS = 60000;
/** 每 run 限次：防失控扣费的硬闸，模型会收到明确提示。 */
export const WEB_TOOL_LIMITS: Record<string, number> = { web_search: 4, read_webpage: 8 };

export function webToolLimitExceeded(name: string, usage: { webSearchCalls?: number; webFetchCalls?: number }): boolean {
  const limit = WEB_TOOL_LIMITS[name];
  if (limit === undefined) return false;
  const used = name === 'web_search' ? usage.webSearchCalls ?? 0 : usage.webFetchCalls ?? 0;
  return used >= limit;
}

const webUrl = z.string().trim().min(1).max(8192).refine((value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, '仅支持 http/https 且不带凭据的公开链接');
const searchInput = z.object({ query: z.string().trim().min(1).max(128), count: z.number().int().min(1).max(10).default(5) }).strict();
const fetchInput = z.object({ url: webUrl, cursor: z.string().optional() }).strict();

const searchResultSchema = z.object({
  results: z.array(z.object({
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    snippet: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    site_name: z.string().nullable().optional(),
    authority: z.number().nullable().optional(),
    rerank_score: z.number().nullable().optional(),
  })).max(50),
});
const fetchResultSchema = z.object({ title: z.string().nullable().optional(), content: z.string().nullable().optional() });

let proxyAddress = '';
let proxyAgent: ProxyAgent | undefined;
async function requestDeepseek(url: string, body: unknown, key: string, timeoutMs: number) {
  const options = { method: 'post' as const, headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) };
  const address = process.env.WEB_SEARCH_PROXY_URL?.trim();
  if (!address) return fetch(url, options);
  if (address !== proxyAddress || !proxyAgent) {
    const proxy = new URL(address);
    if (!['http:', 'https:'].includes(proxy.protocol)) throw new DomainError('WEB_SEARCH_UNAVAILABLE', '联网搜索代理协议不支持', 502);
    const token = proxy.username || proxy.password ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : undefined;
    const replacement = new ProxyAgent({ uri: proxy.origin, ...(token ? { token } : {}) });
    if (proxyAgent) void proxyAgent.destroy().catch(() => {});
    proxyAgent = replacement;
    proxyAddress = address;
  }
  return proxyFetch(url, { ...options, dispatcher: proxyAgent });
}

async function networkGuard<T>(promise: Promise<T>, label: string): Promise<T> {
  try { return await promise; } catch (error: unknown) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('WEB_SEARCH_UNAVAILABLE', error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? `${label}超时，请稍后重试` : `无法连接联网搜索服务，请检查网络或稍后重试`, 502);
  }
}

type StreamingResponse = { ok: boolean; status: number; body: { getReader(): ReadableStreamDefaultReader<Uint8Array> } | null };

async function readJson(response: StreamingResponse, label: string, statusErrors?: Record<number, string>) {
  const custom = statusErrors?.[response.status];
  if (custom) throw new DomainError('WEB_SEARCH_UNAVAILABLE', custom, 502);
  if (response.status === 401 || response.status === 403) throw new DomainError('WEB_SEARCH_AUTH', '联网搜索密钥无效或无权限，请检查 DeepSeek 配置', 401);
  if (response.status === 402) throw new DomainError('WEB_SEARCH_AUTH', '联网搜索账户余额不足，请充值后重试', 402);
  if (response.status === 429) throw new DomainError('WEB_SEARCH_RATE_LIMITED', '联网搜索已限流，请稍后重试', 429);
  if (!response.ok) throw new DomainError('WEB_SEARCH_UNAVAILABLE', `${label}服务返回 ${response.status}`, 502);
  const reader = response.body?.getReader();
  if (!reader) throw new DomainError('WEB_SEARCH_UNAVAILABLE', `${label}没有返回内容`, 502);
  const chunks: Uint8Array[] = []; let bytes = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new DomainError('WEB_SEARCH_UNAVAILABLE', `${label}结果超过大小限制`, 502); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new DomainError('WEB_SEARCH_UNAVAILABLE', `${label}返回了无法解析的内容`, 502); }
}

const pageCursor = (offset: number) => Buffer.from(JSON.stringify({ offset })).toString('base64url');

export async function searchWeb(raw: unknown) {
  const { query, count } = searchInput.parse(raw);
  const key = await deepseekKey();
  if (!key) throw new DomainError('WEB_SEARCH_NOT_CONFIGURED', '尚未配置联网搜索服务，无法搜索网页。可在设置中配置 DeepSeek 密钥后使用。', 409);
  const response = await networkGuard(requestDeepseek(`${API_BASE}/search`, { query, count, need_content: false }, key, SEARCH_TIMEOUT_MS), '联网搜索');
  const payload = searchResultSchema.parse(await readJson(response, '联网搜索'));
  const searchedAt = new Date().toISOString();
  const results = payload.results
    .filter((row): row is typeof row & { url: string } => typeof row.url === 'string' && /^https?:\/\//i.test(row.url))
    .slice(0, count)
    .map((row) => ({
      title: ((row.title || '').trim() || row.url.slice(0, 300)),
      url: row.url,
      snippet: (row.snippet || '').slice(0, 500),
      summary: (row.summary || '').slice(0, 1200),
      date: row.date || null,
      siteName: row.site_name || null,
      authority: typeof row.authority === 'number' ? row.authority : null,
      rerankScore: typeof row.rerank_score === 'number' ? row.rerank_score : null,
    }));
  return { provider: 'deepseek' as const, query, searchedAt, resultCount: results.length, results };
}

export async function fetchWebPage(raw: unknown) {
  const { url, cursor } = fetchInput.parse(raw);
  const key = await deepseekKey();
  if (!key) throw new DomainError('WEB_SEARCH_NOT_CONFIGURED', '尚未配置联网搜索服务，无法读取网页。可在设置中配置 DeepSeek 密钥后使用。', 409);
  let offset = 0;
  if (cursor !== undefined) {
    try {
      const parsed = z.object({ offset: z.number().int().min(0) }).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      offset = parsed.offset;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('CURSOR_STALE', '分页已失效，请从第一页重新读取', 409);
    }
  }
  const response = await networkGuard(requestDeepseek(`${API_BASE}/fetch`, { url }, key, FETCH_TIMEOUT_MS), '网页读取');
  const payload = fetchResultSchema.parse(await readJson(response, '网页读取', { 403: '目标网站拒绝访问，无法读取该页面', 404: '没有从该页面提取到可用正文' }));
  const chars = [...(payload.content || '')];
  const capped = chars.slice(0, WEB_PAGE_MAX_CHARS);
  if (offset >= capped.length && (offset > 0 || capped.length > 0)) throw new DomainError('CURSOR_STALE', '分页已超出内容范围，请从第一页重新读取', 409);
  const page = capped.slice(offset, offset + WEB_PAGE_CHARS);
  const next = offset + page.length;
  const hasMore = next < capped.length;
  const overCap = chars.length > WEB_PAGE_MAX_CHARS;
  return {
    url,
    title: (payload.title || '').slice(0, 300) || null,
    content: page.join(''),
    totalChars: chars.length,
    truncated: hasMore || overCap,
    nextCursor: hasMore ? pageCursor(next) : null,
    ...(overCap && !hasMore ? { note: '原文过长，仅返回前 60000 字符。' } : {}),
  };
}
