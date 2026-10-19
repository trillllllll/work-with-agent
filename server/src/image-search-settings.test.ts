import { afterEach, describe, expect, it, vi } from 'vitest';
import request from './test-auth.js';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import * as targets from './infrastructure/controlled-execution.js';
import { resolveImages, searchImages } from './agent/image-search.js';
describe('Brave image search configuration', () => {
  afterEach(async () => { vi.restoreAllMocks(); delete process.env.BRAVE_IMAGE_SEARCH_KEY; await prisma.appSetting.updateMany({ data: { braveImageApiKey: '' } }); });
  it('persists only on the server and returns masked configuration', async () => {
    const secret = 'brave-test-private-123456';
    const saved = await request(app).patch('/api/settings/image-search').send({ apiKey: secret });
    expect(saved.status).toBe(200); expect(saved.text).not.toContain(secret); expect(saved.body.data).toMatchObject({ provider: 'brave', configured: true, keyMasked: '••••3456' });
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).braveImageApiKey).toBe(secret);
    const settings = await request(app).get('/api/settings'); expect(settings.text).not.toContain(secret);
    await request(app).delete('/api/settings/image-search');
    expect((await request(app).get('/api/settings/image-search')).body.data.configured).toBe(false);
    await expect(searchImages({ query: '流程图' })).rejects.toThrow('尚未配置');
  });
  it('keeps environment credentials out of the API and does not override them', async () => {
    process.env.BRAVE_IMAGE_SEARCH_KEY = 'brave-environment-private';
    const settings = await request(app).get('/api/settings/image-search');
    expect(settings.body.data).toMatchObject({ configured: true, managedBy: 'environment' });
    expect(settings.text).not.toContain(process.env.BRAVE_IMAGE_SEARCH_KEY);
    expect((await request(app).patch('/api/settings/image-search').send({ apiKey: 'replacement' })).status).toBe(409);
  });
  it('returns a controlled rate-limit error without exposing credentials', async () => {
    process.env.BRAVE_IMAGE_SEARCH_KEY = 'brave-secret-ratelimit';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }));
    await expect(searchImages({ query: '山景' })).rejects.toThrow('限流');
  });
  it('uses Brave image URLs and page sources, filters unsupported URLs, and binds results to their conversation', async () => {
    process.env.BRAVE_IMAGE_SEARCH_KEY = 'brave-test-key';
    vi.spyOn(targets, 'assertSafeTarget').mockResolvedValue(undefined);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [
      { title: '山景', url: 'https://example.com/page', thumbnail: { src: 'https://example.com/thumb.jpg' }, properties: { url: 'https://example.com/full.jpg' } },
      { title: '不允许的协议', url: 'https://example.com/page', thumbnail: { src: 'https://example.com/thumb.jpg' }, properties: { url: 'http://example.com/full.jpg' } },
    ] }));
    const result = await searchImages({ query: '中文 山景', limit: 2 });
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toContain('https://api.search.brave.com/res/v1/images/search?');
    expect(new URL(String(url)).searchParams.get('q')).toBe('中文 山景');
    expect(options).toMatchObject({ headers: { 'X-Subscription-Token': 'brave-test-key' }, redirect: 'error' });
    expect(result.items).toHaveLength(1); expect(result.items[0]).toMatchObject({ url: 'https://example.com/full.jpg', sourceUrl: 'https://example.com/page' });
    const conversation = await prisma.conversation.create({ data: {} });
    const other = await prisma.conversation.create({ data: {} });
    try {
      await prisma.message.create({ data: { conversationId: conversation.id, role: 'tool', content: JSON.stringify({ toolName: 'image_search', success: true, data: result }) } });
      await expect(resolveImages(conversation.id, result.searchId, [result.items[0].id])).resolves.toEqual(result.items);
      await expect(resolveImages(other.id, result.searchId, [result.items[0].id])).rejects.toThrow('不属于');
      await expect(resolveImages(conversation.id, result.searchId, ['invented'])).rejects.toThrow('不属于');
    } finally { await prisma.conversation.deleteMany({ where: { id: { in: [conversation.id, other.id] } } }); }
  });
  it('reports provider timeouts and rejects oversized responses', async () => {
    process.env.BRAVE_IMAGE_SEARCH_KEY = 'brave-test-key';
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await expect(searchImages({ query: '山景' })).rejects.toThrow('超时');
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(513 * 1024)));
    await expect(searchImages({ query: '山景' })).rejects.toThrow('大小限制');
  });

});
