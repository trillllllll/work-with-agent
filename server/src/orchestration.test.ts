import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import ownerRequest from './test-auth.js';
import { NodeAgent } from './node-agent/agent.js';
import { setOrchestratorModel, type OrchestratorModel } from './application/orchestration/planner.js';
import { tickAllOrchestrations, tickOrchestration } from './application/orchestration/service.js';

const stub = fileURLToPath(new URL('../test/stub-orchestration-cli.mjs', import.meta.url));
const previous = { runner: process.env.WWA_RUNNER_DIR, codex: process.env.WWA_CODEX_BIN, log: process.env.STUB_LOG };
let root = ''; let server: Server; let base = ''; let restoreModel: OrchestratorModel;
const created: { tasks: string[]; orchestrations: string[]; projects: string[]; nodes: string[] } = { tasks: [], orchestrations: [], projects: [], nodes: [] };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const owner = () => ownerRequest(app);
const data = (response: { status: number; body: { data: any; code?: string } }) => { if (response.status !== 200) throw new Error(`HTTP ${response.status} ${JSON.stringify(response.body)}`); return response.body.data; };

/** Fake orchestrator model: plans C after A, accepts every report, final satisfied. */
const model: OrchestratorModel = {
  async complete(messages) {
    const system = messages[0].content;
    const user = messages[1].content;
    if (system.includes('[编排计划]')) {
      const subtasks = JSON.parse(user.match(/子任务：(\[.*\])/)![1]) as Array<{ id: string; title: string }>;
      const a = subtasks.find((task) => task.title === 'Task A')!;
      return { text: '```json\n' + JSON.stringify({ goalCriteria: '三个文件都在', steps: subtasks.map((task) => ({ taskId: task.id, dependsOn: task.title === 'Task C' ? [a.id] : [], acceptanceCriteria: `${task.title} 文件存在`, rationale: 'test' })) }) + '\n```' };
    }
    if (system.includes('[编排最终验收]')) return { text: JSON.stringify({ satisfied: true, comment: '满足' }) };
    return { text: JSON.stringify({ decision: 'accept', comment: 'ok' }) };
  },
};

async function makeNode(name: string, roots: string[]) {
  const response = data(await owner().post('/api/nodes').send({ name }));
  created.nodes.push(response.node.id);
  const agent = new NodeAgent({ server: base, token: response.token, roots, dataDir: join(root, `node-${name}`), maxConcurrent: 3, pollMs: 50 });
  return { id: response.node.id as string, token: response.token as string, agent };
}
async function drive(agent: NodeAgent, until: () => Promise<boolean>, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await agent.pollOnce();
    await tickAllOrchestrations();
    if (await until()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('drive timeout');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wwa-orch-'));
  process.env.WWA_CODEX_BIN = stub;
  process.env.STUB_LOG = join(root, 'stub.log');
  restoreModel = setOrchestratorModel(model);
  server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  setOrchestratorModel(restoreModel);
  await new Promise((done) => server.close(done));
  await prisma.orchestrationEvent.deleteMany({ where: { orchestrationId: { in: created.orchestrations } } });
  await prisma.nodeJob.deleteMany({ where: { nodeId: { in: created.nodes } } });
  await prisma.orchestrationStep.deleteMany({ where: { orchestrationId: { in: created.orchestrations } } });
  await prisma.orchestration.deleteMany({ where: { id: { in: created.orchestrations } } });
  await prisma.projectBinding.deleteMany({ where: { projectId: { in: created.projects } } });
  await prisma.projectLocation.deleteMany({ where: { projectId: { in: created.projects } } });
  await prisma.project.deleteMany({ where: { id: { in: created.projects } } });
  await prisma.agentNode.deleteMany({ where: { id: { in: created.nodes } } });
  await prisma.changeRecord.deleteMany({ where: { entityId: { in: created.tasks } } }).catch(() => undefined);
  await prisma.task.deleteMany({ where: { parentId: { in: created.tasks } } });
  await prisma.task.deleteMany({ where: { id: { in: created.tasks } } });
  for (const [key, value] of Object.entries({ WWA_RUNNER_DIR: previous.runner, WWA_CODEX_BIN: previous.codex, STUB_LOG: previous.log })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
});

describe('orchestration through a local executor', () => {
  it('runs two parallel subtasks and one dependent subtask, merges serially, verifies independently and waits for acceptance', async () => {
    const code = join(root, 'code'); const repo = join(code, 'repo'); const remote = join(root, 'remote.git');
    await mkdir(repo, { recursive: true });
    git(root, 'init', '--bare', '-b', 'main', remote);
    git(repo, 'init', '-b', 'main'); await writeFile(join(repo, 'README.md'), '# demo\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'init'); git(repo, 'remote', 'add', 'origin', remote);
    const node = await makeNode('laptop', [code]);

    // Binding: the node verifies a path; a path outside its roots is refused locally.
    const project = data(await owner().post('/api/projects').send({ name: 'demo', defaultBranch: 'main', defaultProvider: 'codex' }));
    created.projects.push(project.id);
    const outside = await mkdtemp(join(tmpdir(), 'wwa-outside-')); git(outside, 'init', '-b', 'main');
    data(await owner().post(`/api/projects/${project.id}/locations`).send({ nodeId: node.id, path: outside }));
    await drive(node.agent, async () => (await prisma.projectLocation.findFirst({ where: { projectId: project.id } }))?.status !== 'pending', 15_000);
    await node.agent.idle(); await node.agent.pollOnce();
    expect((await prisma.projectLocation.findFirstOrThrow({ where: { projectId: project.id } })).error).toContain('PATH_NOT_ALLOWED');
    await rm(outside, { recursive: true, force: true });
    data(await owner().post(`/api/projects/${project.id}/locations`).send({ nodeId: node.id, path: repo }));
    await drive(node.agent, async () => (await prisma.projectLocation.findFirst({ where: { projectId: project.id } }))?.status === 'verified', 15_000);
    const location = await prisma.projectLocation.findFirstOrThrow({ where: { projectId: project.id } });
    expect(JSON.parse(location.fingerprintJson).branches).toContain('main');

    const topic = await prisma.topic.create({ data: { name: 'orch topic', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    const main = await prisma.task.create({ data: { title: 'Demo feature', topicId: topic.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    created.tasks.push(main.id);
    for (const [index, [title, description]] of [['Task A', 'write A'], ['Task B', 'write B, forget commit'], ['Task C', 'needs A']].entries()) await prisma.task.create({ data: { title, description, parentId: main.id, topicId: topic.id, sortOrder: index, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    expect((await owner().post('/api/orchestrations/preview').send({ taskId: main.id })).body.code).toBe('PROJECT_REQUIRED');
    data(await owner().put(`/api/project-bindings/topic/${topic.id}`).send({ projectId: project.id }));

    const draft = data(await owner().post('/api/orchestrations/preview').send({ taskId: main.id }));
    created.orchestrations.push(draft.id);
    expect(draft.status).toBe('draft');
    expect(draft.integrationBranch).toBe('orch/demo-feature-r1');
    expect(draft.locations[0].id).toBe(location.id);
    const c = draft.plan.steps.find((step: any) => step.dependsOn.length);
    expect(c).toBeTruthy();
    const started = data(await owner().post(`/api/orchestrations/${draft.id}/start`).send({ expectedRevision: draft.revision, locationId: location.id, maxParallel: 2 }));
    expect(started.status).toBe('running');

    await drive(node.agent, async () => (await prisma.orchestration.findUniqueOrThrow({ where: { id: draft.id } })).status !== 'running');
    const finished = data(await owner().get(`/api/orchestrations/${draft.id}`));
    if (finished.pauseReason) console.log(JSON.stringify(finished.events.filter((item: any) => /check|paused/.test(item.type)).map((item: any) => [item.type, item.payload]), null, 1).slice(0, 4000));
    expect(finished.pauseReason ?? null).toBeNull();
    expect(finished.status).toBe('awaiting_acceptance');

    // Parallel: A and B overlapped; C started only after A was merged; merges never overlapped.
    const log = (await readFile(join(root, 'stub.log'), 'utf8')).trim().split('\n');
    // First run of each subtask (B's first run forgets to commit and is sent back once).
    const developed: Record<string, { start: number; end: number }> = {};
    for (const line of log.filter((item) => item.startsWith('develop '))) { const parts = line.replace(/ nocommit$/, '').split(' '); const title = parts.slice(1, -2).join(' '); developed[title] ??= { start: Number(parts.at(-2)), end: Number(parts.at(-1)) }; }
    const merges = log.filter((line) => line.startsWith('merge ')).map((line) => ({ branch: line.split(' ')[1], at: Number(line.split(' ')[2]) }));
    expect(merges).toHaveLength(3);
    const firstA = log.findIndex((line) => line.startsWith('merge') && line.includes('task-a'));
    const startC = log.findIndex((line) => line.startsWith('develop Task C'));
    expect(firstA).toBeGreaterThanOrEqual(0); expect(startC).toBeGreaterThan(firstA);
    expect(log.filter((line) => line.startsWith('develop Task B'))).toHaveLength(2); expect(log.some((line) => line.endsWith('nocommit'))).toBe(true); // B was sent back once with feedback
    expect(log.filter((line) => line.startsWith('verify'))).toHaveLength(3);
    expect(Math.max(developed['Task A'].start, developed['Task B'].start)).toBeLessThan(Math.min(developed['Task A'].end, developed['Task B'].end));

    // The integration branch contains all three subtask commits; C saw A's change.
    const integration = finished.integrationPath as string;
    expect(git(integration, 'symbolic-ref', '--short', 'HEAD')).toBe('orch/demo-feature-r1');
    expect(await readFile(join(integration, 'Task-C.txt'), 'utf8')).toContain('saw A');
    for (const file of ['Task-A.txt', 'Task-B.txt', 'Task-C.txt']) expect(await readFile(join(integration, file), 'utf8')).toBeTruthy();
    expect(finished.integrationHead).toBe(git(integration, 'rev-parse', 'HEAD'));
    const subtasks = await prisma.task.findMany({ where: { parentId: main.id } });
    expect(subtasks.every((task) => task.status === 'done')).toBe(true);
    const developIds = (await prisma.orchestrationStep.findMany({ where: { orchestrationId: draft.id, kind: 'develop' } })).map((step) => step.id);
    const developJobs = await prisma.nodeJob.findMany({ where: { stepId: { in: developIds }, kind: 'run', status: 'done' } });
    expect(developJobs.length).toBeGreaterThan(0);
    expect(developJobs.every((job) => job.inputTokens === 1200 && job.cachedInputTokens === 200 && job.outputTokens === 80 && job.exitCode === 0 && job.costMicroUsd === null && job.provider === 'codex' && job.model === null && job.cliVersion === 'stub-codex 0.0.0')).toBe(true);
    expect(developJobs.some((job) => (job.filesChanged ?? 0) > 0)).toBe(true);
    // The server never ran git: the main checkout is untouched and on main.
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');

    const attention = data(await owner().get('/api/orchestrations/attention'));
    expect(attention.items.some((item: any) => item.orchestrationId === draft.id && item.status === 'awaiting_acceptance')).toBe(true);
    data(await owner().post(`/api/orchestrations/${draft.id}/accept`).send({}));
    expect((await prisma.task.findUniqueOrThrow({ where: { id: main.id } })).status).toBe('done');
    data(await owner().post(`/api/orchestrations/${draft.id}/push`).send({}));
    await drive(node.agent, async () => !!(await prisma.orchestration.findUniqueOrThrow({ where: { id: draft.id } })).pushedAt, 20_000);
    expect(git(remote, 'rev-parse', 'refs/heads/orch/demo-feature-r1')).toBe(finished.integrationHead);
    await prisma.topic.update({ where: { id: topic.id }, data: { archivedAt: new Date().toISOString() } }).catch(() => undefined);
  }, 180_000);

  it('pauses when the independent verify run disagrees, and a re-verify compares HEAD instead of trusting the AI', async () => {
    const code = join(root, 'code2'); const repo = join(code, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-b', 'main'); await writeFile(join(repo, 'README.md'), '# two\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'init');
    const node = await makeNode('desk', [code]);
    const project = data(await owner().post('/api/projects').send({ name: 'two' })); created.projects.push(project.id);
    data(await owner().post(`/api/projects/${project.id}/locations`).send({ nodeId: node.id, path: repo }));
    await drive(node.agent, async () => (await prisma.projectLocation.findFirst({ where: { projectId: project.id } }))?.status === 'verified', 15_000);
    const location = await prisma.projectLocation.findFirstOrThrow({ where: { projectId: project.id } });
    const main = await prisma.task.create({ data: { title: '验证失败', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }); created.tasks.push(main.id);
    await prisma.task.create({ data: { title: 'Task A', description: 'write A', parentId: main.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    data(await owner().put(`/api/project-bindings/task/${main.id}`).send({ projectId: project.id }));
    const draft = data(await owner().post('/api/orchestrations/preview').send({ taskId: main.id })); created.orchestrations.push(draft.id);
    expect(draft.integrationBranch).toMatch(/^orch\/[a-z0-9]{8}-r1$/);
    data(await owner().post(`/api/orchestrations/${draft.id}/start`).send({ expectedRevision: draft.revision, locationId: location.id }));
    // Make the verify run report a failing test once the integration worktree exists.
    await drive(node.agent, async () => !!(await prisma.orchestration.findUniqueOrThrow({ where: { id: draft.id } })).integrationPath, 20_000);
    const integration = (await prisma.orchestration.findUniqueOrThrow({ where: { id: draft.id } })).integrationPath!;
    await writeFile(join(integration, 'FAIL_VERIFY'), '');
    git(integration, 'add', 'FAIL_VERIFY'); git(integration, 'commit', '-m', 'test fixture');
    await prisma.orchestration.update({ where: { id: draft.id }, data: { integrationHead: git(integration, 'rev-parse', 'HEAD') } });
    await drive(node.agent, async () => (await prisma.orchestration.findUniqueOrThrow({ where: { id: draft.id } })).status !== 'running');
    const paused = data(await owner().get(`/api/orchestrations/${draft.id}`));
    expect(paused.status).toBe('paused');
    expect(paused.pauseReason).toBe('merge_tests_failed');
    expect((await prisma.task.findFirstOrThrow({ where: { parentId: main.id } })).status).toBe('doing');
    const merge = paused.steps.find((step: any) => step.kind === 'merge');
    git(integration, 'rm', '-q', 'FAIL_VERIFY'); git(integration, 'commit', '-m', 'fix');
    // HEAD moved, so a plain re-verify must now fail the HEAD comparison instead of trusting the AI.
    data(await owner().post(`/api/orchestrations/${draft.id}/steps/${merge.id}/retry`).send({ mode: 'reverify' }));
    await drive(node.agent, async () => (await prisma.orchestration.findUniqueOrThrow({ where: { id: draft.id } })).status !== 'running');
    const again = data(await owner().get(`/api/orchestrations/${draft.id}`));
    expect(again.pauseReason).toBe('merge_unverified');
    expect(again.events.filter((item: any) => item.type === 'verify_check').at(-1).payload.problems.join()).toContain('HEAD 不一致');
    data(await owner().post(`/api/orchestrations/${draft.id}/cancel`).send({}));
  }, 120_000);
});

describe('node protocol', () => {
  it('leases a job to one node only, treats identical reports as replays, rejects changed reports, and accepts late reports on lost jobs', async () => {
    const node = await makeNode('proto', [root]);
    const other = await makeNode('other', [root]);
    const { enqueueJob } = await import('./application/orchestration/nodes.js');
    const job = await prisma.$transaction(async (tx) => (await enqueueJob(tx, { nodeId: node.id, kind: 'probe', phase: 'probe', dispatchKey: `test:${node.id}`, payload: { path: root } })).job);
    const replay = await prisma.$transaction(async (tx) => enqueueJob(tx, { nodeId: node.id, kind: 'probe', dispatchKey: `test:${node.id}`, payload: { path: '/elsewhere' } }));
    expect(replay.replay).toBe(true); expect(replay.job.id).toBe(job.id);
    const supertest = (await import('supertest')).default;
    const caps = { protocol: 1, providers: [], maxConcurrent: 2, allowedRoots: [root], freeBytes: null };
    const otherLease = await supertest(app).post('/api/v1/node/lease').set('Authorization', `Node ${other.token}`).send({ capabilities: caps, activeJobIds: [], max: 2 });
    expect(otherLease.body.data.jobs).toHaveLength(0);
    expect(otherLease.body.data.accepts).toEqual(['usage_v1']);
    const lease = await supertest(app).post('/api/v1/node/lease').set('Authorization', `Node ${node.token}`).send({ capabilities: caps, activeJobIds: [], max: 2 });
    expect(lease.body.data.accepts).toEqual(['usage_v1']);
    const leased = lease.body.data.jobs[0];
    expect(leased.id).toBe(job.id);
    expect((await supertest(app).post('/api/v1/node/lease').set('Authorization', `Node ${node.token}`).send({ capabilities: caps, activeJobIds: [job.id], max: 2 })).body.data.jobs).toHaveLength(0);
    expect((await supertest(app).post(`/api/v1/node/jobs/${job.id}/result`).set('Authorization', `Node ${other.token}`).send({ leaseToken: leased.leaseToken, ok: true, result: {} })).status).toBe(404);
    expect((await supertest(app).post(`/api/v1/node/jobs/${job.id}/result`).set('Authorization', `Node ${node.token}`).send({ leaseToken: 'x'.repeat(43), ok: true, result: {} })).status).toBe(403);
    // Lease expiry turns the job lost; the original node's late report is still accepted.
    await prisma.nodeJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000).toISOString() } });
    await tickAllOrchestrations();
    expect((await prisma.nodeJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('failed'); // probes fail fast when lost
    const fresh = await prisma.$transaction(async (tx) => (await enqueueJob(tx, { nodeId: node.id, kind: 'run', dispatchKey: `test2:${node.id}`, payload: {} })).job);
    const lease2 = (await supertest(app).post('/api/v1/node/lease').set('Authorization', `Node ${node.token}`).send({ capabilities: caps, activeJobIds: [], max: 1 })).body.data.jobs[0];
    await prisma.nodeJob.update({ where: { id: fresh.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000).toISOString() } });
    await tickAllOrchestrations();
    expect((await prisma.nodeJob.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('lost');
    const body = { leaseToken: lease2.leaseToken, ok: false, error: 'boom' };
    expect((await supertest(app).post(`/api/v1/node/jobs/${fresh.id}/result`).set('Authorization', `Node ${node.token}`).send(body)).status).toBe(200);
    expect((await supertest(app).post(`/api/v1/node/jobs/${fresh.id}/result`).set('Authorization', `Node ${node.token}`).send(body)).body.data.replay).toBe(true);
    expect((await supertest(app).post(`/api/v1/node/jobs/${fresh.id}/result`).set('Authorization', `Node ${node.token}`).send({ ...body, error: 'different' })).status).toBe(409);
    // Revoked nodes cannot authenticate; owner endpoints are not reachable with a node token.
    data(await owner().post(`/api/nodes/${other.id}/revoke`).send({}));
    expect((await supertest(app).post('/api/v1/node/lease').set('Authorization', `Node ${other.token}`).send({ capabilities: caps })).status).toBe(401);
    expect((await supertest(app).get('/api/orchestrations').set('Authorization', `Node ${node.token}`)).status).toBeGreaterThanOrEqual(400);
    void tickOrchestration; void resolve;
  });

  it('stores run usage columns from reports and leaves them null when the node omits the new keys', async () => {
    const node = await makeNode('usage-cols', [root]);
    const { enqueueJob } = await import('./application/orchestration/nodes.js');
    const supertest = (await import('supertest')).default;
    const caps = { protocol: 2, providers: [], maxConcurrent: 2, allowedRoots: [root], freeBytes: null };
    const enqueue = (key: string) => prisma.$transaction(async (tx) => (await enqueueJob(tx, { nodeId: node.id, kind: 'run', dispatchKey: `${key}:${node.id}`, payload: { provider: 'codex' } })).job);
    const [oldJob, failJob, badJob, fullJob] = [await enqueue('usage-old'), await enqueue('usage-fail'), await enqueue('usage-bad'), await enqueue('usage-full')];
    const leaseNext = async () => {
      const response = await supertest(app).post('/api/v1/node/lease').set('Authorization', `Node ${node.token}`).send({ capabilities: caps, activeJobIds: [], max: 1 });
      expect(response.status).toBe(200);
      expect(response.body.data.accepts).toEqual(['usage_v1']);
      return response.body.data.jobs[0] as { id: string; leaseToken: string };
    };
    const report = (id: string, body: Record<string, unknown>) => supertest(app).post(`/api/v1/node/jobs/${id}/result`).set('Authorization', `Node ${node.token}`).send(body);
    const oldResult = { worktree: '/w', result: null, facts: null };
    const leased = await leaseNext();
    expect(leased.id).toBe(oldJob.id);
    const oldBody = { leaseToken: leased.leaseToken, ok: true, result: oldResult };
    expect((await report(oldJob.id, oldBody)).status).toBe(200);
    expect((await report(oldJob.id, oldBody)).body.data.replay).toBe(true);
    expect((await report(oldJob.id, { ...oldBody, result: { ...oldResult, error: 'changed' } })).status).toBe(409);
    const oldRow = await prisma.nodeJob.findUniqueOrThrow({ where: { id: oldJob.id } });
    expect(oldRow.status).toBe('done');
    expect(oldRow.provider).toBe('codex');
    expect(oldRow.exitCode).toBeNull();
    expect(oldRow.inputTokens).toBeNull();
    expect(oldRow.cachedInputTokens).toBeNull();
    expect(oldRow.outputTokens).toBeNull();
    expect(oldRow.costMicroUsd).toBeNull();
    expect(oldRow.usageJson).toBeNull();
    expect(oldRow.filesChanged).toBeNull();
    expect(oldRow.linesAdded).toBeNull();
    expect(oldRow.linesDeleted).toBeNull();
    expect(oldRow.diffStatJson).toBeNull();
    expect(oldRow.cliVersion).toBeNull();
    expect(oldRow.model).toBeNull();

    const failed = await leaseNext();
    expect(failed.id).toBe(failJob.id);
    expect((await report(failJob.id, { leaseToken: failed.leaseToken, ok: false, error: 'nope' })).status).toBe(200);
    const failRow = await prisma.nodeJob.findUniqueOrThrow({ where: { id: failJob.id } });
    expect(failRow.status).toBe('failed');
    expect(failRow.provider).toBe('codex');
    expect(failRow.exitCode).toBeNull();
    expect(failRow.inputTokens).toBeNull();
    expect(failRow.usageJson).toBeNull();
    expect(failRow.filesChanged).toBeNull();

    const bad = await leaseNext();
    expect(bad.id).toBe(badJob.id);
    expect((await report(badJob.id, { leaseToken: bad.leaseToken, ok: true, result: { garbage: true } })).status).toBe(200);
    const badRow = await prisma.nodeJob.findUniqueOrThrow({ where: { id: badJob.id } });
    expect(badRow.status).toBe('done');
    expect(badRow.provider).toBeNull();
    expect(badRow.exitCode).toBeNull();
    expect(badRow.inputTokens).toBeNull();
    expect(badRow.filesChanged).toBeNull();
    expect(badRow.usageJson).toBeNull();

    const usage = { model: 'gpt', inputTokens: 1200, cachedInputTokens: 200, outputTokens: 80, costUsd: 0.25, numTurns: 2, cliDurationMs: 40, runDurationMs: 50, cliVersion: 'stub-codex 0.0.0' };
    const diff = { files: [{ path: 'a.txt', added: 3, deleted: 1, binary: false }], filesChanged: 4, linesAdded: 3, linesDeleted: 1, truncated: true };
    const full = await leaseNext();
    expect(full.id).toBe(fullJob.id);
    expect((await report(fullJob.id, { leaseToken: full.leaseToken, ok: true, result: { worktree: '/w', result: null, facts: { worktree: '/w', branch: 'main', head: 'abc1234', base: 'abc0000', diff }, exitCode: 0, usage } })).status).toBe(200);
    const fullRow = await prisma.nodeJob.findUniqueOrThrow({ where: { id: fullJob.id } });
    expect(fullRow.provider).toBe('codex');
    expect(fullRow.exitCode).toBe(0);
    expect(fullRow.model).toBe('gpt');
    expect(fullRow.inputTokens).toBe(1200);
    expect(fullRow.cachedInputTokens).toBe(200);
    expect(fullRow.outputTokens).toBe(80);
    expect(fullRow.costMicroUsd).toBe(250000);
    expect(fullRow.cliVersion).toBe('stub-codex 0.0.0');
    expect(fullRow.filesChanged).toBe(4);
    expect(fullRow.linesAdded).toBe(3);
    expect(fullRow.linesDeleted).toBe(1);
    expect(JSON.parse(fullRow.diffStatJson!).files[0].path).toBe('a.txt');
    expect((fullRow.usageJson ?? '').length).toBeLessThanOrEqual(8000);
    expect((await report(fullJob.id, { leaseToken: full.leaseToken, ok: true, result: { worktree: '/w', result: null, facts: null } })).status).toBe(409);
  });
});
