import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import ownerRequest from './test-auth.js';
import { setOrchestratorModel, type OrchestratorModel } from './application/orchestration/planner.js';
import { tickAllOrchestrations } from './application/orchestration/service.js';
import { classifyFailure } from './application/orchestration/checks.js';
import { capabilitiesSchema, NODE_PROTOCOL_VERSION } from './node-agent/protocol.js';
import { orchestrationFeed } from './application/orchestration/history.js';
import { readOrchestration } from './agent/orchestration-tools.js';

const owner = () => ownerRequest(app);
const data = (response: { status: number; body: { data: any; code?: string; error?: string } }) => {
  if (response.status !== 200) throw new Error(`HTTP ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data;
};
const at = () => new Date().toISOString();
const stamp = `rs-${Date.now().toString(36)}`;
const ids = { tasks: [] as string[], orchestrations: [] as string[], projects: [] as string[], nodes: [] as string[], topics: [] as string[] };
let restoreModel: OrchestratorModel;
const throwing: OrchestratorModel = { async complete() { throw new Error('runner-settings stub'); } };

const codex = (available = true) => ({ provider: 'codex', available, version: 'stub' });
const caps = (extra: Record<string, unknown> = {}) => ({ protocol: 2, providers: [codex()], maxConcurrent: 2, allowedRoots: [] as string[], freeBytes: null, ...extra });
const lease = (token: string, body?: Record<string, unknown>) => supertest(app).post('/api/v1/node/lease').set('Authorization', `Node ${token}`).send(body ?? { capabilities: caps(), activeJobIds: [], max: 1 });

async function createNode(name: string) {
  const created = data(await owner().post('/api/nodes').send({ name }));
  ids.nodes.push(created.node.id);
  return created as { node: { id: string; name: string; status: string; activeJobs: number; locations: Array<{ id: string }> }; token: string; serverUrl: string; command: string };
}
async function createProject(name: string) {
  const created = data(await owner().post('/api/projects').send({ name }));
  ids.projects.push(created.id);
  return created as { id: string; name: string; defaultParallel: number; revision: number };
}
async function createTopic(name: string) {
  const row = await prisma.topic.create({ data: { name, createdAt: at(), updatedAt: at() } });
  ids.topics.push(row.id);
  return row;
}
async function createTask(title: string, extra: { parentId?: string; topicId?: string } = {}) {
  const row = await prisma.task.create({ data: { title, parentId: extra.parentId ?? null, topicId: extra.topicId ?? null, createdAt: at(), updatedAt: at() } });
  ids.tasks.push(row.id);
  return row;
}
async function createOrchestration(input: { taskId: string; projectId: string; nodeId?: string | null; status?: string; round?: number; pauseReason?: string | null; extraLocationsJson?: string; locationId?: string | null }) {
  const round = input.round ?? 1;
  const row = await prisma.orchestration.create({ data: { taskId: input.taskId, projectId: input.projectId, nodeId: input.nodeId ?? null, locationId: input.locationId ?? null, round, status: input.status ?? 'running', pauseReason: input.pauseReason ?? null, extraLocationsJson: input.extraLocationsJson ?? '[]', integrationBranch: `orch/${stamp}-${input.taskId.slice(-6)}-r${round}`, createdAt: at(), updatedAt: at() } });
  ids.orchestrations.push(row.id);
  return row;
}
async function createStep(orchestrationId: string, extra: { kind?: string; status?: string; position?: number; nodeId?: string | null; lastJobId?: string | null }) {
  return prisma.orchestrationStep.create({ data: { orchestrationId, kind: extra.kind ?? 'develop', status: extra.status ?? 'pending', position: extra.position ?? 1, nodeId: extra.nodeId ?? null, lastJobId: extra.lastJobId ?? null, createdAt: at(), updatedAt: at() } });
}
async function createJob(input: { nodeId: string; kind: string; status?: string; orchestrationId?: string | null; stepId?: string | null; dispatchKey: string }) {
  return prisma.nodeJob.create({ data: { nodeId: input.nodeId, kind: input.kind, status: input.status ?? 'queued', orchestrationId: input.orchestrationId ?? null, stepId: input.stepId ?? null, dispatchKey: input.dispatchKey, payloadJson: '{}', createdAt: at(), updatedAt: at() } });
}
async function verifyLocation(projectId: string, nodeId: string, path: string, fingerprint: Record<string, unknown> = { originUrl: 'https://example.com/repo.git' }) {
  const added = data(await owner().post(`/api/projects/${projectId}/locations`).send({ nodeId, path }));
  await prisma.projectLocation.update({ where: { id: added.location.id }, data: { status: 'verified', fingerprintJson: JSON.stringify(fingerprint), verifiedAt: at(), updatedAt: at() } });
  await prisma.nodeJob.updateMany({ where: { id: added.jobId }, data: { status: 'done', endedAt: at(), updatedAt: at() } });
  return added.location.id as string;
}
async function draftFor(projectId: string, title: string) {
  const main = await createTask(title);
  await createTask(`${title} 子任务`, { parentId: main.id });
  data(await owner().put(`/api/project-bindings/task/${main.id}`).send({ projectId }));
  const draft = data(await owner().post('/api/orchestrations/preview').send({ taskId: main.id }));
  ids.orchestrations.push(draft.id);
  return draft as { id: string; revision: number; grant: { maxParallel: number }; locations: Array<{ id: string; nodeId: string; providers: Array<{ provider: string; available: boolean }> }> };
}

beforeAll(() => { restoreModel = setOrchestratorModel(throwing); });
afterAll(async () => {
  setOrchestratorModel(restoreModel);
  const extra = ids.tasks.length ? await prisma.orchestration.findMany({ where: { taskId: { in: ids.tasks } }, select: { id: true } }) : [];
  const orchestrationIds = [...new Set([...ids.orchestrations, ...extra.map((row) => row.id)])];
  if (orchestrationIds.length) await prisma.orchestrationEvent.deleteMany({ where: { orchestrationId: { in: orchestrationIds } } });
  if (ids.nodes.length) await prisma.worktreeCleanup.deleteMany({ where: { nodeId: { in: ids.nodes } } });
  if (ids.nodes.length) await prisma.nodeJob.deleteMany({ where: { nodeId: { in: ids.nodes } } });
  if (orchestrationIds.length) await prisma.orchestrationStep.deleteMany({ where: { orchestrationId: { in: orchestrationIds } } });
  if (orchestrationIds.length) await prisma.orchestration.deleteMany({ where: { id: { in: orchestrationIds } } });
  const bindingOr = [...(ids.projects.length ? [{ projectId: { in: ids.projects } }] : []), ...(ids.topics.length || ids.tasks.length ? [{ scopeId: { in: [...ids.topics, ...ids.tasks] } }] : [])];
  if (bindingOr.length) await prisma.projectBinding.deleteMany({ where: { OR: bindingOr } });
  const locationOr = [...(ids.projects.length ? [{ projectId: { in: ids.projects } }] : []), ...(ids.nodes.length ? [{ nodeId: { in: ids.nodes } }] : [])];
  if (locationOr.length) await prisma.projectLocation.deleteMany({ where: { OR: locationOr } });
  if (ids.projects.length) await prisma.project.deleteMany({ where: { id: { in: ids.projects } } });
  if (ids.nodes.length) await prisma.agentNode.deleteMany({ where: { id: { in: ids.nodes } } });
  if (ids.tasks.length) await prisma.task.deleteMany({ where: { parentId: { in: ids.tasks } } });
  if (ids.tasks.length) await prisma.task.deleteMany({ where: { id: { in: ids.tasks } } });
  if (ids.topics.length) await prisma.topic.deleteMany({ where: { id: { in: ids.topics } } });
});

describe('runner settings', () => {
  it('revoke cancels in-flight work, pauses running rounds as computer_offline, and does not auto-resume', async () => {
    const node = await createNode('断开的电脑');
    const other = await createNode('另一台电脑');
    const project = await createProject('断开项目');
    const runningTask = await createTask('运行中');
    const extraTask = await createTask('附加位置');
    const stepTask = await createTask('步骤电脑');
    const otherTask = await createTask('别人的编排');
    const waitingTask = await createTask('待验收');
    const running = await createOrchestration({ taskId: runningTask.id, projectId: project.id, nodeId: node.node.id, status: 'running' });
    const step = await createStep(running.id, { status: 'dispatched', nodeId: node.node.id });
    const leased = await createJob({ nodeId: node.node.id, kind: 'run', status: 'leased', orchestrationId: running.id, stepId: step.id, dispatchKey: `${stamp}-leased` });
    await prisma.orchestrationStep.update({ where: { id: step.id }, data: { lastJobId: leased.id } });
    const verifying = await createStep(running.id, { status: 'verifying', position: 2, nodeId: node.node.id });
    const verifyJob = await createJob({ nodeId: node.node.id, kind: 'run', status: 'queued', orchestrationId: running.id, stepId: verifying.id, dispatchKey: `${stamp}-verifying` });
    await prisma.orchestrationStep.update({ where: { id: verifying.id }, data: { lastJobId: verifyJob.id } });
    const doneStep = await createStep(running.id, { status: 'succeeded', position: 3 });
    const done = await createJob({ nodeId: node.node.id, kind: 'run', status: 'done', orchestrationId: running.id, stepId: doneStep.id, dispatchKey: `${stamp}-done` });
    const lost = await createJob({ nodeId: node.node.id, kind: 'run', status: 'lost', orchestrationId: running.id, dispatchKey: `${stamp}-lost` });
    const probe = await createJob({ nodeId: node.node.id, kind: 'probe', status: 'queued', dispatchKey: `${stamp}-probe` });
    const inventory = await createJob({ nodeId: node.node.id, kind: 'inventory', status: 'queued', dispatchKey: `${stamp}-inventory` });
    const cleanup = await createJob({ nodeId: node.node.id, kind: 'cleanup', status: 'leased', dispatchKey: `${stamp}-cleanup` });
    await prisma.worktreeCleanup.create({ data: { nodeId: node.node.id, itemsJson: '[]', status: 'confirmed', jobId: cleanup.id, expiresAt: at(), createdAt: at(), updatedAt: at() } });
    const extra = await createOrchestration({ taskId: extraTask.id, projectId: project.id, nodeId: other.node.id, status: 'running', extraLocationsJson: JSON.stringify([{ locationId: 'loc', nodeId: node.node.id, path: '/tmp/extra' }]) });
    const viaStep = await createOrchestration({ taskId: stepTask.id, projectId: project.id, nodeId: other.node.id, status: 'running' });
    await createStep(viaStep.id, { nodeId: node.node.id, status: 'pending' });
    const untouched = await createOrchestration({ taskId: otherTask.id, projectId: project.id, nodeId: other.node.id, status: 'running' });
    const waiting = await createOrchestration({ taskId: waitingTask.id, projectId: project.id, nodeId: node.node.id, status: 'awaiting_acceptance' });
    const push = await createStep(waiting.id, { kind: 'push', status: 'dispatched' });
    const pushJob = await createJob({ nodeId: node.node.id, kind: 'push', status: 'queued', orchestrationId: waiting.id, stepId: push.id, dispatchKey: `${stamp}-push` });
    await prisma.orchestrationStep.update({ where: { id: push.id }, data: { lastJobId: pushJob.id } });

    const revoked = data(await owner().post(`/api/nodes/${node.node.id}/revoke`).send({}));
    expect(revoked.node.status).toBe('revoked');
    expect(revoked.node.activeJobs).toBe(0);
    expect(revoked.cancelledJobIds).toEqual(expect.arrayContaining([leased.id, verifyJob.id, lost.id, probe.id, inventory.id, cleanup.id, pushJob.id]));
    expect(revoked.cancelledJobIds).not.toContain(done.id);
    expect(revoked.pausedOrchestrationIds).toEqual(expect.arrayContaining([running.id, extra.id, viaStep.id]));
    expect(revoked.pausedOrchestrationIds).not.toContain(waiting.id);
    expect(revoked.pausedOrchestrationIds).not.toContain(untouched.id);
    expect((await prisma.nodeJob.findUniqueOrThrow({ where: { id: leased.id } })).error).toBe('电脑已断开');
    expect((await prisma.nodeJob.findUniqueOrThrow({ where: { id: done.id } })).status).toBe('done');
    expect((await prisma.orchestrationStep.findUniqueOrThrow({ where: { id: step.id } }))).toMatchObject({ status: 'needs_user', error: '电脑已断开，这一步已取消' });
    expect((await prisma.orchestrationStep.findUniqueOrThrow({ where: { id: verifying.id } })).status).toBe('needs_user');
    expect((await prisma.orchestrationStep.findUniqueOrThrow({ where: { id: doneStep.id } })).status).toBe('succeeded');
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: running.id } }))).toMatchObject({ status: 'paused', pauseReason: 'computer_offline' });
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: extra.id } })).pauseReason).toBe('computer_offline');
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: viaStep.id } })).pauseReason).toBe('computer_offline');
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: untouched.id } })).status).toBe('running');
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe('awaiting_acceptance');
    expect((await prisma.orchestrationStep.findUniqueOrThrow({ where: { id: push.id } })).status).toBe('needs_user');
    expect((await prisma.nodeJob.findMany({ where: { id: { in: [probe.id, inventory.id, cleanup.id] } } })).every((job) => job.status === 'cancelled')).toBe(true);
    expect(JSON.parse((await prisma.worktreeCleanup.findFirstOrThrow({ where: { jobId: cleanup.id } })).resultJson!)).toEqual({ error: '电脑已断开' });
    expect((await prisma.worktreeCleanup.findFirstOrThrow({ where: { jobId: cleanup.id } })).status).toBe('failed');
    expect(JSON.parse((await prisma.orchestrationEvent.findFirstOrThrow({ where: { orchestrationId: running.id, type: 'paused' } })).payload)).toMatchObject({ reason: 'computer_offline', nodeId: node.node.id });

    await tickAllOrchestrations();
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: running.id } }))).toMatchObject({ status: 'paused', pauseReason: 'computer_offline' });
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: extra.id } })).status).toBe('paused');
  });

  it('splits node authentication into revoked, invalid, and missing credentials', async () => {
    const node = await createNode('凭据');
    expect((await lease(node.token)).status).toBe(200);
    data(await owner().post(`/api/nodes/${node.node.id}/revoke`).send({}));
    const revoked = await lease(node.token);
    expect(revoked.status).toBe(401);
    expect(revoked.body).toMatchObject({ code: 'NODE_REVOKED', error: '电脑已断开' });
    const garbage = await lease(`${stamp}-not-a-token`);
    expect(garbage.status).toBe(401);
    expect(garbage.body).toMatchObject({ code: 'NODE_TOKEN_INVALID', error: '电脑凭据无效' });
    const missing = await supertest(app).post('/api/v1/node/lease').send({ capabilities: caps() });
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ code: 'AUTH_REQUIRED', error: '缺少电脑凭据' });
    const ghost = await createNode('已删除凭据');
    await prisma.agentNode.update({ where: { id: ghost.node.id }, data: { deletedAt: at() } });
    const deleted = await lease(ghost.token);
    expect(deleted.status).toBe(401);
    expect(deleted.body.code).toBe('NODE_REVOKED');
  });

  it('refuses to resume a computer_offline round and still allows redispatch', async () => {
    const node = await createNode('恢复');
    const project = await createProject('恢复项目');
    const main = await createTask('恢复主任务');
    await createTask('恢复子任务', { parentId: main.id });
    data(await owner().put(`/api/project-bindings/task/${main.id}`).send({ projectId: project.id }));
    const paused = await createOrchestration({ taskId: main.id, projectId: project.id, nodeId: node.node.id, status: 'paused', pauseReason: 'computer_offline' });
    const denied = await owner().post(`/api/orchestrations/${paused.id}/resume`).send({});
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ code: 'COMPUTER_OFFLINE', error: '这台电脑已断开，请重新派发并另选电脑' });
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: paused.id } })).status).toBe('paused');
    const again = data(await owner().post(`/api/orchestrations/${paused.id}/redispatch`).send({}));
    ids.orchestrations.push(again.id);
    expect(again.status).toBe('draft');
    expect(again.id).not.toBe(paused.id);
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: paused.id } })).status).toBe('superseded');
  });

  it('reissues a token for an active computer, cancels its work, and rejects a revoked computer', async () => {
    const created = await createNode('签发');
    const project = await createProject('签发项目');
    const task = await createTask('签发任务');
    const running = await createOrchestration({ taskId: task.id, projectId: project.id, nodeId: created.node.id, status: 'running' });
    const step = await createStep(running.id, { status: 'dispatched' });
    const job = await createJob({ nodeId: created.node.id, kind: 'run', status: 'leased', orchestrationId: running.id, stepId: step.id, dispatchKey: `${stamp}-reissue` });
    await prisma.orchestrationStep.update({ where: { id: step.id }, data: { lastJobId: job.id } });
    const next = data(await owner().post(`/api/nodes/${created.node.id}/token`).send({}));
    expect(next.token).not.toBe(created.token);
    expect(next.node.status).toBe('active');
    expect(next.serverUrl).toBeTruthy();
    expect(next.command).toContain(next.token);
    expect(next.cancelledJobIds).toBeUndefined();
    const oldLease = await lease(created.token);
    expect(oldLease.status).toBe(401);
    expect(oldLease.body.code).toBe('NODE_TOKEN_INVALID');
    const fresh = await lease(next.token);
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.nodeId).toBe(created.node.id);
    expect((await prisma.nodeJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('cancelled');
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: running.id } }))).toMatchObject({ status: 'paused', pauseReason: 'computer_offline' });
    expect((await prisma.agentNode.findUniqueOrThrow({ where: { id: created.node.id } })).status).toBe('active');
    data(await owner().post(`/api/nodes/${created.node.id}/revoke`).send({}));
    const denied = await owner().post(`/api/nodes/${created.node.id}/token`).send({});
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ code: 'NODE_UNAVAILABLE', error: '已断开的电脑不能重新生成连接命令' });
  });

  it('deletes only a revoked computer, keeps jobs and the historical name, and hides it from lists', async () => {
    const active = await createNode('还在线');
    const activeDelete = await owner().delete(`/api/nodes/${active.node.id}`);
    expect(activeDelete.status).toBe(409);
    expect(activeDelete.body).toMatchObject({ code: 'NODE_NOT_REVOKED', error: '只能删除已断开的电脑' });

    const occupied = await createNode('有位置');
    const occupiedProject = await createProject('占用项目');
    const occupiedTask = await createTask('占用任务');
    const occupiedLocation = await verifyLocation(occupiedProject.id, occupied.node.id, '/repos/occupied');
    data(await owner().post(`/api/nodes/${occupied.node.id}/revoke`).send({}));
    const needsConfirm = await owner().delete(`/api/nodes/${occupied.node.id}`);
    expect(needsConfirm.status).toBe(409);
    expect(needsConfirm.body).toMatchObject({ code: 'NODE_HAS_LOCATIONS', error: '这台电脑还有项目位置，确认后会一并移除' });
    expect(needsConfirm.body.details.locationIds).toContain(occupiedLocation);
    const busy = await createOrchestration({ taskId: occupiedTask.id, projectId: occupiedProject.id, nodeId: occupied.node.id, locationId: occupiedLocation, status: 'paused' });
    const blocked = await owner().delete(`/api/nodes/${occupied.node.id}`).query({ removeLocations: '1' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ORCHESTRATION_ACTIVE');
    await prisma.orchestration.update({ where: { id: busy.id }, data: { status: 'cancelled' } });

    const name = '历史电脑名';
    const node = await createNode(name);
    const project = await createProject('历史项目');
    const task = await createTask('历史任务');
    const locationId = await verifyLocation(project.id, node.node.id, '/repos/history');
    const round = await createOrchestration({ taskId: task.id, projectId: project.id, nodeId: node.node.id, locationId, status: 'cancelled' });
    const job = await createJob({ nodeId: node.node.id, kind: 'run', status: 'done', orchestrationId: round.id, dispatchKey: `${stamp}-history` });
    data(await owner().post(`/api/nodes/${node.node.id}/revoke`).send({}));
    data(await owner().delete(`/api/nodes/${node.node.id}`).query({ removeLocations: '1' }));
    const row = await prisma.agentNode.findUniqueOrThrow({ where: { id: node.node.id } });
    expect(row.deletedAt).toBeTruthy();
    expect(await prisma.nodeJob.findUnique({ where: { id: job.id } })).toBeTruthy();
    expect(await prisma.projectLocation.findUnique({ where: { id: locationId } })).toBeNull();
    const feed = await orchestrationFeed({ projectId: project.id, status: 'all', limit: 20 });
    expect(feed.items.find((item) => item.id === round.id)?.nodeName).toBe(name);
    const listed = data(await owner().get('/api/nodes')) as Array<{ id: string }>;
    expect(listed.some((item) => item.id === node.node.id)).toBe(false);

    const ghost = await createNode('幽灵电脑');
    await prisma.agentNode.update({ where: { id: ghost.node.id }, data: { deletedAt: at(), lastSeenAt: at() } });
    expect((data(await owner().get('/api/nodes')) as Array<{ id: string }>).some((item) => item.id === ghost.node.id)).toBe(false);
    expect((data(await owner().get('/api/worktrees')) as Array<{ node: { id: string } }>).some((view) => view.node.id === ghost.node.id)).toBe(false);
    const tools = await readOrchestration({ action: 'nodes' }) as { items: Array<{ id: string }> };
    expect(tools.items.some((item) => item.id === ghost.node.id)).toBe(false);
  });

  it('renames only an active computer', async () => {
    const node = await createNode('旧名字');
    const renamed = data(await owner().patch(`/api/nodes/${node.node.id}`).send({ name: '  新名字  ' }));
    expect(renamed.name).toBe('新名字');
    expect((data(await owner().get('/api/nodes')) as Array<{ id: string; name: string }>).find((item) => item.id === node.node.id)?.name).toBe('新名字');
    expect((await owner().patch(`/api/nodes/${node.node.id}`).send({ name: '' })).status).toBe(400);
    data(await owner().post(`/api/nodes/${node.node.id}/revoke`).send({}));
    const denied = await owner().patch(`/api/nodes/${node.node.id}`).send({ name: '不行' });
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ code: 'NODE_UNAVAILABLE', error: '已断开的电脑不能改名' });
    const missing = await owner().patch('/api/nodes/missing-node').send({ name: '没有' });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('电脑不存在');
  });

  it('stores defaultParallel, caps preview by the computer, and archives projects', async () => {
    const project = await createProject('并行项目');
    expect(project.defaultParallel).toBe(2);
    const node = await createNode('并行电脑');
    await prisma.agentNode.update({ where: { id: node.node.id }, data: { capabilitiesJson: JSON.stringify({ protocol: 2, maxConcurrent: 3, providers: [codex()] }), lastSeenAt: at() } });
    const locationId = await verifyLocation(project.id, node.node.id, '/repos/parallel');
    const draft = await draftFor(project.id, '并行主任务');
    expect(draft.grant.maxParallel).toBe(2);
    expect(draft.locations[0]).toMatchObject({ id: locationId, providers: [expect.objectContaining({ provider: 'codex', available: true })] });

    await prisma.agentNode.update({ where: { id: node.node.id }, data: { capabilitiesJson: JSON.stringify({ protocol: 2, maxConcurrent: 1, providers: [codex()] }) } });
    const tighter = await draftFor(project.id, '更小上限');
    expect(tighter.grant.maxParallel).toBe(1);

    await prisma.agentNode.update({ where: { id: node.node.id }, data: { capabilitiesJson: JSON.stringify({ protocol: 2, maxConcurrent: 2, providers: [codex()] }) } });
    const tooHigh = await owner().patch(`/api/projects/${project.id}`).send({ defaultParallel: 3, expectedRevision: project.revision });
    expect(tooHigh.status).toBe(409);
    expect(tooHigh.body.code).toBe('PARALLEL_EXCEEDS_NODE');
    expect(tooHigh.body.error).toBe('并行数不能超过电脑「并行电脑」的并发上限 2');
    expect(tooHigh.body.details).toMatchObject({ maxConcurrent: 2, nodeId: node.node.id, nodeName: '并行电脑' });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).revision).toBe(project.revision);

    await prisma.agentNode.update({ where: { id: node.node.id }, data: { capabilitiesJson: '{}' } });
    const raised = data(await owner().patch(`/api/projects/${project.id}`).send({ defaultParallel: 4, expectedRevision: project.revision }));
    expect(raised.defaultParallel).toBe(4);
    const invalid = await owner().patch(`/api/projects/${project.id}`).send({ defaultParallel: 5, expectedRevision: raised.revision });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('VALIDATION_ERROR');
    await prisma.agentNode.update({ where: { id: node.node.id }, data: { capabilitiesJson: JSON.stringify({ maxConcurrent: 2 }) } });
    const renamed = data(await owner().patch(`/api/projects/${project.id}`).send({ name: '并行项目改名', expectedRevision: raised.revision }));
    expect(renamed.defaultParallel).toBe(4);

    const bare = await createProject('没有电脑');
    expect((data(await owner().patch(`/api/projects/${bare.id}`).send({ defaultParallel: 4, expectedRevision: bare.revision }))).defaultParallel).toBe(4);

    const archived = data(await owner().patch(`/api/projects/${project.id}`).send({ archived: true, expectedRevision: renamed.revision }));
    expect(archived.archivedAt).toBeTruthy();
    const open = data(await owner().get('/api/projects')) as Array<{ id: string }>;
    expect(open.some((item) => item.id === project.id)).toBe(false);
    const closed = data(await owner().get('/api/projects').query({ archived: '1' })) as Array<{ id: string; locations: Array<{ nodeStatus: string }>; topicIds: string[] }>;
    const found = closed.find((item) => item.id === project.id);
    expect(found?.locations[0].nodeStatus).toBe('active');
    expect(found?.topicIds).toEqual([]);
    const restored = data(await owner().patch(`/api/projects/${project.id}`).send({ archived: false, expectedRevision: archived.revision }));
    expect(restored.archivedAt).toBeNull();
    expect((data(await owner().get('/api/projects')) as Array<{ id: string }>).some((item) => item.id === project.id)).toBe(true);

    const hidden = await createNode('预览里消失');
    const hiddenLocation = await verifyLocation(project.id, hidden.node.id, '/repos/hidden');
    await prisma.agentNode.update({ where: { id: hidden.node.id }, data: { deletedAt: at() } });
    const visible = await draftFor(project.id, '过滤删除');
    expect(visible.locations.some((location) => location.id === hiddenLocation)).toBe(false);
    expect(visible.locations.some((location) => location.id === locationId)).toBe(true);
  });

  it('asks before replacing a location path and re-verifies with a new dispatch key', async () => {
    const project = await createProject('位置项目');
    const node = await createNode('位置电脑');
    const first = data(await owner().post(`/api/projects/${project.id}/locations`).send({ nodeId: node.node.id, path: '/repos/a' }));
    const same = data(await owner().post(`/api/projects/${project.id}/locations`).send({ nodeId: node.node.id, path: '/repos/a' }));
    expect(same.location.id).toBe(first.location.id);
    expect(same.jobId).toBeTruthy();
    const clash = await owner().post(`/api/projects/${project.id}/locations`).send({ nodeId: node.node.id, path: '/repos/b' });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('LOCATION_REPLACE');
    expect(clash.body.error).toBe('这台电脑上已有项目位置，确认后会改成新路径并重新验证');
    expect(clash.body.details).toEqual({ locationId: first.location.id, currentPath: '/repos/a' });
    const replaced = data(await owner().post(`/api/projects/${project.id}/locations`).send({ nodeId: node.node.id, path: '/repos/b', replace: true }));
    const probe = await prisma.nodeJob.findUniqueOrThrow({ where: { id: replaced.jobId } });
    expect(probe.status).toBe('queued');
    expect(JSON.parse(probe.payloadJson).path).toBe('/repos/b');
    expect(probe.dispatchKey.startsWith(`probe:${replaced.location.id}:`)).toBe(true);

    const replay = data(await owner().post(`/api/projects/${project.id}/locations/${replaced.location.id}/verify`).send({}));
    const again = data(await owner().post(`/api/projects/${project.id}/locations/${replaced.location.id}/verify`).send({}));
    expect(again.jobId).toBe(replay.jobId);
    expect(again.replay).toBe(true);
    const prior = await prisma.nodeJob.findMany({ where: { dispatchKey: { startsWith: `probe:${replaced.location.id}:` } } });
    await prisma.nodeJob.updateMany({ where: { id: { in: prior.map((job) => job.id) } }, data: { status: 'done', updatedAt: at() } });
    const fresh = data(await owner().post(`/api/projects/${project.id}/locations/${replaced.location.id}/verify`).send({}));
    expect(prior.map((job) => job.id)).not.toContain(fresh.jobId);
    const created = await prisma.nodeJob.findUniqueOrThrow({ where: { id: fresh.jobId } });
    expect(prior.map((job) => job.dispatchKey)).not.toContain(created.dispatchKey);
    expect(created.dispatchKey.startsWith(`probe:${replaced.location.id}:`)).toBe(true);
    expect((await prisma.projectLocation.findUniqueOrThrow({ where: { id: replaced.location.id } })).status).toBe('pending');

    data(await owner().post(`/api/nodes/${node.node.id}/revoke`).send({}));
    const denied = await owner().post(`/api/projects/${project.id}/locations/${replaced.location.id}/verify`).send({});
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ code: 'NODE_UNAVAILABLE', error: '电脑已断开' });
  });

  it('binds topics in a batch, reports occupancy, and leaves task bindings alone', async () => {
    const project = await createProject('清单甲');
    const other = await createProject('清单乙');
    const archived = await createProject('清单归档');
    const topicA = await createTopic(`${stamp}-A`);
    const topicB = await createTopic(`${stamp}-B`);
    const topicC = await createTopic(`${stamp}-C`);
    const task = await createTask('任务级绑定', { topicId: topicA.id });
    data(await owner().put(`/api/project-bindings/task/${task.id}`).send({ projectId: project.id }));

    const bound = data(await owner().put(`/api/projects/${project.id}/topic-bindings`).send({ topicIds: [topicA.id, topicA.id, topicB.id], expectedRevision: project.revision }));
    expect(bound).toMatchObject({ projectId: project.id, topicIds: [topicA.id, topicB.id], revision: project.revision + 1 });
    const clash = await owner().put(`/api/projects/${other.id}/topic-bindings`).send({ topicIds: [topicA.id], expectedRevision: other.revision });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('TOPIC_BOUND');
    expect(clash.body.error).toBe('有清单已绑定到其他项目');
    expect(clash.body.details.bindings).toEqual([{ topicId: topicA.id, projectId: project.id, projectName: '清单甲' }]);
    const moved = data(await owner().put(`/api/projects/${other.id}/topic-bindings`).send({ topicIds: [topicA.id], replace: true, expectedRevision: other.revision }));
    expect(moved.topicIds).toEqual([topicA.id]);
    const listed = data(await owner().get('/api/project-bindings').query({ scopeType: 'topic' })) as { items: Array<{ scopeId: string; projectId: string }> };
    expect(listed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeId: topicA.id, projectId: other.id }),
      expect.objectContaining({ scopeId: topicB.id, projectId: project.id }),
    ]));
    const view = data(await owner().get(`/api/projects/${project.id}`));
    expect(view.topicIds).not.toContain(topicA.id);
    expect(view.topicIds).toContain(topicB.id);

    const removed = data(await owner().put(`/api/projects/${project.id}/topic-bindings`).send({ topicIds: [], expectedRevision: view.revision }));
    expect(removed.topicIds).toEqual([]);
    expect(data(await owner().get(`/api/project-bindings/topic/${topicB.id}`)).projectId).toBeNull();
    expect(data(await owner().get(`/api/project-bindings/task/${task.id}`)).projectId).toBe(project.id);

    const stale = await owner().put(`/api/projects/${project.id}/topic-bindings`).send({ topicIds: [topicC.id], expectedRevision: project.revision });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', error: '项目已被修改，请刷新' });
    const current = data(await owner().get(`/api/projects/${project.id}`));
    const absent = await owner().put(`/api/projects/${project.id}/topic-bindings`).send({ topicIds: [topicC.id, `${stamp}-missing`], expectedRevision: current.revision });
    expect(absent.status).toBe(404);
    expect(absent.body.error).toBe('清单不存在');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).revision).toBe(current.revision);

    data(await owner().put(`/api/projects/${archived.id}/topic-bindings`).send({ topicIds: [topicC.id], expectedRevision: archived.revision }));
    const archivedRow = data(await owner().get(`/api/projects/${archived.id}`));
    data(await owner().patch(`/api/projects/${archived.id}`).send({ archived: true, expectedRevision: archivedRow.revision }));
    const taken = data(await owner().put(`/api/projects/${other.id}/topic-bindings`).send({ topicIds: [topicA.id, topicC.id], expectedRevision: moved.revision }));
    expect(taken.topicIds).toEqual([topicA.id, topicC.id]);
    expect(data(await owner().get(`/api/project-bindings/task/${task.id}`)).projectId).toBe(project.id);
  });

  it('rejects a start when a selected computer lacks the provider or cannot run that many jobs', async () => {
    const project = await createProject('启动项目');
    const primary = await createNode('主电脑');
    const extra = await createNode('附加电脑');
    const origin = { originUrl: 'https://example.com/repo.git' };
    const primaryLocation = await verifyLocation(project.id, primary.node.id, '/repos/primary', origin);
    const extraLocation = await verifyLocation(project.id, extra.node.id, '/repos/extra', origin);
    await prisma.agentNode.update({ where: { id: primary.node.id }, data: { capabilitiesJson: '{}' } });
    await prisma.agentNode.update({ where: { id: extra.node.id }, data: { capabilitiesJson: JSON.stringify({ protocol: 2, providers: [codex(false)], maxConcurrent: 4 }) } });
    const draft = await draftFor(project.id, '启动主任务');
    const unreported = await owner().post(`/api/orchestrations/${draft.id}/start`).send({ expectedRevision: draft.revision, locationId: primaryLocation, maxParallel: 1 });
    expect(unreported.status).toBe(409);
    expect(unreported.body.code).toBe('PROVIDER_UNAVAILABLE');
    expect(unreported.body.error).toBe('电脑「主电脑」上没有可用的 codex');

    await prisma.agentNode.update({ where: { id: primary.node.id }, data: { capabilitiesJson: JSON.stringify({ protocol: 2, providers: [codex()], maxConcurrent: 4 }) } });
    const extraMissing = await owner().post(`/api/orchestrations/${draft.id}/start`).send({ expectedRevision: draft.revision, locationId: primaryLocation, extraLocationIds: [extraLocation], maxParallel: 1 });
    expect(extraMissing.status).toBe(409);
    expect(extraMissing.body.code).toBe('PROVIDER_UNAVAILABLE');
    expect(extraMissing.body.error).toBe('电脑「附加电脑」上没有可用的 codex');

    await prisma.agentNode.update({ where: { id: extra.node.id }, data: { capabilitiesJson: JSON.stringify({ protocol: 2, providers: [codex()] }) } });
    const over = await owner().post(`/api/orchestrations/${draft.id}/start`).send({ expectedRevision: draft.revision, locationId: primaryLocation, extraLocationIds: [extraLocation], maxParallel: 2 });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('PARALLEL_EXCEEDS_NODE');
    expect(over.body.error).toBe('并行数不能超过电脑「附加电脑」的并发上限 0');
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('draft');
  });

  it('does not count computer_offline as a failure', () => {
    expect(classifyFailure({ pauseReason: 'computer_offline', error: '429', exitCode: 1, hasResult: false })).toBeNull();
    expect(classifyFailure({ pauseReason: 'node_offline' })).toBe('other');
  });

  it('accepts old and new capability reports and returns caps_v2 plus nodeId', async () => {
    expect(NODE_PROTOCOL_VERSION).toBe(2);
    const old = { protocol: 2, providers: [{ provider: 'codex' as const, available: true }], maxConcurrent: 2 };
    const parsed = capabilitiesSchema.parse(old);
    expect(parsed.providers[0].path).toBe('');
    expect(parsed.managedBy).toBe('cli');
    expect(parsed.logPath).toBeNull();
    expect(parsed.lastError).toBeNull();
    expect(parsed.startedAt).toBeNull();
    const rich = capabilitiesSchema.parse({ ...old, providers: [{ provider: 'codex', available: true, version: '1', path: '/bin/codex' }], managedBy: 'desktop', logPath: '/tmp/node.log', lastError: 'boom', startedAt: '2026-10-21T00:00:00.000Z' });
    expect(rich.managedBy).toBe('desktop');
    expect(rich.providers[0].path).toBe('/bin/codex');
    expect(rich.logPath).toBe('/tmp/node.log');
    expect(capabilitiesSchema.safeParse({ ...old, lastError: 'x'.repeat(501) }).success).toBe(false);

    const node = await createNode('协议');
    const leased = await lease(node.token, { capabilities: old, activeJobIds: [], max: 1 });
    expect(leased.status).toBe(200);
    expect(leased.body.data.accepts).toEqual(['usage_v1', 'caps_v2']);
    expect(leased.body.data.nodeId).toBe(node.node.id);
    const stored = JSON.parse((await prisma.agentNode.findUniqueOrThrow({ where: { id: node.node.id } })).capabilitiesJson) as { managedBy: string; providers: Array<{ path: string }> };
    expect(stored.managedBy).toBe('cli');
    expect(stored.providers[0].path).toBe('');
    const tooLong = await lease(node.token, { capabilities: { ...old, lastError: 'y'.repeat(501) }, activeJobIds: [], max: 1 });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a node token and an anonymous caller on the new owner routes', async () => {
    const node = await createNode('越权');
    const anonymous = await supertest(app).get('/api/project-bindings').query({ scopeType: 'topic' });
    expect(anonymous.status).toBeGreaterThanOrEqual(400);
    const asNode = await supertest(app).patch(`/api/nodes/${node.node.id}`).set('Authorization', `Node ${node.token}`).send({ name: 'hacked' });
    expect(asNode.status).toBeGreaterThanOrEqual(400);
    expect((await prisma.agentNode.findUniqueOrThrow({ where: { id: node.node.id } })).name).toBe('越权');
  });
});
