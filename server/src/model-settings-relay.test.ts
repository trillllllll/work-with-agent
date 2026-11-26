import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ownerRequest from './test-auth.js';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import { DomainError } from './domain/task.js';
import * as replica from './application/sync-replica.js';
import * as cache from './application/workspace-cache-access.js';
import { modelSettingsRoutePolicy } from './application/model-settings-route-policy.js';
import { relayPathAllowed } from './application/workspace-relay.js';
import { pairSyncDevice, syncWorkspaceIdentity } from './application/sync-log.js';

const stamp = '2026-11-26T00:00:00.000Z';
const localPath = '/local-test-only/codex';
const localProfile = { id: 'local-only', name: 'Local only', baseUrl: 'https://local.example.invalid/v1', apiKey: 'fake-local-key-1234', model: 'local-model', contextWindow: 4096 };
const deviceIds: string[] = [];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data, error: null }), { status, headers: { 'content-type': 'application/json' } });
}

function providerOk() {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fake connection ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function seedLocalSettings() {
  await prisma.appSetting.create({ data: {
    id: 'default', mobileNavigationJson: '["inbox"]', openaiBaseUrl: localProfile.baseUrl, openaiApiKey: localProfile.apiKey,
    openaiModel: localProfile.model, openaiContextWindow: localProfile.contextWindow, modelProfilesJson: JSON.stringify([localProfile]),
    activeModelProfileId: localProfile.id, codexManualCommand: localPath, createdAt: stamp, updatedAt: stamp,
  } });
}

function localSettings() {
  return prisma.appSetting.findUniqueOrThrow({ where: { id: 'default' } });
}

function pairedWithPendingFailedSync() {
  vi.spyOn(replica, 'activeSyncBinding').mockReturnValue({ url: 'https://hub.example.invalid', token: 'fake-replica-token-not-a-credential', workspaceId: 'workspace-test' });
  const synchronize = vi.spyOn(replica, 'syncBoundReplicaNow').mockRejectedValue(new DomainError('SCHEMA_MISMATCH', 'fake task schema mismatch', 409));
  const pending = vi.spyOn(prisma.syncOutbox, 'count').mockResolvedValue(1);
  return { synchronize, pending };
}

function fakeHub() {
  let settings = {
    baseUrl: 'https://hub-existing.example.invalid/v1', model: 'hub-existing-model', contextWindow: 8192,
    apiKeyConfigured: true, apiKeyMasked: 'fak...1234', activeProfileId: 'hub-existing',
    profiles: [{ id: 'hub-existing', name: 'Hub existing', baseUrl: 'https://hub-existing.example.invalid/v1', model: 'hub-existing-model', contextWindow: 8192, apiKeyConfigured: true, apiKeyMasked: 'fak...1234' }],
    cli: { codex: { command: '/hub-test-only/codex' } },
  };
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1\/sync\/relay/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/api/settings') return json(settings);
    if (method === 'POST' && path === '/api/settings/profiles') {
      const profile = { id: 'hub-created', name: body.name, baseUrl: body.baseUrl, model: body.model, contextWindow: body.contextWindow ?? null, apiKeyConfigured: true, apiKeyMasked: 'fak...5678' };
      settings = { ...settings, profiles: [...settings.profiles, profile] };
      return json(settings);
    }
    if (method === 'POST' && path === '/api/settings/profiles/hub-created/activate') {
      const active = settings.profiles.find(profile => profile.id === 'hub-created')!;
      settings = { ...settings, activeProfileId: active.id, baseUrl: active.baseUrl, model: active.model, contextWindow: active.contextWindow };
      return json(settings);
    }
    if (method === 'POST' && path === '/api/settings/models') return json({ models: [{ id: 'hub-model-from-catalog', contextWindow: 32768 }] });
    if (method === 'POST' && path === '/api/settings/context-window/probe') return json({ contextWindow: 65536, model: body.model, reason: 'ok' });
    if (method === 'DELETE' && path === '/api/settings/api-key') return json({ ...settings, apiKeyConfigured: false, apiKeyMasked: null });
    return json(settings);
  });
  return { fetcher, calls, read: () => settings };
}

beforeEach(async () => {
  await prisma.appSetting.deleteMany();
  vi.spyOn(cache, 'cacheAuthorization').mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await prisma.appSetting.deleteMany();
  if (deviceIds.length) await prisma.syncDevice.deleteMany({ where: { id: { in: deviceIds.splice(0) } } });
});

describe('model settings route policy', () => {
  it('allows every supported method/path shape and rejects unsupported family routes', () => {
    const allowed = [
      ['GET', '/api/settings'], ['PATCH', '/api/settings'],
      ['POST', '/api/settings/profiles'], ['PATCH', '/api/settings/profiles/profile-1'], ['DELETE', '/api/settings/profiles/profile-1'],
      ['POST', '/api/settings/profiles/profile-1/activate'], ['POST', '/api/settings/profiles/profile-1/copy'],
      ['POST', '/api/settings/models'], ['POST', '/api/settings/context-window/probe'], ['DELETE', '/api/settings/api-key'],
      ['PATCH', '/API/Settings/'], ['POST', '/API/Settings/Profiles/'],
    ];
    for (const [method, path] of allowed) {
      expect(modelSettingsRoutePolicy(method, path), `${method} ${path}`).toBe('hub');
      expect(relayPathAllowed(path, method), `${method} ${path}`).toBe(true);
    }
    const unsupported = [
      ['PUT', '/api/settings'], ['POST', '/api/settings'], ['GET', '/api/settings/profiles'],
      ['POST', '/api/settings/profiles/profile-1'], ['GET', '/api/settings/profiles/profile-1/activate'],
      ['POST', '/api/settings/profiles/profile-1/activate/extra'], ['POST', '/api/settings/profiles/profile%2F1/activate'],
      ['GET', '/api/settings/models'], ['POST', '/api/settings/models/extra'], ['GET', '/api/settings/context-window/probe'],
      ['POST', '/api/settings/api-key'], ['DELETE', '/api/settings/api-key/extra'],
    ];
    for (const [method, path] of unsupported) {
      expect(modelSettingsRoutePolicy(method, path), `${method} ${path}`).toBe('unsupported');
      expect(relayPathAllowed(path, method), `${method} ${path}`).toBe(false);
    }
    for (const path of ['/api/settings/cli', '/api/settings/cli/discover', '/api/settings/cli/codex', '/api/settings/reply-style']) {
      expect(modelSettingsRoutePolicy('PUT', path), path).toBeNull();
    }
    expect(relayPathAllowed('/api/settings/cli', 'PUT')).toBe(false);
    expect(relayPathAllowed('/api/settings/cli/discover', 'POST')).toBe(false);
  });
});

describe('paired model settings through the real app middleware', () => {
  it('creates and activates on the hub, then reads the active model and provider metadata from the hub', async () => {
    await seedLocalSettings();
    const before = await localSettings();
    const taskSync = pairedWithPendingFailedSync();
    const hub = fakeHub();
    vi.stubGlobal('fetch', hub.fetcher);

    const created = await ownerRequest(app).post('/api/settings/profiles').send({ name: 'Hub created', baseUrl: 'https://hub-new.example.invalid/v1', model: 'hub-new-model', apiKey: 'fake-hub-key-5678', contextWindow: 32768 });
    expect(created.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain('fake-hub-key-5678');
    const activated = await ownerRequest(app).post('/api/settings/profiles/hub-created/activate').send({});
    expect(activated.status).toBe(200);
    expect(activated.body.data.activeProfileId).toBe('hub-created');

    const loaded = await ownerRequest(app).get('/api/settings');
    expect(loaded.status).toBe(200);
    expect(loaded.body.data).toMatchObject({ activeProfileId: 'hub-created', baseUrl: 'https://hub-new.example.invalid/v1', model: 'hub-new-model' });
    expect(loaded.body.data.cli.codex.command).toBe(localPath);
    expect(loaded.body.data.cli.codex.command).not.toBe('/hub-test-only/codex');

    const models = await ownerRequest(app).post('/api/settings/models').send({ profileId: 'hub-created' });
    expect(models.status).toBe(200);
    expect(models.body.data).toEqual({ models: [{ id: 'hub-model-from-catalog', contextWindow: 32768 }] });
    const probe = await ownerRequest(app).post('/api/settings/context-window/probe').send({ baseUrl: 'https://hub-new.example.invalid/v1', model: 'hub-new-model', apiKey: 'fake-probe-key-9012' });
    expect(probe.status).toBe(200);
    expect(probe.body.data).toMatchObject({ contextWindow: 65536, model: 'hub-new-model', reason: 'ok' });

    expect(hub.calls.map(call => [call.method, call.path])).toEqual([
      ['POST', '/api/settings/profiles'], ['POST', '/api/settings/profiles/hub-created/activate'], ['GET', '/api/settings'],
      ['POST', '/api/settings/models'], ['POST', '/api/settings/context-window/probe'],
    ]);
    expect(taskSync.synchronize).not.toHaveBeenCalled();
    expect(taskSync.pending).not.toHaveBeenCalled();
    expect(await localSettings()).toEqual(before);
    expect(JSON.stringify(hub.calls)).not.toContain(localPath);
  });

  it('relays legacy settings, profile update/copy/delete, and API-key clear without task synchronization', async () => {
    await seedLocalSettings();
    const before = await localSettings();
    const taskSync = pairedWithPendingFailedSync();
    const hub = fakeHub();
    vi.stubGlobal('fetch', hub.fetcher);

    const responses = await Promise.all([
      ownerRequest(app).patch('/api/settings/profiles/hub-created').send({ model: 'changed-model' }),
      ownerRequest(app).post('/api/settings/profiles/hub-created/copy').send({}),
      ownerRequest(app).delete('/api/settings/profiles/hub-existing'),
      ownerRequest(app).patch('/API/Settings/').send({ baseUrl: 'https://legacy.example.invalid/v1', model: 'legacy-model' }),
      ownerRequest(app).delete('/api/settings/api-key'),
    ]);
    for (const response of responses) expect(response.status).toBe(200);
    expect(responses[3].body.data.cli.codex.command).toBe(localPath);
    expect(responses[4].body.data.cli.codex.command).toBe(localPath);
    expect(hub.calls.map(call => [call.method, call.path])).toEqual(expect.arrayContaining([
      ['PATCH', '/api/settings/profiles/hub-created'], ['POST', '/api/settings/profiles/hub-created/copy'],
      ['DELETE', '/api/settings/profiles/hub-existing'], ['PATCH', '/API/Settings/'], ['DELETE', '/api/settings/api-key'],
    ]));
    expect(taskSync.synchronize).not.toHaveBeenCalled();
    expect(taskSync.pending).not.toHaveBeenCalled();
    expect(await localSettings()).toEqual(before);
    expect(JSON.stringify(hub.calls)).not.toContain(localPath);
  });

  it.each(['http-error', 'offline'])('surfaces hub %s without a local fallback write', async failure => {
    await seedLocalSettings();
    const before = await localSettings();
    const taskSync = pairedWithPendingFailedSync();
    const upstream = vi.fn(async () => {
      if (failure === 'offline') throw new Error('fake hub offline');
      return new Response(JSON.stringify({ data: null, error: 'fake hub unavailable', code: 'HUB_UNAVAILABLE' }), { status: 503, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', upstream);

    const response = await ownerRequest(app).post('/api/settings/profiles').send({ name: 'Must not be local', baseUrl: 'https://new.example.invalid/v1', model: 'new-model', apiKey: 'fake-new-key-1234' });
    expect(response.status).toBe(failure === 'offline' ? 502 : 503);
    expect(response.body.error).toBe(failure === 'offline' ? '共享工作区暂不可用，本机修改已保留' : 'fake hub unavailable');
    expect(upstream).toHaveBeenCalledOnce();
    expect(taskSync.synchronize).not.toHaveBeenCalled();
    expect(taskSync.pending).not.toHaveBeenCalled();
    expect(await localSettings()).toEqual(before);
  });

  it('keeps CLI writes device-local while paired', async () => {
    await seedLocalSettings();
    const before = await localSettings();
    const taskSync = pairedWithPendingFailedSync();
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const saved = await ownerRequest(app).put('/api/settings/cli').send({ provider: 'codex', command: process.execPath });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ source: 'manual', command: process.execPath });
    const current = await localSettings();
    expect(current.codexManualCommand).toBe(process.execPath);
    expect(current.modelProfilesJson).toBe(before.modelProfilesJson);
    expect(current.openaiApiKey).toBe(before.openaiApiKey);
    expect(upstream).not.toHaveBeenCalled();
    expect(taskSync.synchronize).not.toHaveBeenCalled();
    expect(taskSync.pending).not.toHaveBeenCalled();
  });

  it('rejects unsupported model-settings operations while paired without dispatching locally', async () => {
    await seedLocalSettings();
    const before = await localSettings();
    pairedWithPendingFailedSync();
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const responses = [
      await ownerRequest(app).put('/api/settings').send({ baseUrl: 'https://bad.example.invalid', model: 'bad' }),
      await ownerRequest(app).get('/api/settings/profiles'),
      await ownerRequest(app).post('/api/settings/models/extra').send({}),
      await ownerRequest(app).post('/api/settings/profiles/local-only/activate/extra').send({}),
      await ownerRequest(app).post('/api/settings/api-key').send({}),
    ];
    for (const response of responses) {
      expect(response.status).toBe(405);
      expect(response.body.code).toBe('MODEL_SETTINGS_ROUTE_UNSUPPORTED');
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(await localSettings()).toEqual(before);
  });
});

describe('hub admission and unpaired behavior', () => {
  it('admits exact replica model writes with workspace scoping and denies CLI or unsupported shapes', async () => {
    vi.spyOn(replica, 'activeSyncBinding').mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn(async () => providerOk()));
    const device = await pairSyncDevice('fake-model-settings-test');
    deviceIds.push(device.deviceId);
    const identity = await syncWorkspaceIdentity();
    const path = '/api/v1/sync/relay/api/settings/profiles';
    const body = { name: 'Replica hub profile', baseUrl: 'https://replica.example.invalid/v1', model: 'replica-model', apiKey: 'fake-replica-key-1234' };

    const wrongWorkspace = await supertest(app).post(path).set('Authorization', `Bearer ${device.token}`).set('X-Dovun-Workspace-Id', 'wrong-workspace').send(body);
    expect(wrongWorkspace.status).toBe(409);
    expect(await prisma.appSetting.count()).toBe(0);
    const created = await supertest(app).post(path).set('Authorization', `Bearer ${device.token}`).set('X-Dovun-Workspace-Id', identity.workspaceId).send(body);
    expect(created.status).toBe(200);
    expect((await localSettings()).modelProfilesJson).toContain('Replica hub profile');

    for (const [method, route] of [['put', '/api/v1/sync/relay/api/settings'], ['put', '/api/v1/sync/relay/api/settings/cli'], ['get', '/api/v1/sync/relay/api/settings/profiles']] as const) {
      const denied = await supertest(app)[method](route).set('Authorization', `Bearer ${device.token}`).send({});
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('SCOPE_DENIED');
    }
  });

  it('preserves unpaired local profile writes and device-local CLI writes', async () => {
    vi.spyOn(replica, 'activeSyncBinding').mockReturnValue(null);
    const provider = vi.fn(async () => providerOk());
    vi.stubGlobal('fetch', provider);

    const created = await ownerRequest(app).post('/api/settings/profiles').send({ name: 'Unpaired local', baseUrl: 'https://unpaired.example.invalid/v1', model: 'unpaired-model', apiKey: 'fake-unpaired-key-1234' });
    expect(created.status).toBe(200);
    expect((await localSettings()).modelProfilesJson).toContain('Unpaired local');
    expect(provider).toHaveBeenCalledOnce();

    const cli = await ownerRequest(app).put('/api/settings/cli').send({ provider: 'codex', command: process.execPath });
    expect(cli.status).toBe(200);
    expect(cli.body.data).toMatchObject({ source: 'manual', command: process.execPath });
    const cleared = await ownerRequest(app).delete('/api/settings/cli/codex');
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.source).not.toBe('manual');
    expect(provider).toHaveBeenCalledOnce();
  });
});
