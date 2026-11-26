import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import { z } from 'zod';

import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import ownerRequest, { ownerSession } from './test-auth.js';
import { NodeAgent } from './node-agent/agent.js';
import * as openCode from './node-agent/harness-opencode-client.js';
import * as runtimes from './node-agent/harness-runtimes.js';
import * as dsh from './node-agent/harness-dsh-client.js';
import * as kimi from './node-agent/harness-kimi-client.js';
import { capabilitiesSchema } from './node-agent/protocol.js';
import {
  HARNESS_ADAPTERS_FEATURE, HARNESS_DSH_FEATURE, HARNESS_KIMI_FEATURE, HARNESS_EVENTS, HARNESS_FEATURE, HARNESS_IMAGE_FILE_LIMIT, HARNESS_LARGE_IMAGES_FEATURE, HARNESS_LIBRARY_FEATURE,
  HARNESS_LEGACY_IMAGE_LIMIT, HARNESS_PREVIEW_FILE_LIMIT, HARNESS_WORKSPACE_FEATURE, HARNESS_ZCODE_LIVE_FEATURE, harnessCommandSchema, type HarnessSnapshot,
} from './node-agent/harness-protocol.js';
import { leaseHarnessLibrary } from './application/harness-sessions.js';
import { codexInput, readHarnessFiles } from './node-agent/harness-files.js';
import { DIRECTORY_FEATURE } from './node-agent/directory-protocol.js';
import { writeSession } from '../test/dsh-fixtures.mjs';

const base = '/api/v1/harness-sessions';
const savedEnv = { ...process.env };
const agents: NodeAgent[] = [];
const nodeIds: string[] = [];
let folder: string;
let origin: string;
let server: Server;
let projectId: string;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'dovun-harness-test-'));
  process.env.CODEX_HOME = join(folder, 'codex-home');
  process.env.DOVUN_CODEX_BIN = fileURLToPath(new URL('../test/stub-harness-codex.mjs', import.meta.url));
  process.env.HARNESS_TEST_CALLS = join(folder, 'calls');
  process.env.HARNESS_TEST_HISTORY = join(folder, 'history.json');
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await Promise.all(agents.map((agent) => agent.shutdown('signal')));
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.harnessSession.deleteMany({ where: { nodeId: { in: nodeIds } } });
  await prisma.harnessDirectory.deleteMany({ where: { nodeId: { in: nodeIds } } });
  if (projectId) {
    await prisma.projectLocation.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } });
  }
  await prisma.agentNode.deleteMany({ where: { id: { in: nodeIds } } });
  for (const key of ['CODEX_HOME', 'DOVUN_CODEX_BIN', 'DOVUN_RUNNER_DIR', 'HARNESS_TEST_CALLS', 'HARNESS_TEST_HISTORY', 'HARNESS_TEST_LIBRARY', 'HARNESS_TEST_TURNS']) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 3 });
});
function data<T = any>(result: { status: number; body: { data: T; error: unknown } }) {
  if (result.status !== 200) throw new Error(`HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body.data;
}
async function until(agent: NodeAgent, check: () => Promise<boolean>) {
  const end = Date.now() + 8_000;
  while (Date.now() < end) {
    await agent.pollOnce();
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Harness condition timed out');
}

it('keeps the 0.6.18 capability list on older relays and re-enables the installed kinds after upgrading', async () => {
  const oldCapabilities = capabilitiesSchema.extend({ harnessKinds: z.array(z.enum(['codex', 'claude', 'zcode'])).max(3).optional() });
  const legacy = [HARNESS_FEATURE, HARNESS_LIBRARY_FEATURE, HARNESS_WORKSPACE_FEATURE];
  let accepts: string[] = legacy;
  let kinds: string[] = [];
  let library = false;
  const node = new NodeAgent({ server: origin, token: 'fixture', roots: [folder], dataDir: join(folder, 'compatible-node') },
    async (_url, init) => {
      const capabilities = JSON.parse(init!.body as string).capabilities;
      kinds = capabilities.harnessKinds ?? [];
      library = capabilities.harnessLibrary === HARNESS_LIBRARY_FEATURE;
      return accepts === legacy && !oldCapabilities.safeParse(capabilities).success
        ? Response.json({ code: 'VALIDATION_ERROR' }, { status: 400 })
        : Response.json({ data: { accepts, jobs: [], cancel: [] } });
    });
  const code = vi.spyOn(openCode, 'opencodeAvailable').mockResolvedValue(true);
  const grok = vi.spyOn(runtimes, 'grokHarnessAvailable').mockResolvedValue({ path: 'fixture', version: '1.0.50' });
  const deepseek = vi.spyOn(dsh, 'dshAvailable').mockResolvedValue(true);
  const kimiCode = vi.spyOn(kimi, 'kimiAvailable').mockResolvedValue(true);
  try {
    await node.pollOnce();
    for (let poll = 0; poll < 3; poll++) {
      await node.pollOnce();
      expect(kinds).toContain('codex');
      expect(kinds).not.toContain('opencode');
      expect(kinds).not.toContain('grok');
      expect(library).toBe(true);
    }
    expect(code).not.toHaveBeenCalled();
    accepts = [...legacy, HARNESS_DSH_FEATURE];
    await node.pollOnce();
    await node.pollOnce();
    await node.pollOnce();
    expect(kinds).toEqual(expect.arrayContaining(['opencode', 'grok', 'dsh']));
    accepts = [...legacy, HARNESS_ADAPTERS_FEATURE];
    await node.pollOnce();
    await node.pollOnce();
    expect(kinds).toEqual(expect.arrayContaining(['opencode', 'grok', 'dsh']));
    expect(kinds).not.toContain('kimi');
    expect(kimiCode).not.toHaveBeenCalled();
    accepts = [...legacy, HARNESS_KIMI_FEATURE];
    await node.pollOnce();
    await node.pollOnce();
    expect(kinds).toContain('kimi');
    accepts = legacy;
    await expect(node.pollOnce()).rejects.toThrow('400');
    await node.pollOnce();
    await node.pollOnce();
    expect(library).toBe(true);
    expect(kinds).toContain('codex');
    expect(kinds).not.toContain('opencode');
    expect(kinds).not.toContain('kimi');
  } finally {
    code.mockRestore();
    grok.mockRestore();
    deepseek.mockRestore();
    kimiCode.mockRestore();
    await node.shutdown('signal');
  }
});

it('preserves one thread across browsers, receipt loss, an expired target and executor restart', async () => {
  const owner = ownerRequest(app);
  expect((await supertest(app).get(base)).status).toBe(401);
  const createNode = async (name: string) => {
    const result = data(await owner.post('/api/nodes').send({ name }));
    nodeIds.push(result.node.id);
    return result;
  };
  const first = await createNode('Harness computer');
  const other = await createNode('Other computer');
  const root = join(folder, 'repo');
  await mkdir(root);
  const project = await prisma.project.create({ data: { name: 'Harness project', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
  projectId = project.id;
  const location = await prisma.projectLocation.create({ data: {
    projectId, nodeId: first.node.id, path: root, status: 'verified', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } });
  const config = { server: origin, token: first.token, roots: [root], dataDir: join(folder, 'node'), maxConcurrent: 1 };
  const legacyFetch: typeof fetch = (url, init) => {
    const headers = new Headers(init?.headers);
    headers.delete('X-Dovun-Harness-Library');
    return fetch(url, { ...init, headers });
  };
  let dropReceipt = true;
  const fetchWithLoss: typeof fetch = async (url, init) => {
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (payload?.type === 'receipt' && payload.commandId === 'send-one' && dropReceipt) {
      dropReceipt = false;
      throw new Error('test lost receipt');
    }
    return legacyFetch(url, init);
  };
  let agent = new NodeAgent(config, fetchWithLoss);
  agents.push(agent);
  const create = { commandId: 'start-one', nodeId: first.node.id, locationId: location.id };
  await agent.pollOnce();
  expect((await owner.post(base).send(create)).status).toBe(409);
  await agent.pollOnce();
  const started = data(await owner.post(base).send(create));
  const url = `${base}/${started.sessionId}`;
  expect(data(await owner.get(base))).toMatchObject({
    harnesses: [{ id: 'codex', name: 'Codex' }],
    sessions: expect.arrayContaining([expect.objectContaining({ id: started.sessionId, harness: 'codex', title: null })]),
  });
  expect(data(await owner.post(base).send(create)).sessionId).toBe(started.sessionId);
  expect((await owner.post(base).send({ ...create, commandId: 'start-two' })).status).toBe(409);
  const view = async () => data<{ snapshot: HarnessSnapshot; online: boolean }>(await owner.get(url));
  const receipt = async (commandId: string) => data(await owner.get(`${url}/commands/${commandId}`));
  await until(agent, async () => (await receipt('start-one')).status === 'accepted');
  expect((await view()).snapshot.threadId).toBe('fixture-thread');
  const epoch = (await view()).snapshot.epoch;

  await supertest(app).post(`/api/v1/node/harness-sessions/${started.sessionId}/sync`).set('Authorization', `Node ${other.token}`)
    .send({ type: 'receipt', commandId: 'start-one', status: 'accepted' }).expect(403);
  const startTurn = { commandId: 'send-one', expectedEpoch: epoch, operation: 'send', text: 'from computer' };
  data(await owner.post(`${url}/commands`).send(startTurn));
  expect((await owner.post(`${url}/commands`).send({ ...startTurn, text: 'changed' })).status).toBe(409);
  await until(agent, async () => (await receipt('send-one')).status === 'accepted' && !!(await view()).snapshot.view.turn);
  expect(data(await owner.get(base)).sessions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: started.sessionId, title: 'from computer', activity: 'running' }),
  ]));
  expect(data(await owner.get(url)).title).toBe('from computer');
  expect(dropReceipt).toBe(false);
  expect((await readFile(process.env.HARNESS_TEST_CALLS!, 'utf8')).match(/^turn\/start$/gm)).toHaveLength(1);
  const firstTurn = (await view()).snapshot.view.turn!;
  const beforeSteer = (await view()).snapshot.seq;
  const steer = { commandId: 'steer-one', expectedEpoch: epoch, operation: 'steer', turnId: firstTurn.id, text: 'from phone' };
  data(await owner.post(`${url}/commands`).send(steer));
  await until(agent, async () => (await receipt(steer.commandId)).status === 'accepted');
  const identity = await ownerSession(app);
  const abort = new AbortController();
  const events = await fetch(`${origin}${url}/events?after=${epoch}:${beforeSteer}`, { headers: { Cookie: identity.cookie }, signal: abort.signal });
  expect(events.headers.get('content-type')).toContain('text/event-stream');
  const reader = events.body!.getReader();
  const chunks = new TextDecoder();
  let replay = '';
  try {
    while (!replay.includes('caughtUp')) replay += chunks.decode((await reader.read()).value);
    expect(replay).toContain('from phone');
    expect(replay).not.toContain('"type":"snapshot"');
  } finally { abort.abort(); }

  const fill = { ...steer, commandId: 'fill-cache', text: 'fill event cache' };
  data(await owner.post(`${url}/commands`).send(fill));
  await until(agent, async () => (await view()).snapshot.seq > beforeSteer + HARNESS_EVENTS);
  const snapshotAbort = new AbortController();
  const oldCursor = await fetch(`${origin}${url}/events?after=${epoch}:${beforeSteer}`, {
    headers: { Cookie: identity.cookie }, signal: snapshotAbort.signal,
  });
  try {
    const body = oldCursor.body!.getReader();
    const decoder = new TextDecoder();
    let frames = '';
    const stream = (async () => {
      while (!frames.includes('"type":"snapshot"')) {
        const chunk = await body.read();
        if (chunk.done) return;
        frames += decoder.decode(chunk.value, { stream: true });
      }
    })();
    void stream.catch(() => undefined);
    await until(agent, async () => frames.includes('"type":"snapshot"'));
    expect(frames).toContain('fill event cache');
  } finally { snapshotAbort.abort(); }

  data(await owner.post(`${url}/commands`).send({ commandId: 'stop-one', expectedEpoch: epoch, operation: 'interrupt', turnId: firstTurn.id }));
  await until(agent, async () => (await view()).snapshot.view.turn?.status === 'interrupted');
  data(await owner.post(`${url}/commands`).send({ commandId: 'send-two', expectedEpoch: epoch, operation: 'send', text: 'permission' }));
  await until(agent, async () => !!(await view()).snapshot.view.approvals.length);
  const second = (await view()).snapshot.view;
  const approval = second.approvals[0];
  data(await owner.post(`${url}/commands`).send({ commandId: 'late-stop', expectedEpoch: epoch, operation: 'interrupt', turnId: firstTurn.id }));
  for (const [commandId, decision] of [['approve-one', 'accept'], ['approve-two', 'decline']]) {
    data(await owner.post(`${url}/commands`).send({ commandId, expectedEpoch: epoch, operation: 'resolveApproval', requestId: approval.id, decision }));
  }
  await until(agent, async () => (await receipt('approve-two')).status === 'rejected');
  expect((await receipt('late-stop')).status).toBe('rejected');
  expect((await receipt('approve-one')).status).toBe('accepted');
  expect((await view()).snapshot.view.turn?.status).toBe('completed');

  await agent.shutdown('signal');
  let revoked = 0;
  agent = new NodeAgent(config, fetch, { exit: (code) => { revoked = code; } });
  agents.push(agent);
  await until(agent, async () => (await view()).snapshot.epoch > epoch);
  const recovered = (await view()).snapshot;
  expect(recovered.threadId).toBe('fixture-thread');
  expect(recovered.view.messages.map((message) => message.text)).toContain('from phone');
  expect((await readFile(process.env.HARNESS_TEST_CALLS!, 'utf8')).match(/^thread\/start$/gm)).toHaveLength(1);
  expect((await readFile(process.env.HARNESS_TEST_CALLS!, 'utf8')).match(/^approval:/gm)).toHaveLength(1);

  data(await owner.post(`/api/nodes/${first.node.id}/revoke`));
  await expect(agent.pollOnce()).rejects.toThrow('401');
  expect(revoked).toBe(3);
  expect((await owner.post(`${url}/commands`).send({ ...startTurn, commandId: 'offline', expectedEpoch: recovered.epoch })).status).toBe(409);

  // Old-shaped clients retain their lease contract even on a server advertising the new feature.
  const token = other.token;
  const legacy = await fetch(`${origin}/api/v1/node/lease`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Node ${token}` },
    body: JSON.stringify({ max: 0, capabilities: { protocol: 1, providers: [] } }),
  });
  const response = (await legacy.json()).data;
  expect(response.accepts).not.toContain(HARNESS_FEATURE);
  expect(response.harness).toBeUndefined();
  expect(response.accepts).not.toContain(DIRECTORY_FEATURE);
  expect(response.directoryRequests).toBeUndefined();
  expect((await owner.post(base + '/directories/browse').send({ nodeId: other.node.id, path: null })).body.code).toBe('DIRECTORY_UNSUPPORTED');
}, 35_000);

it('accepts a directory listing only from the paired computer handling the request', async () => {
  const owner = ownerRequest(app);
  const target = data(await owner.post('/api/nodes').send({ name: 'Folder computer' }));
  const peer = data(await owner.post('/api/nodes').send({ name: 'Other folder computer' }));
  nodeIds.push(target.node.id, peer.node.id);
  const capabilities = { protocol: 2, providers: [], directoryBrowser: DIRECTORY_FEATURE };
  const lease = async (token: string) => data(await supertest(app).post('/api/v1/node/lease').set('Authorization', 'Node ' + token)
    .set('X-Dovun-Node-Features', HARNESS_FEATURE).set('X-Dovun-Directory-Browser', DIRECTORY_FEATURE).send({ capabilities, max: 0 }));
  await lease(target.token);
  const query = { nodeId: target.node.id, path: null };
  expect((await supertest(app).post(base + '/directories/browse').send(query)).status).toBe(401);
  const browsing = owner.post(base + '/directories/browse').send(query).then(data);
  let id: string | undefined;
  await expect.poll(async () => {
    id = (await lease(target.token)).directoryRequests?.[0]?.id;
    return Boolean(id);
  }).toBe(true);
  expect((await lease(peer.token)).directoryRequests).toBeUndefined();
  const reply = { page: { directory: null, parent: null, entries: [], truncated: false } };
  const url = '/api/v1/node/directories/' + id;
  expect((await supertest(app).post(url).set('Authorization', 'Node ' + peer.token).send(reply)).status).toBe(403);
  data(await supertest(app).post(url).set('Authorization', 'Node ' + target.token).send(reply));
  expect(await browsing).toEqual(reply.page);
  expect((await lease(target.token)).directoryRequests).toBeUndefined();
});

it('indexes approved projects and promotes a frozen queue exactly once before branching the original session', async () => {
  const owner = ownerRequest(app);
  const { node, token } = data(await owner.post('/api/nodes').send({ name: 'Workspace computer' }));
  nodeIds.push(node.id);
  const project = join(folder, 'indexed');
  const outside = join(folder, 'outside');
  const library = join(folder, 'codex-library');
  await Promise.all([mkdir(project), mkdir(outside), mkdir(library)]);
  const cwd = await realpath(project);
  const turns = join(folder, 'workspace-turns');
  process.env.HARNESS_TEST_LIBRARY = library;
  process.env.HARNESS_TEST_TURNS = turns;
  await writeFile(join(project, 'notes.txt'), 'Authorized file');
  await writeFile(join(outside, 'private.txt'), 'Outside project');
  await symlink(join(outside, 'private.txt'), join(project, 'outside.txt'));
  const date = new Date();
  await Promise.all([[cwd, 'allowed-thread'], [outside, 'outside-thread']].map(([location, id]) =>
    writeFile(join(library, id + '.json'), JSON.stringify({
      thread: { id, cwd: location, name: id, updatedAt: Math.floor(date.getTime() / 1000) }, turns: [],
    }))));
  let loseReceipt = true;
  const http: typeof fetch = async (url, init) => {
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (payload?.type === 'receipt' && payload.commandId === 'queue-first' && loseReceipt) {
      loseReceipt = false;
      throw new Error('lost queue receipt');
    }
    return fetch(url, init);
  };
  const agent = new NodeAgent({ server: origin, token, roots: [project], dataDir: join(folder, 'workspace-node') }, http);
  agents.push(agent);
  await until(agent, async () => data(await owner.get(base)).nodes.find((entry: { id: string }) => entry.id === node.id)?.harnessWorkspace);
  async function fetchWhilePolling(request: PromiseLike<{ status: number; body: { data: any; error: unknown } }>) {
    let finished = false;
    const result = Promise.resolve(request).finally(() => { finished = true; });
    await until(agent, async () => finished);
    return result;
  }
  data(await fetchWhilePolling(owner.post(base + '/native/index').send({ nodeId: node.id })));
  const indexed = data(await owner.get(base)).sessions.filter((row: { nodeId: string }) => row.nodeId === node.id);
  expect(indexed).toHaveLength(1);
  expect(indexed[0]).toMatchObject({ projectName: 'indexed', threadId: 'allowed-thread', title: 'allowed-thread' });
  const { locationId } = indexed[0];
  const created = data(await owner.post(base).send({ nodeId: node.id, locationId, commandId: 'workspace-start' }));
  const url = base + '/' + created.sessionId;
  const detail = async (permissions = true) => data<{ snapshot: HarnessSnapshot }>(await owner.get(url + '?timeline=1&settings=1&workspace=1' + (permissions ? '&permissions=1' : '')));
  const receipt = async (id: string) => data(await owner.get(url + '/commands/' + id));
  await until(agent, async () => (await receipt('workspace-start')).status === 'accepted');
  const epoch = (await detail()).snapshot.epoch;
  const send = async (command: Record<string, unknown>) => owner.post(url + '/commands').send({ expectedEpoch: epoch, ...command });
  await send({ operation: 'send', commandId: 'workspace-running', text: 'hold turn' }).then(data);
  await until(agent, async () => Boolean((await detail()).snapshot.view.turn));
  const configure = { operation: 'configure', commandId: 'set-precise', expectedSettingsRevision: 0,
    changes: { model: 'fixture-precise', approvalPolicy: 'untrusted' } };
  await send(configure).then(data);
  await until(agent, async () => (await receipt('set-precise')).status === 'accepted');
  const input = { operation: 'enqueue', commandId: 'queue-first', text: '完成测试：queued', expectedSettingsRevision: 1,
    attachments: [{ kind: 'projectFile', path: 'notes.txt', name: 'notes.txt' }] };
  await send(input).then(data);
  await until(agent, async () => (await receipt('queue-first')).status === 'accepted');
  expect(loseReceipt).toBe(false);
  expect((await detail()).snapshot.view.queue?.items).toEqual([expect.objectContaining({
    id: 'queue-first', attachmentNames: ['notes.txt'], settings: expect.objectContaining({ model: 'fixture-precise', approvalPolicy: 'untrusted' }),
  })]);
  const legacy = (await detail(false)).snapshot.view;
  expect(legacy.settings?.approvalPolicies).toBeUndefined();
  expect(legacy.queue?.items[0].settings?.approvalPolicy).toBeUndefined();
  expect((await send({ operation: 'removeQueued', commandId: 'stale-queue', itemId: 'queue-first', expectedQueueRevision: 0 })).status).toBe(409);
  await send({ ...configure, commandId: 'reset-model', expectedSettingsRevision: 1,
    changes: { model: 'fixture-default', approvalPolicy: 'on-request' } }).then(data);
  await until(agent, async () => (await receipt('reset-model')).status === 'accepted');
  const revision = (await detail()).snapshot.view.queue!.revision;
  await send({ operation: 'sendQueuedNow', commandId: 'promote', itemId: 'queue-first', expectedQueueRevision: revision }).then(data);
  await until(agent, async () => (await detail()).snapshot.view.turn?.status === 'completed' && !(await detail()).snapshot.view.queue?.items.length);
  const recorded = (await readFile(turns, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((call) => call.clientUserMessageId === 'queue-first');
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ model: 'fixture-precise', approvalPolicy: 'untrusted',
    input: [{ type: 'text', text: input.text }, expect.objectContaining({ text: expect.stringContaining('notes.txt') })] });
  expect((await detail()).snapshot.view.messages.find((item) => item.id === 'queue-first')).toMatchObject({ text: input.text, attachmentNames: ['notes.txt'] });
  const turnId = (await detail()).snapshot.view.turn!.id;
  await send({ operation: 'fork', commandId: 'branch', turnId }).then(data);
  await until(agent, async () => (await receipt('branch')).status === 'accepted');
  const branchId = (await receipt('branch')).resultSessionId;
  expect(data(await owner.get(base + '/' + branchId))).toMatchObject({ sourceSessionId: created.sessionId, sourceTurnId: turnId });
  expect(data(await owner.get(base + '/' + branchId)).threadId).not.toBe((await detail()).snapshot.threadId);
  expect(data(await fetchWhilePolling(owner.post(url + '/files').send({ path: 'notes.txt', preview: true })))).toMatchObject({ content: 'Authorized file' });
  expect((await fetchWhilePolling(owner.post(url + '/files').send({ path: 'outside.txt', preview: true }))).status).toBe(409);

  data(await owner.patch(url).send({ title: 'Renamed workspace chat', archived: true, pinned: true }));
  expect(data(await owner.get(base + '?archived=1')).sessions).toContainEqual(expect.objectContaining({ id: created.sessionId, title: 'Renamed workspace chat', pinned: true }));
  expect(data(await owner.get(base)).sessions).not.toContainEqual(expect.objectContaining({ id: created.sessionId }));

  const timestamp = date.toISOString();
  await prisma.harnessSession.createMany({ data: Array.from({ length: 105 }, (_, index) => ({
    nodeId: node.id, locationId, projectName: 'indexed', status: 'stored', cwd,
    startCommandId: 'paged-start-' + index, threadId: 'paged-thread-' + index,
    createdAt: timestamp, updatedAt: timestamp, library: true,
  })) });
  const filter = base + '?locationId=' + encodeURIComponent(locationId);
  const firstPage = data(await owner.get(filter));
  const secondPage = data(await owner.get(filter + '&cursor=' + encodeURIComponent(firstPage.nextCursor)));
  expect(firstPage.sessions).toHaveLength(100);
  expect(secondPage.nextCursor).toBeNull();
  expect(new Set([...firstPage.sessions, ...secondPage.sessions].map((row) => row.id)).size).toBe(107);
}, 25_000);

it('imports old native pins, group changes and archive moves without changing the Dovun session ID', async () => {
  const owner = ownerRequest(app);
  const { node, token } = data(await owner.post('/api/nodes').send({ name: 'Native organization computer' }));
  nodeIds.push(node.id);
  const basePath = await realpath(folder);
  const cwd = join(basePath, 'organized-project');
  const outside = join(basePath, 'unshared-project');
  const library = join(basePath, 'organized-library');
  const desktopState = join(process.env.CODEX_HOME!, '.codex-global-state.json');
  const previousLibrary = process.env.HARNESS_TEST_LIBRARY;
  await Promise.all([mkdir(cwd), mkdir(outside), mkdir(library), mkdir(process.env.CODEX_HOME!, { recursive: true })]);
  process.env.HARNESS_TEST_LIBRARY = library;
  const seedThread = (id: string, path: string, fields: Record<string, unknown>) => writeFile(join(library, id + '.json'), JSON.stringify({
    thread: { id, cwd: path, name: id, updatedAt: 1_700_000_000, ...fields }, turns: [],
  }));
  const first = 'organized-first';
  const second = 'organized-second';
  const group = { id: 'review-group', name: 'Review' };
  const project = { projectId: 'native-project', section: group };
  const writePins = (pinned: string[]) => writeFile(desktopState, JSON.stringify({ 'pinned-thread-ids': pinned, 'pinned-project-ids': ['native-project', 'hidden-project'] }));
  const agent = new NodeAgent({ server: origin, token, roots: [cwd], dataDir: join(folder, 'organized-node') });
  agents.push(agent);
  try {
    await Promise.all([
      seedThread(first, cwd, project), seedThread(second, cwd, { ...project, updatedAt: 1_700_000_001 }), writePins([first, second, 'hidden-0']),
      ...Array.from({ length: 30 }, (_, index) => seedThread('hidden-' + index, outside, { projectId: 'hidden-project', updatedAt: 1_700_000_010 })),
    ]);
    await until(agent, async () => data(await owner.get(base)).nodes.find((entry: { id: string }) => entry.id === node.id)?.harnessOrganization);
    const index = async (archived = false) => {
      let settled = false;
      const request = Promise.resolve(owner.post(base + '/native/index').send({ nodeId: node.id, archived })).finally(() => { settled = true; });
      await until(agent, async () => settled);
      data(await request);
    };
    let locationId = '';
    const list = async (archived = false) => data(await owner.get(base + '?harness=codex' + (archived ? '&archived=1' : '') +
      (locationId ? '&locationId=' + encodeURIComponent(locationId) : '')));
    const rows = (page: { sessions: any[] }) => page.sessions.filter((row) => row.nodeId === node.id);
    await index();
    const initial = await list();
    expect(initial.projectPins).toContainEqual({ nodeId: node.id, cwd, order: 0 });
    expect(initial.projectPins.some((pin: { cwd: string }) => pin.cwd === outside)).toBe(false);
    expect(rows(initial).map((row) => row.threadId)).toEqual([first, second]);
    const [oldFirst, oldSecond] = rows(initial);
    locationId = oldFirst.locationId;
    expect(oldFirst).toMatchObject({ pinned: true, pinOrder: 0, organization: { group } });
    const secondUrl = base + '/' + oldSecond.id;
    data(await owner.patch(secondUrl).send({ pinned: false }));

    await Promise.all([seedThread(first, cwd, { ...project, section: null, archived: true }), writePins([second])]);
    await index();
    expect(rows(await list())).toEqual([expect.objectContaining({ id: oldSecond.id, pinned: false, organization: { pinned: true, pinOrder: 0, archived: false, group } })]);
    expect(rows(await list(true))).toEqual([expect.objectContaining({ id: oldFirst.id, pinned: false, archived: true,
      updatedAt: oldFirst.updatedAt, organization: { pinned: false, pinOrder: null, archived: true, group: null } })]);
    await seedThread(first, cwd, { ...project, section: { ...group, name: 'Renamed group' } });
    await index(true);
    expect(rows(await list(true))).toHaveLength(0);
    expect(rows(await list()).find((row) => row.id === oldFirst.id)).toMatchObject({ organization: { group: { name: 'Renamed group' } } });
  } finally {
    await agent.shutdown('signal');
    if (previousLibrary === undefined) delete process.env.HARNESS_TEST_LIBRARY; else process.env.HARNESS_TEST_LIBRARY = previousLibrary;
    await rm(desktopState, { force: true });
  }
}, 25_000);

it('indexes ZCode by project and resumes the native session without sending a duplicate', async () => {
  const owner = ownerRequest(app);
  const { node, token } = data(await owner.post('/api/nodes').send({ name: 'ZCode computer' }));
  nodeIds.push(node.id);
  const root = await realpath(folder);
  const cwd = join(root, 'zcode-project');
  const outside = await mkdtemp(join(tmpdir(), 'dovun-zcode-outside-'));
  const database = join(root, 'zcode-guard.db');
  const store = join(root, 'zcode-store.json');
  const oldId = 'sess_original_zcode';
  const env = { DOVUN_ZCODE_BIN: fileURLToPath(new URL('../test/stub-harness-zcode.mjs', import.meta.url)),
    ZCODE_SESSION_DB_PATH: database, HARNESS_TEST_ZCODE_STORE: store, ZCODE_DATA_BASE_DIR: root };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  const presence = new DatabaseSync(database);
  presence.exec('CREATE TABLE session_runtime_presence (session_id TEXT, process_id INTEGER)');
  presence.exec('CREATE TABLE session (id TEXT PRIMARY KEY, permission TEXT, time_deleted INTEGER)');
  presence.prepare('INSERT INTO session (id,permission) VALUES (?,?)').run(oldId, '{"mode":"plan"}');
  await mkdir(cwd);
  const sessions = [cwd, outside].map((path, index) => ({
    sessionId: index ? 'sess_outside_zcode' : oldId, workspace: { workspacePath: path, workspaceKey: path },
    title: index ? 'Outside project' : 'Existing ZCode conversation', updatedAt: Date.now(),
    rows: Array.from({ length: 45 }, (_, i) => ({
      rowId: i + 1, kind: 'userInput', turnId: 'original-' + i, entityId: 'history-' + i, text: 'Old ZCode message ' + i,
    })),
  }));
  await writeFile(store, JSON.stringify(sessions));
  let loseReceipt = true;
  const config = { server: origin, token, roots: [cwd], dataDir: join(folder, 'zcode-node') };
  const agent = new NodeAgent(config, async (url, init) => {
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (payload?.type === 'receipt' && payload.commandId === 'continue-zcode' && loseReceipt) {
      loseReceipt = false;
      throw new Error('test lost receipt');
    }
    const response = await fetch(url, init);
    if (typeof url !== 'string' || !url.endsWith('/lease') || !response.ok) return response;
    // Keep exercising the history and CLI fallback on servers without interactive ZCode settings.
    const lease = await response.json();
    lease.data.accepts = lease.data.accepts.filter((feature: string) => feature !== HARNESS_ZCODE_LIVE_FEATURE);
    return Response.json(lease);
  });
  agents.push(agent);
  async function whilePolling(request: PromiseLike<{ status: number; body: { data: any; error: unknown } }>) {
    let finished = false;
    const result = Promise.resolve(request).finally(() => { finished = true; });
    await until(agent, async () => finished);
    return data(await result);
  }
  try {
    await until(agent, async () => data(await owner.get(base)).nodes.find((row: { id: string }) => row.id === node.id)?.harnesses.includes('zcode'));
    await whilePolling(owner.post(base + '/native/index').send({ nodeId: node.id, harness: 'zcode' }));
    const listed = data(await owner.get(base + '?harness=zcode'));
    const indexed = listed.sessions.filter(({ nodeId }: { nodeId: string }) => nodeId === node.id);
    expect(indexed).toMatchObject([{ harness: 'zcode', threadId: oldId, projectName: 'zcode-project' }]);
    const id = indexed[0].id;
    const url = base + '/' + id;
    const latest = await whilePolling(owner.post(url + '/history').send({}));
    expect(latest.view.messages.at(-1).text).toBe('Old ZCode message 44');
    const earlier = await whilePolling(owner.post(url + '/history').send({ cursor: latest.nextCursor }));
    expect(earlier.view.messages[0].text).toBe('Old ZCode message 0');
    const detail = async () => data(await owner.get(url + '?timeline=1&settings=1&workspace=1'));
    // Opening the same native thread through the project catalog keeps the original Dovun conversation.
    expect(await whilePolling(owner.post(base + '/native/open').send({ nodeId: node.id, locationId: indexed[0].locationId, threadId: oldId, harness: 'zcode' })))
      .toMatchObject({ sessionId: id });
    const auth = await ownerSession(app);
    const stream = await fetch(origin + url + '/events?timeline=1', {
      headers: { Cookie: auth.cookie }, signal: AbortSignal.timeout(12_000),
    });
    const reader = stream.body!.getReader();
    try {
      await until(agent, async () => Boolean((await detail()).snapshot));
      const expectedEpoch = (await detail()).snapshot.epoch;
      const send = (commandId: string, text: string) => ({ expectedEpoch, commandId, operation: 'send', text });
      const unconnected = send('zcode-with-desktop-controls', 'Do not send with unavailable desktop controls');
      expect((await owner.post(url + '/commands').send({ ...unconnected, expectedSettingsRevision: 0 })).status).toBe(409);
      expect((await owner.post(url + '/commands').send({ ...unconnected,
        attachments: [{ kind: 'textFile', name: 'fixture.txt', content: 'fixture' }],
      })).status).toBe(409);
      presence.prepare('INSERT INTO session_runtime_presence VALUES (?, ?)').run(oldId, process.pid);
      data(await owner.post(url + '/commands').send(send('zcode-open-on-mac', 'Do not send while open')));
      const receipt = (commandId: string) => owner.get(url + '/commands/' + commandId).then(data);
      await until(agent, async () => (await receipt('zcode-open-on-mac')).status === 'rejected');
      expect((await receipt('zcode-open-on-mac')).error).toMatch(/ZCode/);
      presence.prepare('DELETE FROM session_runtime_presence WHERE session_id=?').run(oldId);
      const command = send('continue-zcode', 'Continue the original chat');
      data(await owner.post(url + '/commands').send(command));
      await until(agent, async () => (await receipt('continue-zcode')).status === 'accepted');
      data(await owner.post(url + '/commands').send(command));
      await until(agent, async () => {
        const turn = (await detail()).snapshot?.view.turn;
        return turn?.status === 'completed' && turn.id.startsWith('stored-');
      });
      expect(loseReceipt).toBe(false);
      const final = await detail();
      expect(final.threadId).toBe(oldId);
      expect(final.snapshot.view.turn.id).toMatch(/^stored-/);
      expect(final.snapshot.view.messages.at(-1).text).toBe('ZCode remembers Old ZCode message 0 · Continue the original chat');
      const history = await whilePolling(owner.post(url + '/history').send({}));
      expect(history.view.messages.filter((row: { text: string }) => row.text === command.text)).toHaveLength(1);
      expect(JSON.parse(await readFile(store, 'utf8'))).toHaveLength(2);

      const approval = { id: 'zcode-request', turnId: final.snapshot.view.turn.id, kind: 'command', details: 'printf approval',
        canAccept: true, options: [{ id: 'allowOnce', scope: 'once' }, { id: 'deny', scope: 'deny' }] };
      data(await supertest(app).post(`/api/v1/node/harness-sessions/${id}/sync`)
        .set('Authorization', 'Node ' + token).send({ ...final.snapshot, seq: final.snapshot.seq + 1,
          view: { ...final.snapshot.view, approvals: [approval] } }));
      const choose = { operation: 'choosePermission', expectedEpoch, commandId: 'native-approval', requestId: approval.id, optionId: 'allowOnce' };
      expect((await owner.post(url + '/commands').send(choose)).status).toBe(409);
      const known = await prisma.agentNode.findUniqueOrThrow({ where: { id: node.id } });
      await prisma.agentNode.update({ where: { id: node.id }, data: { capabilitiesJson: JSON.stringify({
        ...JSON.parse(known.capabilitiesJson), harnessZCodeLive: HARNESS_ZCODE_LIVE_FEATURE,
      }) } });
      expect((await detail()).snapshot.view.approvals).toEqual([]);
      expect(data(await owner.get(url + '?timeline=1&permissions=1')).snapshot.view.approvals).toEqual([approval]);
      expect((await owner.post(url + '/commands').send({ ...choose, optionId: 'allowSession' })).status).toBe(409);
      expect(data(await owner.post(url + '/commands').send(choose))).toMatchObject({ commandId: choose.commandId, status: 'queued' });
    } finally { await reader.cancel(); }
  } finally {
    await agent.shutdown('signal');
    presence.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(outside, { recursive: true, force: true });
  }
}, 25_000);

it('indexes OpenCode by project and resumes the native session without sending a duplicate', async () => {
  const owner = ownerRequest(app);
  const { node, token } = data(await owner.post('/api/nodes').send({ name: 'OpenCode computer' }));
  nodeIds.push(node.id);
  const root = await realpath(folder);
  const cwd = join(root, 'opencode-project');
  const outside = await mkdtemp(join(tmpdir(), 'dovun-opencode-outside-'));
  const store = join(root, 'opencode-store.json');
  const stubBin = fileURLToPath(new URL('../test/stub-opencode-service.mjs', import.meta.url));
  const oldId = 'ses_test_seed';
  await mkdir(cwd);
  await writeFile(store, JSON.stringify({ counters: { session: 2 }, sessions: [
    { id: oldId, title: 'Existing OpenCode conversation', agent: 'build', outcome: 'succeeded', running: false,
      model: { id: 'stub-model', providerID: 'opencode' }, location: { directory: cwd }, permissions: [],
      time: { created: 1, updated: 2 }, messages: [
        { id: 'user-old', type: 'user', text: 'Old OpenCode message', time: { created: 1 } },
        { id: 'assistant-old', type: 'assistant', content: [{ type: 'text', text: 'Old OpenCode answer' }], time: { created: 2 } },
        { id: 'idle-old', type: 'idle', outcome: 'succeeded', time: { created: 2 } },
      ] },
    { id: 'ses_test_outside', title: 'Outside project', agent: 'build', outcome: 'succeeded', running: false,
      model: { id: 'stub-model', providerID: 'opencode' }, location: { directory: outside }, permissions: [],
      time: { created: 1, updated: 2 }, messages: [] },
  ] }));
  const service = spawn(process.execPath, [stubBin, '--port=0'], {
    env: { ...process.env, HARNESS_TEST_OPENCODE_STORE: store }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve) => {
    service.stdout!.on('data', (chunk) => {
      const match = /"port":(\d+)/.exec(String(chunk));
      if (match) resolve(Number(match[1]));
    });
  });
  const previous = { OPENCODE_SERVICE_URL: process.env.OPENCODE_SERVICE_URL, OPENCODE_BIN: process.env.OPENCODE_BIN };
  process.env.OPENCODE_SERVICE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENCODE_BIN = stubBin;
  let loseReceipt = true;
  const config = { server: origin, token, roots: [cwd], dataDir: join(folder, 'opencode-node') };
  const agent = new NodeAgent(config, async (url, init) => {
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (payload?.type === 'receipt' && payload.commandId === 'continue-opencode' && loseReceipt) {
      loseReceipt = false;
      throw new Error('test lost receipt');
    }
    return fetch(url, init);
  });
  agents.push(agent);
  async function whilePolling(request: PromiseLike<{ status: number; body: { data: any; error: unknown } }>) {
    let finished = false;
    const result = Promise.resolve(request).finally(() => { finished = true; });
    await until(agent, async () => finished);
    return data(await result);
  }
  try {
    await until(agent, async () => data(await owner.get(base)).nodes.find((row: { id: string }) => row.id === node.id)?.harnesses.includes('opencode'));
    await whilePolling(owner.post(base + '/native/index').send({ nodeId: node.id, harness: 'opencode' }));
    const listed = data(await owner.get(base + '?harness=opencode'));
    const indexed = listed.sessions.filter(({ nodeId }: { nodeId: string }) => nodeId === node.id);
    expect(indexed).toMatchObject([{ harness: 'opencode', threadId: oldId, title: 'Existing OpenCode conversation', projectName: 'opencode-project' }]);
    const id = indexed[0].id;
    const url = base + '/' + id;
    const latest = await whilePolling(owner.post(url + '/history').send({}));
    expect(latest.view.messages.map((row: { text: string }) => row.text)).toEqual(['Old OpenCode message', 'Old OpenCode answer']);
    // Opening the same native thread through the project catalog keeps the original Dovun conversation.
    expect(await whilePolling(owner.post(base + '/native/open').send({ nodeId: node.id, locationId: indexed[0].locationId, threadId: oldId, harness: 'opencode' })))
      .toMatchObject({ sessionId: id });
    const detail = async () => data(await owner.get(url + '?timeline=1&settings=1&workspace=1'));
    const auth = await ownerSession(app);
    const stream = await fetch(origin + url + '/events?timeline=1', {
      headers: { Cookie: auth.cookie }, signal: AbortSignal.timeout(12_000),
    });
    const reader = stream.body!.getReader();
    try {
      await until(agent, async () => Boolean((await detail()).snapshot));
      const expectedEpoch = (await detail()).snapshot.epoch;
      const command = { expectedEpoch, commandId: 'continue-opencode', operation: 'send', text: 'Continue the original chat' };
      const settings = (await detail()).snapshot.view.settings;
      expect((await owner.post(url + '/commands').send({ expectedEpoch, commandId: 'invalid-opencode-sandbox',
        operation: 'configure', expectedSettingsRevision: settings.revision, changes: { permission: 'readOnly' } })).status).toBe(409);
      data(await owner.post(url + '/commands').send(command));
      await until(agent, async () => (await owner.get(url + '/commands/' + command.commandId).then(data)).status === 'accepted');
      data(await owner.post(url + '/commands').send(command));
      await until(agent, async () => {
        const turn = (await detail()).snapshot?.view.turn;
        return turn?.status === 'completed' && turn.id === 'continue-opencode';
      });
      expect(loseReceipt).toBe(false);
      const final = await detail();
      expect(final.threadId).toBe(oldId);
      expect(final.snapshot.view.messages.at(-1).text).toBe('OpenCode stub 记得 Continue the original chat');
      const history = await whilePolling(owner.post(url + '/history').send({}));
      expect(history.view.messages.filter((row: { text: string }) => row.text === command.text)).toHaveLength(1);
      const state = JSON.parse(await readFile(store, 'utf8')) as { sessions: Array<{ messages: Array<Record<string, unknown>> }> };
      expect(state.sessions[0].messages.filter((message) => message.id === 'msg_continue-opencode')).toHaveLength(1);
    } finally { await reader.cancel(); }
  } finally {
    await agent.shutdown('signal');
    service.kill();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(outside, { recursive: true, force: true });
  }
}, 25_000);

it('indexes DSH by project and resumes the native session without sending a duplicate', async () => {
  const owner = ownerRequest(app);
  const { node, token } = data(await owner.post('/api/nodes').send({ name: 'DSH computer' }));
  nodeIds.push(node.id);
  const root = await realpath(folder);
  const cwd = join(root, 'dsh-project');
  const home = join(root, 'dsh-home');
  const oldId = 'session-dsh-seed';
  await mkdir(cwd);
  // A conversation the DSH desktop app wrote earlier, kept in its own on-disk layout.
  const at = Date.now();
  await writeSession(home, { cwd, id: oldId, title: 'Existing DSH conversation', lastPromptAt: at, records: [
    { type: 'session', version: 4, id: oldId, createdAt: at - 1_000, cwd, isSeeded: false, delegationDepth: 0 },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Old DSH message' }], source: { kind: 'user' }, role: 'user', id: 'user-old' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'assistant-old', role: 'assistant', content: [{ type: 'text', text: 'Old DSH answer' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ] });
  const names = ['DOVUN_DSH_BIN', 'DSH_HOME', 'HARNESS_TEST_DSH_STORE'] as const;
  const previous = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  process.env.DOVUN_DSH_BIN = fileURLToPath(new URL('../test/stub-dsh-acp.mjs', import.meta.url));
  process.env.DSH_HOME = home;
  process.env.HARNESS_TEST_DSH_STORE = join(root, 'dsh-store.json');
  let loseReceipt = true;
  const config = { server: origin, token, roots: [cwd], dataDir: join(folder, 'dsh-node') };
  const agent = new NodeAgent(config, async (url, init) => {
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (payload?.type === 'receipt' && payload.commandId === 'continue-dsh' && loseReceipt) {
      loseReceipt = false;
      throw new Error('test lost receipt');
    }
    return fetch(url, init);
  });
  agents.push(agent);
  async function whilePolling(request: PromiseLike<{ status: number; body: { data: any; error: unknown } }>) {
    let finished = false;
    const result = Promise.resolve(request).finally(() => { finished = true; });
    await until(agent, async () => finished);
    return data(await result);
  }
  try {
    // The kind is reported only after the server accepted the DSH feature for this executor.
    await until(agent, async () => data(await owner.get(base)).nodes.find((row: { id: string }) => row.id === node.id)?.harnesses.includes('dsh'));
    await whilePolling(owner.post(base + '/native/index').send({ nodeId: node.id, harness: 'dsh' }));
    const listed = data(await owner.get(base + '?harness=dsh'));
    const indexed = listed.sessions.filter(({ nodeId }: { nodeId: string }) => nodeId === node.id);
    expect(indexed).toMatchObject([{ harness: 'dsh', threadId: oldId, title: 'Existing DSH conversation', projectName: 'dsh-project',
      settingsAvailable: true, workspaceAvailable: true }]);
    const id = indexed[0].id;
    const url = base + '/' + id;
    const latest = await whilePolling(owner.post(url + '/history').send({}));
    expect(latest.view.messages.map((row: { text: string }) => row.text)).toEqual(['Old DSH message', 'Old DSH answer']);
    // Opening the same native thread through the project catalog keeps the original Dovun conversation.
    expect(await whilePolling(owner.post(base + '/native/open').send({ nodeId: node.id, locationId: indexed[0].locationId, threadId: oldId, harness: 'dsh' })))
      .toMatchObject({ sessionId: id });
    const detail = async () => data(await owner.get(url + '?timeline=1&settings=1&workspace=1&permissions=1'));
    const auth = await ownerSession(app);
    const stream = await fetch(origin + url + '/events?timeline=1', {
      headers: { Cookie: auth.cookie }, signal: AbortSignal.timeout(12_000),
    });
    const reader = stream.body!.getReader();
    try {
      await until(agent, async () => Boolean((await detail()).snapshot));
      // The bridge plugin joined this launch, so presets can be chosen; full access waits for the advanced flag.
      expect((await detail()).snapshot.view.settings).toMatchObject({ planAvailable: false, sandboxChoices: ['readOnly', 'workspace'] });
      const expectedEpoch = (await detail()).snapshot.epoch;
      const command = { expectedEpoch, commandId: 'continue-dsh', operation: 'send', text: 'Continue the original chat' };
      data(await owner.post(url + '/commands').send(command));
      await until(agent, async () => (await owner.get(url + '/commands/' + command.commandId).then(data)).status === 'accepted');
      data(await owner.post(url + '/commands').send(command));
      await until(agent, async () => {
        const turn = (await detail()).snapshot?.view.turn;
        return turn?.status === 'completed' && turn.id === 'continue-dsh';
      });
      expect(loseReceipt).toBe(false);
      const final = await detail();
      expect(final.threadId).toBe(oldId);
      expect(final.snapshot.view.messages.at(-1).text).toBe('DSH stub 记得 Continue the original chat');
      const history = await whilePolling(owner.post(url + '/history').send({}));
      expect(history.view.messages.filter((row: { text: string }) => row.text === command.text)).toHaveLength(1);
    } finally { await reader.cancel(); }
  } finally {
    await agent.shutdown('signal');
    for (const key of names) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}, 25_000);

it('separates image uploads from preview limits and bounds batched Mac delivery', async () => {
  const owner = ownerRequest(app);
  const { node } = data(await owner.post('/api/nodes').send({ name: 'Image upload executor' }));
  nodeIds.push(node.id);
  const root = await realpath(await mkdtemp(join(folder, 'images-')));
  const png = Buffer.alloc(HARNESS_IMAGE_FILE_LIMIT);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  await writeFile(join(root, 'wide.png'), png.subarray(0, HARNESS_PREVIEW_FILE_LIMIT + 1));
  await expect(readHarnessFiles(root, 'wide.png', true)).rejects.toThrow('256 KB');
  const image = (bytes: Buffer, name = 'wide.png') => ({ kind: 'imageFile' as const, mediaType: 'image/png' as const, name, content: bytes.toString('base64') });
  const attachments = [image(png), image(png, 'second.png')];
  const send = (commandId: string, files = attachments) => ({ operation: 'send', commandId, text: 'Image prompt', expectedEpoch: 1, attachments: files });
  expect(harnessCommandSchema.safeParse(send('valid')).success).toBe(true);
  expect(harnessCommandSchema.safeParse(send('over', [image(Buffer.concat([png, Buffer.of(0)]))])).success).toBe(false);
  expect(harnessCommandSchema.safeParse(send('third', [...attachments, image(png)])).success).toBe(false);
  expect((await codexInput(root, 'Image prompt', attachments)).filter((part) => part.type === 'image')).toHaveLength(2);

  const baseCapabilities = { harnessSessions: HARNESS_FEATURE, harnessLibrary: HARNESS_LIBRARY_FEATURE, harnessWorkspace: HARNESS_WORKSPACE_FEATURE, harnessKinds: ['codex'] };
  let executor = await prisma.agentNode.update({ where: { id: node.id }, data: { lastSeenAt: new Date().toISOString(), capabilitiesJson: JSON.stringify(baseCapabilities) } });
  const session = async (id: string, createdAt: string) => prisma.harnessSession.create({ data: {
    id, nodeId: node.id, activeNodeId: node.id, locationId: id, startCommandId: id, projectName: 'Images',
    threadId: id, cwd: root, library: true, epoch: 1, status: 'ready', createdAt, updatedAt: createdAt,
  } });
  const earlier = await session('image-batch-earlier', '2026-01-01T00:00:01.000Z');
  const later = await session('image-batch-later', '2026-01-01T00:00:02.000Z');
  expect(data(await owner.get(base + '/' + earlier.id)).attachmentImageLimit).toBe(HARNESS_LEGACY_IMAGE_LIMIT);
  expect((await owner.post(base + '/' + earlier.id + '/commands').send(send('old-executor'))).body.code).toBe('HARNESS_IMAGE_LIMIT');

  executor = await prisma.agentNode.update({ where: { id: node.id }, data: {
    capabilitiesJson: JSON.stringify({ ...baseCapabilities, harnessLargeImages: HARNESS_LARGE_IMAGES_FEATURE }),
  } });
  expect(data(await owner.get(base + '/' + earlier.id)).attachmentImageLimit).toBe(HARNESS_IMAGE_FILE_LIMIT);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const small = send('small-image', [image(png.subarray(0, 128))]);
  await prisma.harnessCommand.createMany({ data: [
    { sessionId: earlier.id, commandId: 'first-large', payload: JSON.stringify(send('first-large')), createdAt, expiresAt },
    { sessionId: later.id, commandId: 'second-large', payload: JSON.stringify(send('second-large')), createdAt, expiresAt },
    { sessionId: later.id, commandId: small.commandId, payload: JSON.stringify(small), createdAt: new Date(Date.now() + 10).toISOString(), expiresAt },
  ] });
  const leasedIds = async () => (await leaseHarnessLibrary(node.id, executor.tokenHash)).flatMap((lease) => lease.commands.map(({ command }) => command.commandId));
  expect(await leasedIds()).toEqual(['first-large']);
  expect(await leasedIds()).toEqual(['first-large']);
  await prisma.harnessCommand.update({ where: { sessionId_commandId: { sessionId: earlier.id, commandId: 'first-large' } }, data: { status: 'accepted' } });
  expect(data(await owner.get(base + '/' + earlier.id)).title).toBe('Image prompt');
  expect(await leasedIds()).toEqual(['second-large', small.commandId]);

  await prisma.agentNode.update({ where: { id: node.id }, data: { capabilitiesJson: JSON.stringify(baseCapabilities) } });
  expect(await leasedIds()).toEqual([small.commandId]);
}, 20_000);
