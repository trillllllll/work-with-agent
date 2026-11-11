import request from './test-auth.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './app.js';
import { prisma } from './services.js';

/** Chat-completions 测试连接与 /models 拉取共用一个 fetch 桩：按路径分流。 */
function stubProvider(respond: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (url: string | URL | RequestInit, init?: RequestInit) => respond(String(url)));
}
const chatOk = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '连接成功' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const catalogOk = () => new Response(JSON.stringify({ data: [{ id: 'm1', context_window: 4096 }, { id: 'm2' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const createProfile = (body: Record<string, unknown>) => request(app).post('/api/settings/profiles').send(body);

describe('model profiles', () => {
  const originalFetch = globalThis.fetch;
  const nowIso = new Date().toISOString();

  beforeEach(async () => {
    await prisma.appSetting.deleteMany();
    vi.stubGlobal('fetch', vi.fn(async () => chatOk()));
  });

  it('seeds the legacy single-row config into one default profile', async () => {
    await prisma.appSetting.create({ data: { id: 'default', mobileNavigationJson: '["inbox"]', openaiBaseUrl: 'https://legacy.example.com/v1', openaiApiKey: 'secret-key-1234', openaiModel: 'legacy-model', openaiContextWindow: 4096, createdAt: nowIso, updatedAt: nowIso } });
    const loaded = await request(app).get('/api/settings');
    expect(loaded.status).toBe(200);
    expect(loaded.body.data.activeProfileId).toBe('default');
    expect(loaded.body.data.profiles).toHaveLength(1);
    expect(loaded.body.data.profiles[0]).toMatchObject({ id: 'default', name: '默认配置', baseUrl: 'https://legacy.example.com/v1', model: 'legacy-model', contextWindow: 4096, apiKeyConfigured: true, apiKeyMasked: 'sec...1234' });
    expect(JSON.stringify(loaded.body)).not.toContain('secret-key-1234');
    // 幂等：再次读取不产生第二条档案
    const again = await request(app).get('/api/settings');
    expect(again.body.data.profiles).toHaveLength(1);
  });

  it('creates, updates, activates, and copies profiles without leaking keys', async () => {
    await createProfile({ name: '智谱', baseUrl: 'https://zhipu.example.com/v1', model: 'glm-4.6', apiKey: 'zhipu-key-1234', contextWindow: 200000 });
    const created = await createProfile({ name: '中转', baseUrl: 'https://relay.example.com/v1', model: 'gpt-4o-mini', apiKey: 'relay-key-5678' });
    expect(created.status).toBe(200);
    let data = created.body.data;
    expect(data.profiles).toHaveLength(2);
    expect(data.activeProfileId).toBe(data.profiles[0].id); // 首条自动成为使用中
    expect(JSON.stringify(created.body)).not.toContain('relay-key-5678');

    const relay = data.profiles[1];
    // 更新不传 Key：保留原 Key；上下文 0 表示未知
    const updated = await request(app).patch(`/api/settings/profiles/${relay.id}`).send({ baseUrl: 'https://relay.example.com/v2', model: 'gpt-4.1', contextWindow: 0 });
    expect(updated.status).toBe(200);
    data = updated.body.data;
    expect(data.profiles[1]).toMatchObject({ baseUrl: 'https://relay.example.com/v2', model: 'gpt-4.1', contextWindow: null, apiKeyMasked: 'rel...5678' });
    // 更新非使用中的档案不动 openai_* 列
    expect(data.baseUrl).toBe('https://zhipu.example.com/v1');

    const activated = await request(app).post(`/api/settings/profiles/${relay.id}/activate`);
    expect(activated.status).toBe(200);
    expect(activated.body.data.activeProfileId).toBe(relay.id);
    expect(activated.body.data.baseUrl).toBe('https://relay.example.com/v2');
    const row = await prisma.appSetting.findUnique({ where: { id: 'default' } });
    expect(row?.openaiBaseUrl).toBe('https://relay.example.com/v2');
    expect(row?.openaiContextWindow).toBe(0);

    const copied = await request(app).post(`/api/settings/profiles/${relay.id}/copy`);
    expect(copied.status).toBe(200);
    data = copied.body.data;
    expect(data.profiles).toHaveLength(3);
    expect(data.profiles[2].name).toBe('中转 副本');
    expect(data.activeProfileId).toBe(relay.id); // 复制不改变使用中
    expect(JSON.stringify(copied.body)).not.toContain('relay-key-5678');
  });

  it('rejects deleting the last profile and falls back when the active one is deleted', async () => {
    await createProfile({ name: '第一套', baseUrl: 'https://one.example.com/v1', model: 'm-one', apiKey: 'one-key-1234' });
    const second = await createProfile({ name: '第二套', baseUrl: 'https://two.example.com/v1', model: 'm-two', apiKey: 'two-key-5678' });
    const first = (await request(app).get('/api/settings')).body.data.profiles[0];
    const removed = await request(app).delete(`/api/settings/profiles/${first.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.data.activeProfileId).toBe(second.body.data.profiles[1].id);
    expect(removed.body.data.baseUrl).toBe('https://two.example.com/v1'); // 使用中被删后物化列跟随切换
    const last = await request(app).delete(`/api/settings/profiles/${second.body.data.profiles[1].id}`);
    expect(last.status).toBe(400);
    expect(last.body.error).toContain('至少保留一套配置');
  });

  it('keeps the stored key when a profile update omits it and never overwrites on test failure', async () => {
    const created = await createProfile({ name: '稳态', baseUrl: 'https://ok.example.com/v1', model: 'ok-model', apiKey: 'old-key-1234' });
    const id = created.body.data.profiles[0].id;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    const failed = await request(app).patch(`/api/settings/profiles/${id}`).send({ name: '稳态', baseUrl: 'https://bad.example.com/v1', model: 'bad-model', apiKey: 'new-key-5678' });
    expect(failed.status).toBe(502);
    const current = await request(app).get('/api/settings');
    expect(current.body.data.profiles[0]).toMatchObject({ baseUrl: 'https://ok.example.com/v1', model: 'ok-model', apiKeyMasked: 'old...1234' });
  });

  it('proxies the provider model catalog with the resolved key', async () => {
    const created = await createProfile({ name: '带Key', baseUrl: 'https://zhipu.example.com/v1', model: 'glm-4.6', apiKey: 'zhipu-key-1234' });
    const profileId = created.body.data.profiles[0].id;
    const stub = stubProvider(catalogOk);
    vi.stubGlobal('fetch', stub);
    const listed = await request(app).post('/api/settings/models').send({ profileId });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual({ models: [{ id: 'm1', contextWindow: 4096 }, { id: 'm2' }] });
    const called = vi.mocked(stub).mock.calls[0];
    expect(String(called[0])).toBe('https://zhipu.example.com/v1/models');
    expect((called[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer zhipu-key-1234' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const missing = await request(app).post('/api/settings/models').send({ profileId });
    expect(missing.body.data).toEqual({ reason: 'http_error', status: 404 });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const down = await request(app).post('/api/settings/models').send({ profileId });
    expect(down.body.data).toEqual({ reason: 'unreachable' });
  });

  it('accepts a model-only PATCH on a profile, keeping everything else', async () => {
    const created = await createProfile({ name: '智谱', baseUrl: 'https://zhipu.example.com/v1', model: 'glm-4.6', apiKey: 'zhipu-key-1234', contextWindow: 200000 });
    const id = created.body.data.profiles[0].id;
    const patched = await request(app).patch(`/api/settings/profiles/${id}`).send({ model: 'glm-4.5-air' });
    expect(patched.status).toBe(200);
    expect(patched.body.data.profiles[0]).toMatchObject({ name: '智谱', baseUrl: 'https://zhipu.example.com/v1', model: 'glm-4.5-air', contextWindow: 200000, apiKeyMasked: 'zhi...1234' });
  });

  it('routes the legacy PATCH into the active profile', async () => {
    await createProfile({ name: '第一套', baseUrl: 'https://one.example.com/v1', model: 'm-one', apiKey: 'one-key-1234' });
    const created = await createProfile({ name: '第二套', baseUrl: 'https://two.example.com/v1', model: 'm-two', apiKey: 'two-key-5678' });
    const second = created.body.data.profiles[1];
    await request(app).post(`/api/settings/profiles/${second.id}/activate`);
    const saved = await request(app).patch('/api/settings').send({ baseUrl: 'https://two.example.com/v9', model: 'm-two-new' });
    expect(saved.status).toBe(200);
    const data = saved.body.data;
    expect(data.baseUrl).toBe('https://two.example.com/v9');
    expect(data.profiles[1]).toMatchObject({ baseUrl: 'https://two.example.com/v9', model: 'm-two-new', apiKeyMasked: 'two...5678' });
    expect(data.profiles[0].baseUrl).toBe('https://one.example.com/v1'); // 非使用中不受影响
  });

  afterAll(async () => { vi.stubGlobal('fetch', originalFetch); await prisma.appSetting.deleteMany(); });
});
