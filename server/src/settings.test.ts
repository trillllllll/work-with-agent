import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './app.js';
import { prisma } from './services.js';

describe('model settings', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await prisma.appSetting.deleteMany();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      expect(body.stream).toBe(false);
      expect(body.tools).toBeUndefined();
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '连接成功' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
  });

  it('persists settings after a successful connection test without exposing the key', async () => {
    const saved = await request(app).patch('/api/settings').send({ baseUrl: 'https://api.example.com/v1', model: 'example-model', apiKey: 'secret-key-1234' });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ baseUrl: 'https://api.example.com/v1', model: 'example-model', apiKeyConfigured: true, apiKeyMasked: 'sec...1234' });
    expect(JSON.stringify(saved.body)).not.toContain('secret-key-1234');
    const loaded = await request(app).get('/api/settings');
    expect(loaded.body.data.apiKeyMasked).toBe('sec...1234');
    expect(JSON.stringify(loaded.body)).not.toContain('secret-key-1234');
  });

  it('keeps the existing key when omitted and clears it explicitly', async () => {
    await request(app).patch('/api/settings').send({ baseUrl: 'https://api.example.com/v1', model: 'example-model', apiKey: 'keep-me-1234' });
    const updated = await request(app).patch('/api/settings').send({ baseUrl: 'https://api.example.com/v2', model: 'new-model' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.apiKeyMasked).toBe('kee...1234');
    const cleared = await request(app).delete('/api/settings/api-key');
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.apiKeyConfigured).toBe(false);
    expect((await prisma.appSetting.findUnique({ where: { id: 'default' } }))?.openaiApiKey).toBe('');
  });

  it('does not overwrite the previous configuration when connection testing fails', async () => {
    await request(app).patch('/api/settings').send({ baseUrl: 'https://api.example.com/v1', model: 'example-model', apiKey: 'old-key-1234' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    const failed = await request(app).patch('/api/settings').send({ baseUrl: 'https://bad.example.com/v1', model: 'bad-model', apiKey: 'new-key-5678' });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain('模型服务错误');
    const current = await request(app).get('/api/settings');
    expect(current.body.data).toMatchObject({ baseUrl: 'https://api.example.com/v1', model: 'example-model', apiKeyMasked: 'old...1234' });
  });

  it('rejects incomplete or malformed settings before testing', async () => {
    expect((await request(app).patch('/api/settings').send({ baseUrl: 'ftp://example.com', model: 'model', apiKey: 'key' })).status).toBe(400);
    expect((await request(app).patch('/api/settings').send({ baseUrl: 'https://example.com/v1', model: '' })).status).toBe(400);
    expect((await request(app).patch('/api/settings').send({ baseUrl: 'https://example.com/v1', model: 'model' })).status).toBe(400);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  afterAll(async () => { vi.stubGlobal('fetch', originalFetch); await prisma.appSetting.deleteMany(); });
});
