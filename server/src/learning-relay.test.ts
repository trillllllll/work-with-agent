import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayBoundWorkspace } from './application/workspace-relay.js';
import * as replica from './application/sync-replica.js';
import * as security from './application/security.js';
import * as cache from './application/workspace-cache-access.js';
import { prisma } from './infrastructure/prisma.js';
import { DomainError } from './domain/task.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  vi.spyOn(replica, 'activeSyncBinding').mockReturnValue({ url: 'https://learning-test.invalid', token: 'test-only-replica-token', workspaceId: 'workspace-test' });
  const synchronize = vi.spyOn(replica, 'syncBoundReplicaNow').mockResolvedValue({ appliedHubSeq: 0 });
  const pending = vi.spyOn(prisma.syncOutbox, 'count').mockResolvedValue(1);
  const authenticate = vi.spyOn(security, 'requireOwner').mockResolvedValue({ actor: security.ownerActor });
  vi.spyOn(cache, 'cacheAuthorization').mockResolvedValue(undefined);
  const fetch = vi.fn().mockResolvedValue(new globalThis.Response(JSON.stringify({ data: { status: 'applied' } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const chunks: Buffer[] = [];
  const response = {
    headersSent: false, writableEnded: false,
    once: vi.fn(), status: vi.fn().mockReturnThis(), setHeader: vi.fn().mockReturnThis(),
    write: vi.fn((chunk: Buffer) => chunks.push(chunk)), end: vi.fn(), json: vi.fn(),
  };
  const next = vi.fn();
  async function request(path: string, body: unknown = {}, headers = {}) {
    await relayBoundWorkspace({ url: path, method: 'POST', headers, body } as Request, response as unknown as Response, next);
  }
  return { request, authenticate, synchronize, pending, fetch, response, next, chunks };
}

describe('learning writes through the authoritative workspace relay', () => {
  it('exempts only the exact owner item retirement endpoint from unrelated task synchronization', async () => {
    const test = setup();
    await test.request('/api/v1/learning/practice/items/item/archive', { requestId: 'archive', questionVersionId: 'version' });
    expect(test.fetch).toHaveBeenCalledOnce(); expect(test.synchronize).not.toHaveBeenCalled();
    test.fetch.mockClear();
    await test.request('/api/v1/learning/practice/items/item/archive/extra');
    expect(test.fetch).not.toHaveBeenCalled(); expect(test.synchronize).toHaveBeenCalledOnce();
    expect(test.next).toHaveBeenCalledWith(expect.objectContaining({ code: 'SYNC_PENDING' }));
  });
  it('forwards a native answer while an unrelated task outbox is pending', async () => {
    const test = setup();
    const body = { requestId: 'native-submit', activeAttemptId: 'attempt', questionVersionId: 'version', answer: 'A' };
    await test.request('/api/v1/learning/practice/items/item/submit', body);
    expect(test.authenticate).toHaveBeenCalledOnce();
    expect(test.synchronize).not.toHaveBeenCalled();
    expect(test.pending).not.toHaveBeenCalled();
    expect(test.fetch).toHaveBeenCalledOnce();
    const [url, options] = test.fetch.mock.calls[0];
    expect(String(url)).toBe('https://learning-test.invalid/api/v1/sync/relay/api/v1/learning/practice/items/item/submit');
    expect(JSON.parse(options.body)).toEqual(body);
    expect(options.headers.get('x-dovun-workspace-id')).toBe('workspace-test');
    expect(test.next).not.toHaveBeenCalled();
    expect(JSON.parse(Buffer.concat(test.chunks).toString())).toMatchObject({ data: { status: 'applied' } });
  });

  it('still waits for task synchronization on generic or mixed command batches', async () => {
    const test = setup();
    await test.request('/api/v1/commands', { commands: [
      { kind: 'learning.practice.request', input: { mapId: 'map' } },
      { kind: 'task.update', targetId: 'task', expectedRevision: 1, input: { title: 'changed' } },
    ] });
    expect(test.synchronize).toHaveBeenCalledOnce();
    expect(test.pending).toHaveBeenCalledOnce();
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.next).toHaveBeenCalledWith(expect.objectContaining({ code: 'SYNC_PENDING' }));
  });

  it('does not bypass owner authentication even on an independent learning endpoint', async () => {
    const test = setup();
    test.authenticate.mockRejectedValue(new DomainError('UNAUTHORIZED', '需要登录', 401));
    await test.request('/api/v1/learning/practice/generate');
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('preserves a connection credential instead of upgrading it to replica owner authority', async () => {
    const test = setup();
    test.fetch.mockResolvedValue(new globalThis.Response(JSON.stringify({ code: 'SCOPE_DENIED' }), { status: 403, headers: { 'content-type': 'application/json' } }));
    await test.request('/api/v1/learning/practice/generate', {}, { authorization: 'Bearer test-only-connection-token' });
    const [url, options] = test.fetch.mock.calls[0];
    expect(String(url)).toBe('https://learning-test.invalid/api/v1/learning/practice/generate');
    expect(options.headers.get('authorization')).toBe('Bearer test-only-connection-token');
    expect(test.authenticate).not.toHaveBeenCalled();
    expect(test.response.status).toHaveBeenCalledWith(403);
  });
});
