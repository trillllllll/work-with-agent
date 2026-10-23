import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { tickAllOrchestrations } from './application/orchestration/service.js';

const stub = fileURLToPath(new URL('../test/stub-orchestration-cli.mjs', import.meta.url));
const previous = { runner: process.env.DOVUN_RUNNER_DIR, codex: process.env.DOVUN_CODEX_BIN, log: process.env.STUB_LOG, gh: process.env.DOVUN_GH_BIN, delay: process.env.STUB_DELAY_MS };
let root = ''; let server: Server; let base = ''; let restoreModel: OrchestratorModel;
const created: { tasks: string[]; orchestrations: string[]; projects: string[]; nodes: string[]; topics: string[] } = { tasks: [], orchestrations: [], projects: [], nodes: [], topics: [] };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const owner = () => ownerRequest(app);
const data = (response: { status: number; body: { data: any; code?: string } }) => { if (response.status !== 200) throw new Error(`HTTP ${response.status} ${JSON.stringify(response.body)}`); return response.body.data; };
const at = () => new Date().toISOString();

const model: OrchestratorModel = {
  async complete(messages) {
    const system = messages[0].content;
    if (system.includes('[编排计划]')) {
      const subtasks = JSON.parse(messages[1].content.match(/子任务：(\[.*\])/)![1]) as Array<{ id: string; title: string }>;
      const a = subtasks.find((task) => task.title === 'Task A')!;
      return { text: JSON.stringify({ goalCriteria: '文件都在', steps: subtasks.map((task) => ({ taskId: task.id, dependsOn: task.title === 'Task C' ? [a.id] : [], acceptanceCriteria: `${task.title} 文件存在`, rationale: 'test' })) }) };
    }
    if (system.includes('[编排最终验收]')) return { text: JSON.stringify({ satisfied: true, comment: '满足' }) };
    return { text: JSON.stringify({ decision: 'accept', comment: 'ok' }) };
  },
};

type TestNode = { id: string; agent: NodeAgent; dataDir: string };
async function makeNode(name: string, roots: string[]): Promise<TestNode> {
  const response = data(await owner().post('/api/nodes').send({ name }));
  created.nodes.push(response.node.id);
  const dataDir = join(root, `node-${name}`);
  return { id: response.node.id, agent: new NodeAgent({ server: base, token: response.token, roots, dataDir, maxConcurrent: 2, pollMs: 50 }), dataDir };
}
async function drive(agents: NodeAgent[], until: () => Promise<boolean>, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const agent of agents) await agent.pollOnce();
    await tickAllOrchestrations();
    if (await until()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('drive timeout');
}
const orch = (id: string) => prisma.orchestration.findUniqueOrThrow({ where: { id } });

let shared: { laptop: TestNode; desk: TestNode; orchestrationId: string; remote: string } | null = null;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wwa-orch2-'));
  process.env.DOVUN_CODEX_BIN = stub;
  process.env.STUB_LOG = join(root, 'stub.log');
  process.env.STUB_DELAY_MS = '50';
  // Fake GitHub CLI: records its arguments and prints a PR URL, like `gh pr create`.
  const gh = join(root, 'fake-gh.mjs');
  await writeFile(gh, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif (args[0] === '--version') { console.log('gh version 0.0.0'); process.exit(0); }\nfs.appendFileSync(${JSON.stringify(join(root, 'gh.log'))}, JSON.stringify(args) + '\\n');\nif (args[0] === 'pr' && args[1] === 'view') { const f = ${JSON.stringify(join(root, 'gh-pr'))}; if (fs.existsSync(f)) { console.log(fs.readFileSync(f, 'utf8')); process.exit(0); } console.error('no pull requests found'); process.exit(1); }\nif (args[0] === 'pr' && args[1] === 'create') { const url = 'https://github.com/example/demo/pull/7'; fs.writeFileSync(${JSON.stringify(join(root, 'gh-pr'))}, url); console.log('Creating pull request...'); console.log(url); process.exit(0); }\nprocess.exit(2);\n`.replace("const fs = require('node:fs');", "import fs from 'node:fs';"));
  await chmod(gh, 0o755);
  process.env.DOVUN_GH_BIN = gh;
  restoreModel = setOrchestratorModel(model);
  server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  setOrchestratorModel(restoreModel);
  await new Promise((done) => server.close(done));
  await prisma.worktreeCleanup.deleteMany({ where: { nodeId: { in: created.nodes } } });
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
  await prisma.topic.deleteMany({ where: { id: { in: created.topics } } }).catch(() => undefined);
  for (const [key, value] of Object.entries({ DOVUN_RUNNER_DIR: previous.runner, DOVUN_CODEX_BIN: previous.codex, STUB_LOG: previous.log, DOVUN_GH_BIN: previous.gh, STUB_DELAY_MS: previous.delay })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
});

describe('orchestration phase 2', () => {
  it('runs one round across two machines, transferring branches only through the shared remote, then opens a PR on request', async () => {
    const remote = join(root, 'origin.git');
    const seed = join(root, 'seed');
    await mkdir(seed, { recursive: true });
    git(root, 'init', '--bare', '-b', 'main', remote);
    git(seed, 'init', '-b', 'main'); await writeFile(join(seed, 'README.md'), '# cross\n'); git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'init'); git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', '-q', 'origin', 'main');
    const laptopCode = join(root, 'laptop'); const deskCode = join(root, 'desk');
    await mkdir(laptopCode); await mkdir(deskCode);
    git(laptopCode, 'clone', '-q', remote, 'repo'); git(deskCode, 'clone', '-q', remote, 'repo');
    const laptop = await makeNode('laptop', [laptopCode]);
    const desk = await makeNode('desk', [deskCode]);
    const agents = [laptop.agent, desk.agent];

    const project = data(await owner().post('/api/projects').send({ name: 'cross', defaultBranch: 'main' })); created.projects.push(project.id);
    data(await owner().post(`/api/projects/${project.id}/locations`).send({ nodeId: laptop.id, path: join(laptopCode, 'repo') }));
    data(await owner().post(`/api/projects/${project.id}/locations`).send({ nodeId: desk.id, path: join(deskCode, 'repo') }));
    await drive(agents, async () => (await prisma.projectLocation.count({ where: { projectId: project.id, status: 'verified' } })) === 2, 20_000);
    const primary = await prisma.projectLocation.findFirstOrThrow({ where: { projectId: project.id, nodeId: laptop.id } });
    const extra = await prisma.projectLocation.findFirstOrThrow({ where: { projectId: project.id, nodeId: desk.id } });

    const topic = await prisma.topic.create({ data: { name: 'cross topic', createdAt: at(), updatedAt: at() } }); created.topics.push(topic.id);
    const main = await prisma.task.create({ data: { title: 'Cross feature', topicId: topic.id, createdAt: at(), updatedAt: at() } }); created.tasks.push(main.id);
    for (const [index, [title, description]] of [['Task A', 'write A'], ['Task B', 'write B'], ['Task C', 'needs A']].entries()) await prisma.task.create({ data: { title, description, parentId: main.id, topicId: topic.id, sortOrder: index, createdAt: at(), updatedAt: at() } });
    data(await owner().put(`/api/project-bindings/topic/${topic.id}`).send({ projectId: project.id }));
    const draft = data(await owner().post('/api/orchestrations/preview').send({ taskId: main.id })); created.orchestrations.push(draft.id);
    expect(draft.locations).toHaveLength(2);
    expect(draft.locations.every((item: any) => item.protocol >= 2 && item.originUrl)).toBe(true);
    // A location of another project is refused.
    expect((await owner().post(`/api/orchestrations/${draft.id}/start`).send({ expectedRevision: draft.revision, locationId: primary.id, extraLocationIds: ['missing'] })).body.code).toBe('LOCATION_REQUIRED');
    const second = draft;
    data(await owner().post(`/api/orchestrations/${second.id}/start`).send({ expectedRevision: second.revision, locationId: primary.id, extraLocationIds: [extra.id], maxParallel: 2 }));

    await drive(agents, async () => (await orch(second.id)).status !== 'running', 120_000);
    const finished = data(await owner().get(`/api/orchestrations/${second.id}`));
    if (finished.pauseReason) console.log(JSON.stringify(finished.events.filter((item: any) => /check|paused|published/.test(item.type)).map((item: any) => [item.type, item.payload]), null, 1).slice(0, 4000));
    expect(finished.status).toBe('awaiting_acceptance');
    expect(finished.nodes.map((item: any) => item.name).sort()).toEqual(['desk', 'laptop']);
    const develops = finished.steps.filter((step: any) => step.kind === 'develop');
    const onDesk = develops.filter((step: any) => step.nodeId === desk.id);
    expect(onDesk.length).toBeGreaterThan(0);
    // Every subtask developed on the desk machine reached the laptop only through origin.
    for (const step of onDesk) {
      expect(step.workPath.startsWith(desk.dataDir)).toBe(true);
      expect(git(remote, 'rev-parse', `refs/heads/${step.branch}`)).toBe(step.resultCommit);
    }
    expect(finished.steps.some((step: any) => step.kind === 'publish' && step.status === 'succeeded')).toBe(true);
    const integration = finished.integrationPath as string;
    expect(integration.startsWith(laptop.dataDir)).toBe(true);
    for (const file of ['Task-A.txt', 'Task-B.txt', 'Task-C.txt']) expect(await readFile(join(integration, file), 'utf8')).toBeTruthy();
    expect(await readFile(join(integration, 'Task-C.txt'), 'utf8')).toContain('saw A');
    // Neither main checkout was touched.
    for (const code of [laptopCode, deskCode]) { expect(git(join(code, 'repo'), 'symbolic-ref', '--short', 'HEAD')).toBe('main'); expect(git(join(code, 'repo'), 'status', '--porcelain')).toBe(''); }

    // PR: refused before the push, then created by the node with the local gh, idempotent on repeat.
    data(await owner().post(`/api/orchestrations/${second.id}/accept`).send({}));
    expect((await owner().post(`/api/orchestrations/${second.id}/pull-request`).send({})).body.code).toBe('PUSH_REQUIRED');
    data(await owner().post(`/api/orchestrations/${second.id}/push`).send({}));
    await drive(agents, async () => !!(await orch(second.id)).pushedAt, 20_000);
    data(await owner().post(`/api/orchestrations/${second.id}/pull-request`).send({ title: 'Cross feature' }));
    await drive(agents, async () => !!(await orch(second.id)).pullRequestUrl, 20_000);
    expect((await orch(second.id)).pullRequestUrl).toBe('https://github.com/example/demo/pull/7');
    const ghCalls = (await readFile(join(root, 'gh.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    const createCall = ghCalls.find((args) => args[1] === 'create')!;
    expect(createCall).toEqual(expect.arrayContaining(['--head', finished.integrationBranch, '--base', 'main', '--title', 'Cross feature']));
    shared = { laptop, desk, orchestrationId: second.id, remote };
  }, 240_000);

  it('lists worktrees per machine and deletes only after the confirmation card, never dirty or in-use ones', async () => {
    expect(shared).toBeTruthy();
    const { laptop, desk, orchestrationId } = shared!;
    const agents = [laptop.agent, desk.agent];
    expect((await owner().post('/api/worktree-cleanups').send({ nodeId: laptop.id, paths: ['/x'] })).body.code).toBe('INVENTORY_REQUIRED');
    data(await owner().post(`/api/nodes/${laptop.id}/inventory`).send({}));
    await drive(agents, async () => !!(await prisma.agentNode.findUniqueOrThrow({ where: { id: laptop.id } })).inventoryAt, 20_000);
    let overview = data(await owner().get('/api/worktrees'));
    let laptopView = overview.find((item: any) => item.node.id === laptop.id);
    const row = await orch(orchestrationId);
    expect(laptopView.worktrees.map((item: any) => item.path)).toContain(row.integrationPath);
    const integrationEntry = laptopView.worktrees.find((item: any) => item.path === row.integrationPath);
    expect(integrationEntry.usage).toMatchObject({ orchestrationId, role: 'integration', status: 'accepted', pushed: true });
    expect(integrationEntry.action).toBe('remove');
    // Runner records are counted (both test agents share one process, so their runner directory is the last one configured).
    expect(typeof laptopView.runs.count).toBe('number');

    // A subtask worktree with an untracked file is never removed.
    const subtask = laptopView.worktrees.find((item: any) => item.path !== row.integrationPath)!;
    await writeFile(join(subtask.path, 'notes.txt'), 'keep me');
    data(await owner().post(`/api/nodes/${laptop.id}/inventory`).send({}));
    const before = (await prisma.agentNode.findUniqueOrThrow({ where: { id: laptop.id } })).inventoryAt;
    await drive(agents, async () => (await prisma.agentNode.findUniqueOrThrow({ where: { id: laptop.id } })).inventoryAt !== before, 20_000);

    // An open round blocks its worktrees.
    await prisma.orchestration.update({ where: { id: orchestrationId }, data: { status: 'paused' } });
    const blocked = data(await owner().post('/api/worktree-cleanups').send({ nodeId: laptop.id, paths: [row.integrationPath] }));
    expect(blocked.items[0]).toMatchObject({ action: 'blocked', reason: '正被未结束的编排使用' });
    expect((await owner().post(`/api/worktree-cleanups/${blocked.id}/confirm`).send({})).body.code).toBe('NOTHING_TO_REMOVE');
    await prisma.orchestration.update({ where: { id: orchestrationId }, data: { status: 'accepted' } });

    // Preview → card. Nothing is sent to the node until confirm.
    const card = data(await owner().post('/api/worktree-cleanups').send({ nodeId: laptop.id, paths: [row.integrationPath, subtask.path, '/not/listed'], deleteBranches: true }));
    expect(card.status).toBe('pending');
    expect(card.items.map((item: any) => item.action)).toEqual(['remove', 'blocked', 'blocked']);
    expect(card.items[1].reason).toContain('未提交或未跟踪');
    expect(card.removableCount).toBe(1);
    expect(await prisma.nodeJob.count({ where: { nodeId: laptop.id, kind: 'cleanup' } })).toBe(0);
    overview = data(await owner().get('/api/worktrees'));
    expect(overview.find((item: any) => item.node.id === laptop.id).pendingCards.map((item: any) => item.id)).toContain(card.id);

    // An expired card cannot be confirmed.
    const stale = data(await owner().post('/api/worktree-cleanups').send({ nodeId: laptop.id, paths: [row.integrationPath] }));
    await prisma.worktreeCleanup.update({ where: { id: stale.id }, data: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
    expect((await owner().post(`/api/worktree-cleanups/${stale.id}/confirm`).send({})).body.code).toBe('CLEANUP_EXPIRED');

    const confirmed = data(await owner().post(`/api/worktree-cleanups/${card.id}/confirm`).send({}));
    expect(confirmed.status).toBe('confirmed');
    expect((await owner().post(`/api/worktree-cleanups/${card.id}/confirm`).send({})).body.code).toBe('CLEANUP_NOT_PENDING');
    await drive(agents, async () => (await prisma.worktreeCleanup.findUniqueOrThrow({ where: { id: card.id } })).status !== 'confirmed', 20_000);
    const done = data(await owner().get(`/api/worktree-cleanups/${card.id}`));
    expect(done.status).toBe('done');
    expect(done.result.removed.map((item: any) => item.path)).toEqual([row.integrationPath]);
    // `git branch -d` only deletes it because it is fully pushed to its upstream; the remote keeps the branch.
    expect(done.result.removed[0].branchDeleted).toBe(true);
    const job = await prisma.nodeJob.findFirstOrThrow({ where: { nodeId: laptop.id, kind: 'cleanup' } });
    expect(JSON.parse(job.payloadJson).worktrees).toEqual([row.integrationPath]);
    // The node did the removal: the directory is gone, the dirty one and the branch remain.
    const repo = join(root, 'laptop', 'repo');
    expect(git(repo, 'worktree', 'list')).not.toContain(row.integrationPath);
    expect(await readFile(join(subtask.path, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(git(shared!.remote, 'rev-parse', `refs/heads/${row.integrationBranch}`)).toBe(row.integrationHead);
    laptopView = data(await owner().get('/api/worktrees')).find((item: any) => item.node.id === laptop.id);
    expect(laptopView.worktrees.map((item: any) => item.path)).not.toContain(row.integrationPath);
  }, 120_000);
});
