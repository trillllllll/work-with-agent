import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '../domain/task.js';
import { relayBoundWorkspace } from './workspace-relay.js';

const mocks = vi.hoisted(() => ({
  bind: vi.fn(), requireOwner: vi.fn(), sync: vi.fn(), pending: vi.fn(),
  upstream: vi.fn(), localStop: vi.fn(),
}));
vi.mock('./sync-replica.js', () => ({
  activeSyncBinding: mocks.bind,
  syncBoundReplicaNow: mocks.sync,
}));
vi.mock('./security.js', async (original) => ({
  ...await original<typeof import('./security.js')>(),
  requireOwner: mocks.requireOwner,
}));
vi.mock('../infrastructure/prisma.js', async (original) => {
  const actual = await original<typeof import('../infrastructure/prisma.js')>();
  // The shared Vitest cleanup still uses the actual Prisma client.
  return { ...actual, prisma: new Proxy(actual.prisma, {
    get(target, property, receiver) {
      return property === 'syncOutbox' ? { count: mocks.pending } : Reflect.get(target, property, receiver);
    },
  }) };
});
vi.mock('./workspace-cache-access.js', () => ({
  cacheAuthorization: vi.fn(async () => {}),
  cacheIsDenied: vi.fn(async () => false),
  workspaceCachePath: vi.fn(),
}));

const app = express();
app.use(express.json(), relayBoundWorkspace);
app.post('/api/agent/runs/:id/stop', (_req, res) => { mocks.localStop(); res.sendStatus(204); });
app.use((error: DomainError, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error.status).json({ code: error.code });
});
const path = '/api/agent/runs/fake-run-42/stop';

describe('stopping a cloud chat run from a bound desktop', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.bind.mockReturnValue({ url: 'https://hub.example.test', token: 'fake-device-token', workspaceId: 'fake-workspace' });
    mocks.requireOwner.mockResolvedValue(undefined);
    mocks.sync.mockRejectedValue(new DomainError('SCHEMA_MISMATCH', 'test mismatch', 409));
    mocks.pending.mockResolvedValue(3);
    mocks.upstream.mockImplementation(async () => Response.json({ data: { state: 'paused', pauseReason: 'user_stopped' } }));
    vi.stubGlobal('fetch', mocks.upstream);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('routes stop directly to the hub with neither a pre- nor post-task sync', async () => {
    const res = await request(app).post(path).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ state: 'paused', pauseReason: 'user_stopped' });
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.upstream.mock.calls[0];
    expect(url.href).toBe(`https://hub.example.test/api/v1/sync/relay${path}`);
    expect(init.method).toBe('POST');
    expect(init.headers.get('authorization')).toBe('Bearer fake-device-token');
    expect(init.headers.get('x-dovun-workspace-id')).toBe('fake-workspace');
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.pending).not.toHaveBeenCalled();
    expect(mocks.localStop).not.toHaveBeenCalled();
  });

  it('keeps the task check for sending, resuming, and approving when sync fails', async () => {
    for (const dependent of ['/api/chat', '/api/agent/runs/fake-run-42/resume', '/api/agent/approvals/fake-appr/approve']) {
      const res = await request(app).post(dependent).send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SCHEMA_MISMATCH');
    }
    expect(mocks.sync).toHaveBeenCalledTimes(3);
    expect(mocks.pending).not.toHaveBeenCalled();
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it('keeps the task check for sending, resuming, and approving when local work is pending', async () => {
    mocks.sync.mockResolvedValue({ appliedHubSeq: 0 });
    for (const dependent of ['/api/chat', '/api/agent/runs/fake-run-42/resume', '/api/agent/approvals/fake-appr/approve']) {
      const res = await request(app).post(dependent).send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SYNC_PENDING');
    }
    expect(mocks.sync).toHaveBeenCalledTimes(3);
    expect(mocks.pending).toHaveBeenCalledTimes(3);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it('does not exempt look-alike paths or other methods', async () => {
    for (const dependent of ['/api/agent/runs/fake-run-42/stop/extra', '/api/agent/runs/fake-run-42/stops', '/api/agent/runs/fake-run-42/stop%2Fextra']) {
      expect((await request(app).post(dependent).send({})).body.code).toBe('SCHEMA_MISMATCH');
    }
    expect((await request(app).patch(path).send({})).body.code).toBe('SCHEMA_MISMATCH');
    expect(mocks.sync).toHaveBeenCalledTimes(4);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it('passes through a hub refusal without a local fallback', async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ data: null, error: 'already stopped', code: 'RUN_NOT_STOPPABLE' }, { status: 409 }));
    const res = await request(app).post(path).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RUN_NOT_STOPPABLE');
    expect(mocks.localStop).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('does not claim success or fall back locally if the hub is unreachable', async () => {
    mocks.upstream.mockRejectedValueOnce(new Error('fake connection failure'));
    const res = await request(app).post(path).send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SYNC_UNAVAILABLE');
    expect(mocks.localStop).not.toHaveBeenCalled();
  });

  it('keeps the owner check and leaves unbound instances on the local handler', async () => {
    mocks.requireOwner.mockRejectedValueOnce(new DomainError('AUTH_REQUIRED', 'test unauthorized', 401));
    expect((await request(app).post(path).send({})).status).toBe(401);
    expect(mocks.upstream).not.toHaveBeenCalled();
    expect(mocks.localStop).not.toHaveBeenCalled();
    mocks.bind.mockReturnValue(null);
    expect((await request(app).post(path).send({})).status).toBe(204);
    expect(mocks.localStop).toHaveBeenCalledTimes(1);
  });
});
