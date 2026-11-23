import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import supertest from 'supertest';

import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import ownerRequest, { ownerSession } from './test-auth.js';
import { NodeAgent } from './node-agent/agent.js';
import { HARNESS_EVENTS, HARNESS_FEATURE, type HarnessSnapshot } from './node-agent/harness-protocol.js';
import { DIRECTORY_FEATURE } from './node-agent/directory-protocol.js';

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
  const detail = async () => data<{ snapshot: HarnessSnapshot }>(await owner.get(url + '?timeline=1&settings=1&workspace=1'));
  const receipt = async (id: string) => data(await owner.get(url + '/commands/' + id));
  await until(agent, async () => (await receipt('workspace-start')).status === 'accepted');
  const epoch = (await detail()).snapshot.epoch;
  const send = async (command: Record<string, unknown>) => owner.post(url + '/commands').send({ expectedEpoch: epoch, ...command });
  await send({ operation: 'send', commandId: 'workspace-running', text: 'hold turn' }).then(data);
  await until(agent, async () => Boolean((await detail()).snapshot.view.turn));
  const configure = { operation: 'configure', commandId: 'set-precise', expectedSettingsRevision: 0, changes: { model: 'fixture-precise' } };
  await send(configure).then(data);
  await until(agent, async () => (await receipt('set-precise')).status === 'accepted');
  const input = { operation: 'enqueue', commandId: 'queue-first', text: '完成测试：queued', expectedSettingsRevision: 1,
    attachments: [{ kind: 'projectFile', path: 'notes.txt', name: 'notes.txt' }] };
  await send(input).then(data);
  await until(agent, async () => (await receipt('queue-first')).status === 'accepted');
  expect(loseReceipt).toBe(false);
  expect((await detail()).snapshot.view.queue?.items).toEqual([expect.objectContaining({
    id: 'queue-first', attachmentNames: ['notes.txt'], settings: expect.objectContaining({ model: 'fixture-precise' }),
  })]);
  expect((await send({ operation: 'removeQueued', commandId: 'stale-queue', itemId: 'queue-first', expectedQueueRevision: 0 })).status).toBe(409);
  await send({ ...configure, commandId: 'reset-model', expectedSettingsRevision: 1, changes: { model: 'fixture-default' } }).then(data);
  await until(agent, async () => (await receipt('reset-model')).status === 'accepted');
  const revision = (await detail()).snapshot.view.queue!.revision;
  await send({ operation: 'sendQueuedNow', commandId: 'promote', itemId: 'queue-first', expectedQueueRevision: revision }).then(data);
  await until(agent, async () => (await detail()).snapshot.view.turn?.status === 'completed' && !(await detail()).snapshot.view.queue?.items.length);
  const recorded = (await readFile(turns, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((call) => call.clientUserMessageId === 'queue-first');
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ model: 'fixture-precise', input: [{ type: 'text', text: input.text }, expect.objectContaining({ text: expect.stringContaining('notes.txt') })] });
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
