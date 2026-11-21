import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
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
  if (projectId) {
    await prisma.projectLocation.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } });
  }
  await prisma.agentNode.deleteMany({ where: { id: { in: nodeIds } } });
  for (const key of ['DOVUN_CODEX_BIN', 'DOVUN_RUNNER_DIR', 'HARNESS_TEST_CALLS', 'HARNESS_TEST_HISTORY']) {
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
  let dropReceipt = true;
  const fetchWithLoss: typeof fetch = async (url, init) => {
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (payload?.type === 'receipt' && payload.commandId === 'send-one' && dropReceipt) {
      dropReceipt = false;
      throw new Error('test lost receipt');
    }
    return fetch(url, init);
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
}, 35_000);
