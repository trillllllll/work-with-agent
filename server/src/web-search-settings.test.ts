import { afterEach, describe, expect, it, vi } from 'vitest';
import request from './test-auth.js';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import { searchWeb } from './agent/web-search.js';
describe('web search configuration', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.WEB_SEARCH_PROXY_URL;
    await prisma.appSetting.updateMany({ data: { deepseekApiKey: '', openaiBaseUrl: '', openaiApiKey: '' } });
  });
  it('persists only on the server and returns masked configuration', async () => {
    const secret = 'deepseek-test-private-123456';
    const saved = await request(app).patch('/api/settings/web-search').send({ apiKey: secret });
    expect(saved.status).toBe(200); expect(saved.text).not.toContain(secret); expect(saved.body.data).toMatchObject({ provider: 'deepseek', configured: true, keyMasked: '••••3456', managedBy: 'application' });
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { id: 'default' } })).deepseekApiKey).toBe(secret);
    await request(app).delete('/api/settings/web-search');
    expect((await request(app).get('/api/settings/web-search')).body.data.configured).toBe(false);
    await expect(searchWeb({ query: 'python sqlite3' })).rejects.toThrow('尚未配置');
  });
  it('falls back to a DeepSeek model key, masked and labelled', async () => {
    const timestamp = new Date().toISOString();
    await prisma.appSetting.upsert({ where: { id: 'default' }, create: { id: 'default', createdAt: timestamp, updatedAt: timestamp }, update: { updatedAt: timestamp } });
    await prisma.appSetting.updateMany({ data: { openaiBaseUrl: 'https://api.deepseek.com/v1', openaiApiKey: 'sk-model-shared-9876' } });
    const settings = await request(app).get('/api/settings/web-search');
    expect(settings.body.data).toMatchObject({ configured: true, keyMasked: '••••9876', managedBy: 'model' });
    expect(settings.text).not.toContain('sk-model-shared-9876');
    await prisma.appSetting.updateMany({ data: { openaiBaseUrl: 'https://api.openai.com/v1' } });
    expect((await request(app).get('/api/settings/web-search')).body.data).toMatchObject({ configured: false, managedBy: 'model' });
  });
  it('keeps environment credentials out of the API and does not override them', async () => {
    process.env.DEEPSEEK_API_KEY = 'deepseek-environment-private';
    const settings = await request(app).get('/api/settings/web-search');
    expect(settings.body.data).toMatchObject({ configured: true, managedBy: 'environment' });
    expect(settings.text).not.toContain(process.env.DEEPSEEK_API_KEY);
    expect((await request(app).patch('/api/settings/web-search').send({ apiKey: 'replacement' })).status).toBe(409);
  });
  it('reports auth, rate limit, timeout and oversized responses with controlled errors', async () => {
    process.env.DEEPSEEK_API_KEY = 'deepseek-test-key';
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'auth' } }), { status: 401 }));
    await expect(searchWeb({ query: 'react hooks' })).rejects.toMatchObject({ code: 'WEB_SEARCH_AUTH' });
    fetcher.mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(searchWeb({ query: 'react hooks' })).rejects.toMatchObject({ code: 'WEB_SEARCH_RATE_LIMITED' });
    fetcher.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await expect(searchWeb({ query: 'react hooks' })).rejects.toMatchObject({ code: 'WEB_SEARCH_UNAVAILABLE' });
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(1025 * 1024)));
    await expect(searchWeb({ query: 'react hooks' })).rejects.toMatchObject({ code: 'WEB_SEARCH_UNAVAILABLE' });
  });
});
