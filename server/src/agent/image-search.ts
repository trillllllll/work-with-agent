import { imageSearchKey } from '../application/image-search-settings.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../infrastructure/prisma.js';
import { assertSafeTarget } from '../infrastructure/controlled-execution.js';
import type { ImageResult } from './content-blocks.js';
const inputSchema = z.object({ query: z.string().trim().min(1).max(300), limit: z.number().int().min(1).max(8).default(4) }).strict();
const httpsUrl = z.string().url().max(4096).refine((value) => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; });
const providerSchema = z.object({ results: z.array(z.object({ title: z.string().nullable().optional(), url: z.string().nullable().optional(), thumbnail: z.object({ src: z.string().nullable().optional() }).nullable().optional(), properties: z.object({ url: z.string().nullable().optional() }).nullable().optional() })).max(200) });
const unavailable = (message: string, code = 'IMAGE_SEARCH_UNAVAILABLE') => Object.assign(new Error(message), { code });
export async function imageSearchAvailable() { return Boolean(await imageSearchKey()); }
export async function searchImages(raw: unknown) {
  const { query, limit } = inputSchema.parse(raw);
  const key = await imageSearchKey();
  if (!key) throw unavailable('尚未配置图片搜索服务，无法搜索真实图片');
  const response = await fetch(`https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=${limit}&safesearch=strict`, { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal: AbortSignal.timeout(12000), redirect: 'error' }).catch((error: unknown) => { throw unavailable(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? '图片搜索超时，请稍后重试' : '无法连接图片搜索服务，请检查网络或稍后重试', 'IMAGE_SEARCH_FAILED'); });
  if (!response.ok) throw unavailable(response.status === 429 ? '图片搜索服务已限流，请稍后重试' : `图片搜索服务返回 ${response.status}`, 'IMAGE_SEARCH_FAILED');
  const reader = response.body?.getReader();
  if (!reader) throw unavailable('图片搜索没有返回结果', 'IMAGE_SEARCH_FAILED');
  const chunks: Uint8Array[] = []; let bytes = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 512 * 1024) { await reader.cancel(); throw unavailable('图片搜索结果超过大小限制', 'IMAGE_SEARCH_FAILED'); } chunks.push(value); }
  const parsed = providerSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const searchId = randomUUID(); const searchedAt = new Date().toISOString(); const items: ImageResult[] = [];
  for (const row of parsed.results.slice(0, limit)) {
    const url = httpsUrl.safeParse(row.properties?.url); const thumbnail = httpsUrl.safeParse(row.thumbnail?.src); const sourceUrl = httpsUrl.safeParse(row.url);
    if (!url.success || !thumbnail.success || !sourceUrl.success) continue;
    try { await Promise.all([url.data, thumbnail.data, sourceUrl.data].map((value) => assertSafeTarget(value))); } catch { continue; }
    items.push({ id: randomUUID(), url: url.data, thumbnail: thumbnail.data, sourceUrl: sourceUrl.data, title: (row.title || query).slice(0, 300), searchedAt });
  }
  return { searchId, query, provider: 'brave', items };
}
/** Only tool results persisted in this conversation can authorize image IDs. */
export async function resolveImages(conversationId: string, searchId: string, ids: string[]) {
  const rows = await prisma.message.findMany({ where: { conversationId, role: 'tool', content: { contains: searchId } }, select: { content: true }, take: 20 });
  for (const row of rows) {
    let result: { toolName?: string; success?: boolean; data?: { searchId?: string; items?: ImageResult[] } };
    try { result = JSON.parse(row.content); } catch { continue; }
    if (result.toolName !== 'image_search' || !result.success || result.data?.searchId !== searchId || !Array.isArray(result.data.items)) continue;
    const selected = ids.map((id) => result.data!.items!.find((item) => item.id === id));
    if (selected.every((item): item is ImageResult => Boolean(item)) && new Set(ids).size === ids.length) return selected;
  }
  throw unavailable('图片引用不属于当前会话，或搜索结果已不可用', 'IMAGE_REFERENCE_DENIED');
}
