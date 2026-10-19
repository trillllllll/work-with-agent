/**
 * Orchestration state machine. The server only plans, dispatches NodeJobs, reads reports, compares
 * fields and decides. Every real action (worktrees, coding, commits, merges, tests, push) happens
 * on a local executor (wwa-node) and its local AI runs.
 */
import { z } from 'zod';
import type { NodeJob, Orchestration, OrchestrationStep, Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/prisma.js';
import { DomainError } from '../../domain/task.js';
import { internalActor } from '../security.js';
import { TaskService } from '../workspace-task.js';
import { providerSchema, type RunResult } from '../../runner/contracts.js';
import { prepareResultSchema, pushResultSchema, runResultSchema, type GitFacts, type RunPayload } from '../../node-agent/protocol.js';
import { activeJobStatuses, enqueueJob, expireLeases, isOnline, jobDto, now } from './nodes.js';
import { applyProbeResult, resolveProjectForTask } from './projects.js';
import { appendOrchestrationEvent, publishOrchestration } from './events.js';
import { generatePlan, planSchema, reviewDevelop, reviewFinal, validatePlan, type Plan } from './planner.js';
import { checkDevelop, checkMerge, checkVerify, looksGitWriteDenied, looksRateLimited } from './checks.js';
import { developPrompt, mergePrompt, verifyPrompt } from './prompts.js';

type Db = Prisma.TransactionClient;
type Grant = { provider: 'codex' | 'claude'; maxParallel: number; allowShell: boolean };
type Snapshot = { main: { id: string; title: string; description: string }; subtasks: Array<{ id: string; title: string; description: string; sortOrder: number; revision: number }> };
const OPEN = ['draft', 'running', 'paused', 'awaiting_acceptance'];
const MAX_CONTINUE = 2;
const MAX_RATE_RETRIES = 3;
const tasks = new TaskService();
const decode = <T>(value: string) => JSON.parse(value) as T;

const queues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  queues.set(key, current);
  return current.finally(() => { if (queues.get(key) === current) queues.delete(key); }) as Promise<T>;
}

export function slug(value: string, fallback: string) {
  const ascii = value.normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  return ascii.length >= 3 ? ascii : fallback;
}
const shortId = (id: string) => id.slice(-8).toLowerCase();

async function snapshotFor(taskId: string): Promise<Snapshot> {
  const main = await prisma.task.findUnique({ where: { id: taskId }, include: { children: { where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } } });
  if (!main || main.deletedAt) throw new DomainError('NOT_FOUND', '任务不存在', 404);
  if (main.parentId) throw new DomainError('INVALID_SCOPE', '只能对顶层任务开始运行', 400);
  return { main: { id: main.id, title: main.title, description: main.description }, subtasks: main.children.map((child) => ({ id: child.id, title: child.title, description: child.description, sortOrder: child.sortOrder, revision: child.revision })) };
}

function orchestrationDto(row: Orchestration & { steps?: OrchestrationStep[] }) {
  const { grantJson, planJson, taskSnapshotJson, steps, ...value } = row;
  return { ...value, grant: decode(grantJson), plan: decode(planJson), taskSnapshot: decode(taskSnapshotJson), ...(steps ? { steps: steps.map((step) => ({ ...step, dependsOn: decode(step.dependsOnJson) })) } : {}) };
}

async function setStatus(tx: Db, row: Orchestration, status: string, extra: Partial<Orchestration> = {}) {
  const updated = await tx.orchestration.update({ where: { id: row.id }, data: { status, ...extra, revision: { increment: 1 }, updatedAt: now() } });
  return updated;
}
async function pause(id: string, reason: string, detail?: unknown) {
  const row = await prisma.orchestration.findUniqueOrThrow({ where: { id } });
  if (row.status !== 'running') return row;
  const updated = await prisma.$transaction(async (tx) => {
    const value = await setStatus(tx, row, 'paused', { pauseReason: reason });
    await appendOrchestrationEvent(tx, id, 'paused', 'server', null, { reason, detail });
    return value;
  });
  publishOrchestration({ orchestrationId: id, taskId: row.taskId, status: 'paused', pauseReason: reason });
  return updated;
}
async function updateTaskStatus(taskId: string, status: 'doing' | 'done' | 'blocked', orchestrationId: string, extra: Record<string, unknown> = {}) {
  try {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.deletedAt || task.status === status) return task?.revision ?? null;
    if (status === 'doing' && !['todo', 'blocked'].includes(task.status)) return task.revision;
    const updated = await tasks.update(taskId, { status, ...extra }, { source: 'agent', actor: { ...internalActor, id: `orchestrator:${orchestrationId}` } });
    return (updated as { revision?: number }).revision ?? null;
  } catch (error) {
    await prisma.$transaction((tx) => appendOrchestrationEvent(tx, orchestrationId, 'task_update_failed', 'server', null, { taskId, status, error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

export class OrchestrationService {
  async list(taskId?: string) {
    const rows = await prisma.orchestration.findMany({ where: taskId ? { taskId } : {}, include: { steps: { orderBy: { position: 'asc' } } }, orderBy: [{ createdAt: 'desc' }] });
    return rows.map(orchestrationDto);
  }
  async attention() {
    const rows = await prisma.orchestration.findMany({ where: { status: { in: ['awaiting_acceptance', 'paused', 'running'] } }, select: { id: true, taskId: true, status: true, pauseReason: true } });
    return { items: rows.map((row) => ({ orchestrationId: row.id, taskId: row.taskId, status: row.status, pauseReason: row.pauseReason })) };
  }
  async get(id: string) {
    const row = await prisma.orchestration.findUnique({ where: { id }, include: { steps: { orderBy: { position: 'asc' } } } });
    if (!row) throw new DomainError('NOT_FOUND', '编排不存在', 404);
    const [events, jobs] = await Promise.all([
      prisma.orchestrationEvent.findMany({ where: { orchestrationId: id }, orderBy: { seq: 'asc' }, take: 500 }),
      prisma.nodeJob.findMany({ where: { orchestrationId: id }, orderBy: { createdAt: 'asc' } }),
    ]);
    const node = row.nodeId ? await prisma.agentNode.findUnique({ where: { id: row.nodeId } }) : null;
    return { ...orchestrationDto(row), node: node ? { id: node.id, name: node.name, online: isOnline(node) } : null, events: events.map((event) => ({ ...event, payload: decode(event.payload) })), jobs: jobs.map(jobDto) };
  }

  /** Draft: resolve the project, ask the orchestrator model for a plan (or a sequential fallback). */
  async preview(raw: unknown) {
    const input = z.object({ taskId: z.string().min(1) }).strict().parse(raw);
    const snapshot = await snapshotFor(input.taskId);
    if (!snapshot.subtasks.length) throw new DomainError('NO_SUBTASKS', '主任务还没有子任务，先拆分子任务再开始运行', 400);
    const { project } = await resolveProjectForTask(input.taskId);
    const open = await prisma.orchestration.findFirst({ where: { taskId: input.taskId, status: { in: OPEN } } });
    if (open && open.status !== 'draft') throw new DomainError('ORCHESTRATION_OPEN', '该任务已有进行中的编排', 409);
    const { plan, raw: modelRaw } = await generatePlan(snapshot.main, snapshot.subtasks);
    const locations = await prisma.projectLocation.findMany({ where: { projectId: project.id, status: 'verified' }, include: { node: true } });
    const ranked = locations.sort((a, b) => Number(isOnline(b.node)) - Number(isOnline(a.node)));
    const round = open?.round ?? ((await prisma.orchestration.aggregate({ where: { taskId: input.taskId }, _max: { round: true } }))._max.round ?? 0) + 1;
    const integrationBranch = `orch/${slug(snapshot.main.title, shortId(snapshot.main.id))}-r${round}`;
    const data = { projectId: project.id, defaultBranch: project.defaultBranch, integrationBranch, planJson: JSON.stringify(plan), taskSnapshotJson: JSON.stringify(snapshot), grantJson: JSON.stringify({ provider: project.defaultProvider, maxParallel: 2, allowShell: true }), updatedAt: now() };
    const row = await prisma.$transaction(async (tx) => {
      const saved = open
        ? await tx.orchestration.update({ where: { id: open.id }, data: { ...data, revision: { increment: 1 } } })
        : await tx.orchestration.create({ data: { ...data, taskId: input.taskId, round, createdAt: now() } });
      await appendOrchestrationEvent(tx, saved.id, 'plan_generated', 'model', null, { plan, raw: modelRaw });
      return saved;
    });
    return { ...orchestrationDto(row), locations: ranked.map((location) => ({ id: location.id, nodeId: location.nodeId, nodeName: location.node.name, online: isOnline(location.node), path: location.path })) };
  }

  /** One-time authorization; after this nothing asks the user step by step. */
  async start(id: string, raw: unknown) {
    const input = z.object({ expectedRevision: z.number().int().positive(), locationId: z.string().min(1), provider: providerSchema.optional(), maxParallel: z.number().int().min(1).max(4).default(2), allowShell: z.boolean().default(true), plan: planSchema.optional() }).strict().parse(raw);
    const row = await prisma.orchestration.findUnique({ where: { id } });
    if (!row) throw new DomainError('NOT_FOUND', '编排不存在', 404);
    if (row.status !== 'draft') throw new DomainError('ORCHESTRATION_STARTED', '编排已经开始', 409);
    if (row.revision !== input.expectedRevision) throw new DomainError('PLAN_STALE', '计划已更新，请刷新后再确认', 409);
    const snapshot = decode<Snapshot>(row.taskSnapshotJson);
    const current = await snapshotFor(row.taskId);
    if (current.subtasks.map((task) => task.id).join() !== snapshot.subtasks.map((task) => task.id).join()) throw new DomainError('PLAN_STALE', '子任务已变化，请重新生成计划', 409);
    const plan: Plan = input.plan ?? decode<Plan>(row.planJson);
    try { validatePlan(plan, snapshot.subtasks); } catch (error) { throw new DomainError('INVALID_PLAN', (error as Error).message, 400); }
    const location = await prisma.projectLocation.findUnique({ where: { id: input.locationId }, include: { node: true } });
    if (!location || location.projectId !== row.projectId) throw new DomainError('LOCATION_REQUIRED', '请选择该项目在某台执行端上的位置', 400);
    if (location.status !== 'verified') throw new DomainError('LOCATION_UNVERIFIED', '该位置还没有通过执行端验证', 400);
    if (location.node.status !== 'active') throw new DomainError('NODE_UNAVAILABLE', '执行端已吊销', 400);
    const project = await prisma.project.findUniqueOrThrow({ where: { id: row.projectId } });
    const grant: Grant = { provider: input.provider ?? providerSchema.parse(project.defaultProvider), maxParallel: input.maxParallel, allowShell: input.allowShell };
    const started = await prisma.$transaction(async (tx) => {
      const changed = await tx.orchestration.updateMany({ where: { id, status: 'draft', revision: input.expectedRevision }, data: { status: 'running', locationId: location.id, nodeId: location.nodeId, repoPath: location.path, grantJson: JSON.stringify(grant), planJson: JSON.stringify(plan), startedAt: now(), updatedAt: now(), revision: { increment: 1 } } });
      if (!changed.count) throw new DomainError('PLAN_STALE', '编排已变化', 409);
      let position = 0;
      await tx.orchestrationStep.create({ data: { orchestrationId: id, kind: 'setup', position: position++, createdAt: now(), updatedAt: now() } });
      const byTask = new Map(plan.steps.map((step) => [step.taskId, step]));
      for (const subtaskId of validatePlan(plan, snapshot.subtasks)) {
        const step = byTask.get(subtaskId)!;
        const develop = await tx.orchestrationStep.create({ data: { orchestrationId: id, kind: 'develop', subtaskId, dependsOnJson: JSON.stringify(step.dependsOn), acceptanceCriteria: step.acceptanceCriteria, position: position++, createdAt: now(), updatedAt: now() } });
        await tx.orchestrationStep.create({ data: { orchestrationId: id, kind: 'merge', subtaskId, sourceStepId: develop.id, position: position++, createdAt: now(), updatedAt: now() } });
      }
      await tx.orchestrationStep.create({ data: { orchestrationId: id, kind: 'final', position: position++, createdAt: now(), updatedAt: now() } });
      await appendOrchestrationEvent(tx, id, 'started', 'user', null, { grant, locationId: location.id, nodeId: location.nodeId });
      return tx.orchestration.findUniqueOrThrow({ where: { id } });
    });
    await updateTaskStatus(row.taskId, 'doing', id);
    publishOrchestration({ orchestrationId: id, taskId: row.taskId, status: 'running' });
    await tickOrchestration(id);
    return this.get(started.id);
  }

  async pause(id: string) {
    const row = await this.requireStatus(id, ['running']);
    await prisma.$transaction(async (tx) => { await setStatus(tx, row, 'paused', { pauseReason: 'user_paused' }); await appendOrchestrationEvent(tx, id, 'paused', 'user', null, { reason: 'user_paused' }); });
    publishOrchestration({ orchestrationId: id, taskId: row.taskId, status: 'paused', pauseReason: 'user_paused' });
    return this.get(id);
  }
  async resume(id: string) {
    const row = await this.requireStatus(id, ['paused']);
    await prisma.$transaction(async (tx) => { await setStatus(tx, row, 'running', { pauseReason: null }); await appendOrchestrationEvent(tx, id, 'resumed', 'user', null, {}); });
    publishOrchestration({ orchestrationId: id, taskId: row.taskId, status: 'running' });
    await tickOrchestration(id);
    return this.get(id);
  }
  async cancel(id: string) {
    const row = await this.requireStatus(id, ['draft', 'running', 'paused', 'awaiting_acceptance']);
    await prisma.$transaction(async (tx) => {
      await tx.nodeJob.updateMany({ where: { orchestrationId: id, status: { in: [...activeJobStatuses, 'lost'] } }, data: { status: 'cancelled', error: '编排已取消', endedAt: now(), updatedAt: now() } });
      await setStatus(tx, row, 'cancelled', { endedAt: now() });
      await appendOrchestrationEvent(tx, id, 'cancelled', 'user', null, {});
    });
    publishOrchestration({ orchestrationId: id, taskId: row.taskId, status: 'cancelled' });
    return this.get(id);
  }
  /** retry: `continue` keeps the worktree and passes the comment; `fresh` starts a new attempt; `reverify` re-runs only the independent check of a merge. */
  async retryStep(id: string, stepId: string, raw: unknown) {
    const input = z.object({ mode: z.enum(['continue', 'fresh', 'reverify']).default('fresh'), comment: z.string().max(10000).optional() }).strict().parse(raw ?? {});
    const row = await this.requireStatus(id, ['running', 'paused']);
    const step = await prisma.orchestrationStep.findFirst({ where: { id: stepId, orchestrationId: id } });
    if (!step) throw new DomainError('NOT_FOUND', '步骤不存在', 404);
    if (!['needs_user', 'retry_wait'].includes(step.status)) throw new DomainError('STEP_NOT_RETRYABLE', '只有等待处理的步骤可以重试', 409);
    await prisma.$transaction(async (tx) => {
      if (input.mode === 'reverify') {
        if (step.kind !== 'merge' || !step.mergeCommit) throw new DomainError('STEP_NOT_RETRYABLE', '只有已提交的合入可以重新核对', 409);
        await tx.orchestrationStep.update({ where: { id: stepId }, data: { status: 'reverify', error: null, updatedAt: now() } });
      } else if (input.mode === 'continue' && step.kind === 'develop' && step.workPath) {
        await tx.orchestrationStep.update({ where: { id: stepId }, data: { status: 'pending', continueCount: { increment: 1 }, feedback: input.comment ?? step.feedback, error: null, updatedAt: now() } });
      } else {
        await tx.orchestrationStep.update({ where: { id: stepId }, data: { status: step.kind === 'merge' ? 'queued' : 'pending', attempt: { increment: 1 }, continueCount: 0, retryCount: 0, feedback: input.comment ?? null, workPath: step.kind === 'develop' ? null : step.workPath, error: null, updatedAt: now() } });
      }
      await appendOrchestrationEvent(tx, id, 'retried', 'user', stepId, input);
      if (row.status === 'paused') await setStatus(tx, row, 'running', { pauseReason: null });
    });
    await tickOrchestration(id);
    return this.get(id);
  }
  async skipStep(id: string, stepId: string, raw: unknown) {
    const input = z.object({ reason: z.string().trim().min(1).max(2000) }).strict().parse(raw);
    const row = await this.requireStatus(id, ['running', 'paused']);
    const step = await prisma.orchestrationStep.findFirst({ where: { id: stepId, orchestrationId: id } });
    if (!step || !['develop', 'merge'].includes(step.kind)) throw new DomainError('NOT_FOUND', '只能跳过开发或合入步骤', 404);
    if (['succeeded', 'skipped'].includes(step.status)) throw new DomainError('STEP_FINISHED', '步骤已结束', 409);
    await prisma.$transaction(async (tx) => {
      const affected = await tx.orchestrationStep.findMany({ where: { orchestrationId: id, subtaskId: step.subtaskId, kind: step.kind === 'develop' ? { in: ['develop', 'merge'] } : 'merge' } });
      for (const item of affected) await tx.orchestrationStep.update({ where: { id: item.id }, data: { status: 'skipped', error: input.reason, updatedAt: now() } });
      if (step.lastJobId) await tx.nodeJob.updateMany({ where: { id: step.lastJobId, status: { in: activeJobStatuses } }, data: { status: 'cancelled', error: '步骤已跳过', endedAt: now(), updatedAt: now() } });
      await appendOrchestrationEvent(tx, id, 'skipped', 'user', stepId, input);
    });
    if (row.status === 'running') await tickOrchestration(id);
    return this.get(id);
  }
  async accept(id: string) {
    const row = await this.requireStatus(id, ['awaiting_acceptance']);
    await prisma.$transaction(async (tx) => { await setStatus(tx, row, 'accepted', { acceptedAt: now(), endedAt: now() }); await appendOrchestrationEvent(tx, id, 'accepted', 'user', null, {}); });
    await updateTaskStatus(row.taskId, 'done', id);
    publishOrchestration({ orchestrationId: id, taskId: row.taskId, status: 'accepted' });
    return this.get(id);
  }
  /** Explicit user click only. The node pushes mechanically with the user's local credentials. */
  async push(id: string) {
    const row = await this.requireStatus(id, ['accepted', 'awaiting_acceptance']);
    if (!row.nodeId || !row.integrationPath) throw new DomainError('NOT_READY', '集成分支尚未建立', 409);
    const count = await prisma.orchestrationStep.count({ where: { orchestrationId: id, kind: 'push' } });
    await prisma.$transaction(async (tx) => {
      const pending = await tx.orchestrationStep.findFirst({ where: { orchestrationId: id, kind: 'push', status: 'dispatched' } });
      if (pending) throw new DomainError('PUSH_RUNNING', '推送正在进行', 409);
      const step = await tx.orchestrationStep.create({ data: { orchestrationId: id, kind: 'push', position: 1000 + count, status: 'dispatched', branch: row.integrationBranch, createdAt: now(), updatedAt: now() } });
      const { job } = await enqueueJob(tx, { nodeId: row.nodeId!, kind: 'push', dispatchKey: `orch:${step.id}:push`, payload: { worktree: row.integrationPath!, branch: row.integrationBranch, remote: 'origin' }, orchestrationId: id, stepId: step.id });
      await tx.orchestrationStep.update({ where: { id: step.id }, data: { lastJobId: job.id } });
      await appendOrchestrationEvent(tx, id, 'push_requested', 'user', step.id, { branch: row.integrationBranch });
    });
    return this.get(id);
  }
  /** Old round is kept intact (rows, local worktrees, branches); a new draft round is planned from current task content. */
  async redispatch(id: string) {
    const row = await this.requireStatus(id, ['running', 'paused', 'awaiting_acceptance', 'accepted', 'cancelled']);
    if (row.status !== 'accepted' && row.status !== 'cancelled') {
      await prisma.$transaction(async (tx) => {
        await tx.nodeJob.updateMany({ where: { orchestrationId: id, status: { in: [...activeJobStatuses, 'lost'] } }, data: { status: 'cancelled', error: '已重新派发', endedAt: now(), updatedAt: now() } });
        await setStatus(tx, row, 'superseded', { endedAt: now() });
        await appendOrchestrationEvent(tx, id, 'superseded', 'user', null, {});
      });
    }
    return this.preview({ taskId: row.taskId });
  }
  private async requireStatus(id: string, statuses: string[]) {
    const row = await prisma.orchestration.findUnique({ where: { id } });
    if (!row) throw new DomainError('NOT_FOUND', '编排不存在', 404);
    if (!statuses.includes(row.status)) throw new DomainError('INVALID_STATE', `当前状态（${row.status}）不能执行该操作`, 409);
    return row;
  }
}

// ---------------------------------------------------------------- scheduler

function runPayload(row: Orchestration, grant: Grant, input: { worktree: RunPayload['worktree']; prompt: string; gitWrite: boolean; expect?: RunPayload['expect']; profile?: 'read_only' | 'workspace_write' }): RunPayload {
  return { repoPath: row.repoPath, provider: grant.provider, permissions: { profile: input.profile ?? 'workspace_write', allowShell: grant.allowShell }, gitWrite: input.gitWrite, worktree: input.worktree, prompt: input.prompt, expect: input.expect ?? { includes: [] } };
}

async function dispatch(row: Orchestration, step: OrchestrationStep, phase: string, dispatchKey: string, payload: unknown, kind: 'prepare' | 'run', status: string, extra: Partial<OrchestrationStep> = {}) {
  return prisma.$transaction(async (tx) => {
    const { job, replay } = await enqueueJob(tx, { nodeId: row.nodeId!, kind, phase, dispatchKey, payload, orchestrationId: row.id, stepId: step.id });
    const changed = await tx.orchestrationStep.updateMany({ where: { id: step.id, status: step.status }, data: { status, lastJobId: job.id, ...extra, updatedAt: now() } });
    if (!changed.count) throw new Error('STEP_RACE');
    if (!replay) await appendOrchestrationEvent(tx, row.id, 'dispatched', 'server', step.id, { jobId: job.id, kind, phase, dispatchKey });
    return job;
  });
}

function parseRun(job: NodeJob) {
  const report = job.resultJson ? decode<{ ok: boolean; result?: unknown; error?: string | null }>(job.resultJson) : null;
  const parsed = report?.result !== undefined ? runResultSchema.safeParse(report.result) : null;
  const run = parsed?.success ? parsed.data : null;
  const error = report?.ok === false ? report.error ?? job.error ?? '执行失败' : run?.error ?? (parsed && !parsed.success ? '执行端回报格式无效' : null);
  return { run, result: (run?.result ?? null) as RunResult | null, facts: (run?.facts ?? null) as GitFacts | null, error, stderr: run?.stderrTail ?? '' };
}

export async function tickOrchestration(id: string) {
  return serialized(`orch:${id}`, () => tickOnce(id));
}

async function tickOnce(id: string) {
  // Process finished jobs first (also after a restart), then dispatch whatever became ready.
  for (let guard = 0; guard < 20; guard++) {
    const row = await prisma.orchestration.findUnique({ where: { id }, include: { steps: { orderBy: { position: 'asc' } } } });
    if (!row) return;
    const progressed = await processFinishedJobs(row, row.steps);
    if (row.status !== 'running') { if (!progressed) return; continue; }
    const fresh = await prisma.orchestration.findUniqueOrThrow({ where: { id }, include: { steps: { orderBy: { position: 'asc' } } } });
    if (fresh.status !== 'running') continue;
    const dispatched = await dispatchReady(fresh, fresh.steps);
    if (!progressed && !dispatched) return;
  }
}

async function processFinishedJobs(row: Orchestration, steps: OrchestrationStep[]) {
  let progressed = false;
  for (const step of steps) {
    if (!['dispatched', 'verifying'].includes(step.status) || !step.lastJobId) continue;
    const job = await prisma.nodeJob.findUnique({ where: { id: step.lastJobId } });
    if (!job || !['done', 'failed'].includes(job.status)) continue;
    if (row.status === 'cancelled' || row.status === 'superseded') continue;
    await handleJob(row, step, job);
    progressed = true;
  }
  return progressed;
}

async function stepUpdate(step: OrchestrationStep, data: Prisma.OrchestrationStepUpdateManyMutationInput) {
  const changed = await prisma.orchestrationStep.updateMany({ where: { id: step.id, status: step.status, lastJobId: step.lastJobId }, data: { ...data, updatedAt: now() } });
  return changed.count > 0;
}
async function event(row: Orchestration, type: string, actorKind: 'model' | 'server' | 'node' | 'user', stepId: string | null, payload: unknown) {
  await prisma.$transaction((tx) => appendOrchestrationEvent(tx, row.id, type, actorKind, stepId, payload));
}

async function handleJob(row: Orchestration, step: OrchestrationStep, job: NodeJob) {
  const snapshot = decode<Snapshot>(row.taskSnapshotJson);
  if (step.kind === 'setup') {
    const report = job.resultJson ? decode<{ ok: boolean; result?: unknown; error?: string }>(job.resultJson) : null;
    const parsed = report?.ok ? prepareResultSchema.safeParse(report.result) : null;
    if (parsed?.success) {
      if (!await stepUpdate(step, { status: 'succeeded', workPath: parsed.data.worktree, branch: parsed.data.branch, baseCommit: parsed.data.head })) return;
      await prisma.orchestration.update({ where: { id: row.id }, data: { integrationPath: parsed.data.worktree, baseCommit: parsed.data.head, integrationHead: parsed.data.head, updatedAt: now() } });
      await event(row, 'integration_ready', 'node', step.id, parsed.data);
    } else {
      const error = report?.error ?? job.error ?? '集成分支准备失败';
      if (!await stepUpdate(step, { status: 'needs_user', error })) return;
      await pause(row.id, 'setup_failed', error);
    }
    return;
  }
  if (step.kind === 'push') {
    const report = job.resultJson ? decode<{ ok: boolean; result?: unknown; error?: string }>(job.resultJson) : null;
    const parsed = report?.ok ? pushResultSchema.safeParse(report.result) : null;
    if (parsed?.success) {
      if (!await stepUpdate(step, { status: 'succeeded', resultCommit: parsed.data.head })) return;
      await prisma.orchestration.update({ where: { id: row.id }, data: { pushedAt: now(), updatedAt: now() } });
      await event(row, 'pushed', 'node', step.id, parsed.data);
    } else {
      if (!await stepUpdate(step, { status: 'failed', error: report?.error ?? job.error ?? '推送失败' })) return;
      await event(row, 'push_failed', 'node', step.id, { error: report?.error ?? job.error });
    }
    publishOrchestration({ orchestrationId: row.id, taskId: row.taskId, status: row.status });
    return;
  }
  const { result, facts, error, stderr, run } = parseRun(job);
  const subtask = snapshot.subtasks.find((task) => task.id === step.subtaskId);
  if (step.kind === 'develop') {
    const base = step.baseCommit ?? '';
    const check = checkDevelop({ result, facts, base, branch: step.branch ?? '', error });
    await event(row, 'develop_check', 'server', step.id, { jobId: job.id, ...check, head: facts?.head ?? null, ...(check.ok ? {} : { stderrTail: stderr.slice(-2000) }) });
    if (run?.worktree && run.worktree !== step.workPath) { await prisma.orchestrationStep.update({ where: { id: step.id }, data: { workPath: run.worktree } }); step.workPath = run.worktree; }
    if (!check.ok) return developFailure(row, step, job, check.problems, `${error ?? ''}\n${stderr}`, !!result);
    let review: { decision: 'accept' | 'continue' | 'fail'; comment: string } | null;
    const prior = await prisma.orchestrationEvent.findMany({ where: { orchestrationId: row.id, stepId: step.id, type: 'ai_review' } });
    const recorded = prior.map((item) => decode<{ jobId: string; value: typeof review }>(item.payload)).find((item) => item.jobId === job.id);
    if (recorded) review = recorded.value;
    else {
      try {
        const reply = await reviewDevelop({ subtask: subtask ?? { id: step.subtaskId!, title: '', description: '', sortOrder: 0 }, acceptanceCriteria: step.acceptanceCriteria, summary: result!.summary, checks: result!.checks, commits: facts!.commits, unfinished: result!.unfinished });
        review = reply?.value ?? null;
        await event(row, 'ai_review', 'model', step.id, { jobId: job.id, value: review, raw: reply?.raw ?? null, rulesOnly: !reply });
      } catch (failure) {
        await event(row, 'ai_review_failed', 'model', step.id, { jobId: job.id, error: (failure as Error).message, raw: (failure as { raw?: string }).raw ?? null });
        if (!await stepUpdate(step, { status: 'needs_user', error: '主控模型审阅失败' })) return;
        await pause(row.id, 'invalid_model_output');
        return;
      }
    }
    const decision = review?.decision ?? 'accept';
    if (decision === 'accept') {
      if (!await stepUpdate(step, { status: 'succeeded', resultCommit: facts!.head, error: null })) return;
      await prisma.orchestrationStep.updateMany({ where: { orchestrationId: row.id, sourceStepId: step.id, kind: 'merge', status: 'pending' }, data: { status: 'queued', branch: step.branch, resultCommit: facts!.head, updatedAt: now() } });
      return;
    }
    if (decision === 'continue' && step.continueCount < MAX_CONTINUE) {
      await stepUpdate(step, { status: 'pending', continueCount: { increment: 1 }, feedback: review!.comment });
      return;
    }
    if (!await stepUpdate(step, { status: 'needs_user', error: review?.comment ?? '主控判定未通过' })) return;
    if (step.subtaskId) await updateTaskStatus(step.subtaskId, 'blocked', row.id);
    await pause(row.id, 'develop_failed', review?.comment);
    return;
  }
  if (step.kind === 'merge' && step.status === 'dispatched') {
    const check = checkMerge({ result, facts, integrationBranch: row.integrationBranch, preHead: run?.preHead ?? step.preMergeHead, resultCommit: step.resultCommit ?? '', error });
    await event(row, 'merge_check', 'server', step.id, { jobId: job.id, ...check, head: facts?.head ?? null, ...(check.ok ? {} : { stderrTail: stderr.slice(-2000) }) });
    if (!check.ok) {
      const reason = looksGitWriteDenied(`${error ?? ''}\n${stderr}`) ? 'git_write_denied' : facts?.unmerged.length || facts?.conflictMarkers.length ? 'merge_conflict_unresolved' : (result?.checks ?? []).some((item) => !item.passed) ? 'merge_tests_failed' : 'merge_unverified';
      if (!await stepUpdate(step, { status: 'needs_user', error: check.problems.join('；') })) return;
      await pause(row.id, reason, check.problems);
      return;
    }
    if (!await stepUpdate(step, { status: 'reverify', mergeCommit: facts!.head })) return;
    return;
  }
  if (step.kind === 'merge' && step.status === 'verifying') {
    const check = checkVerify({ result, facts, expectedHead: step.mergeCommit ?? '', resultCommit: step.resultCommit ?? '', error });
    await event(row, 'verify_check', 'server', step.id, { jobId: job.id, ...check, head: facts?.head ?? null });
    if (!check.ok) {
      if (!await stepUpdate(step, { status: 'needs_user', error: check.problems.join('；') })) return;
      await pause(row.id, (result?.checks ?? []).some((item) => !item.passed) ? 'merge_tests_failed' : 'merge_unverified', check.problems);
      return;
    }
    if (!await stepUpdate(step, { status: 'succeeded', error: null })) return;
    await prisma.orchestration.update({ where: { id: row.id }, data: { integrationHead: step.mergeCommit, updatedAt: now() } });
    const develop = step.sourceStepId ? await prisma.orchestrationStep.findUnique({ where: { id: step.sourceStepId } }) : null;
    if (step.subtaskId) {
      const current = await prisma.task.findUnique({ where: { id: step.subtaskId } });
      if (current && develop?.lastTaskRevision && current.revision !== develop.lastTaskRevision) {
        await event(row, 'task_revised', 'server', step.id, { taskId: step.subtaskId, expected: develop.lastTaskRevision, actual: current.revision });
        await pause(row.id, 'task_revised', '子任务在派发后被修改，未自动标记完成');
      } else await updateTaskStatus(step.subtaskId, 'done', row.id);
    }
  }
}

async function developFailure(row: Orchestration, step: OrchestrationStep, job: NodeJob, problems: string[], output: string, hasResult: boolean) {
  if (looksGitWriteDenied(output)) {
    if (!await stepUpdate(step, { status: 'needs_user', error: '本机 AI 无法写 git 元数据（index.lock / 只读文件系统）' })) return;
    await pause(row.id, 'git_write_denied', problems);
    return;
  }
  if (!hasResult && looksRateLimited(output) && step.retryCount < MAX_RATE_RETRIES) {
    const delay = Math.min(60_000 * 2 ** step.retryCount, 15 * 60_000) + Math.floor(Math.random() * 5000);
    await stepUpdate(step, { status: 'retry_wait', retryCount: { increment: 1 }, nextAttemptAt: new Date(Date.now() + delay).toISOString(), error: '额度限流，稍后重试' });
    return;
  }
  if (hasResult && step.continueCount < MAX_CONTINUE && step.workPath) {
    await stepUpdate(step, { status: 'pending', continueCount: { increment: 1 }, feedback: `执行端核对未通过：\n- ${problems.join('\n- ')}` });
    return;
  }
  if (!await stepUpdate(step, { status: 'needs_user', error: problems.join('；') })) return;
  if (step.subtaskId) await updateTaskStatus(step.subtaskId, 'blocked', row.id);
  await pause(row.id, looksRateLimited(output) ? 'rate_limited' : 'develop_failed', problems);
  void job;
}

async function dispatchReady(row: Orchestration, steps: OrchestrationStep[]) {
  if (!row.nodeId) return false;
  const grant = decode<Grant>(row.grantJson);
  const snapshot = decode<Snapshot>(row.taskSnapshotJson);
  let dispatched = false;
  const setup = steps.find((step) => step.kind === 'setup');
  if (setup?.status === 'pending') {
    await dispatch(row, setup, 'work', `orch:${setup.id}:a${setup.attempt}:prepare`, { repoPath: row.repoPath, branch: row.integrationBranch, startPoint: row.defaultBranch, worktreeName: `${row.id}/integration` }, 'prepare', 'dispatched');
    return true;
  }
  if (setup?.status !== 'succeeded' || !row.integrationHead) return false;
  const mergeDone = new Map(steps.filter((step) => step.kind === 'merge').map((step) => [step.subtaskId, ['succeeded', 'skipped'].includes(step.status)]));
  let running = steps.filter((step) => step.kind === 'develop' && step.status === 'dispatched').length;
  const nowMs = Date.now();
  for (const step of steps.filter((item) => item.kind === 'develop')) {
    if (running >= grant.maxParallel) break;
    const ready = step.status === 'pending' || (step.status === 'retry_wait' && (!step.nextAttemptAt || Date.parse(step.nextAttemptAt) <= nowMs));
    if (!ready) continue;
    if (!decode<string[]>(step.dependsOnJson).every((dependency) => mergeDone.get(dependency))) continue;
    const latest = await prisma.task.findUnique({ where: { id: step.subtaskId! } });
    const frozen = snapshot.subtasks.find((task) => task.id === step.subtaskId)!;
    const subtask = latest && !latest.deletedAt ? { id: latest.id, title: latest.title, description: latest.description } : frozen;
    const continuing = step.continueCount > 0 && !!step.workPath;
    const branch = continuing && step.branch ? step.branch : `${row.integrationBranch}-${slug(subtask.title, shortId(subtask.id))}-a${step.attempt}`;
    const base = continuing && step.baseCommit ? step.baseCommit : row.integrationHead;
    const worktree: RunPayload['worktree'] = continuing ? { existing: step.workPath! } : { create: { branch, startPoint: base, worktreeName: `${row.id}/${shortId(subtask.id)}-a${step.attempt}` } };
    const key = `orch:${step.id}:a${step.attempt}:work:c${step.continueCount}:r${step.retryCount}`;
    const payload = runPayload(row, grant, { worktree, prompt: developPrompt({ main: snapshot.main, subtask, acceptanceCriteria: step.acceptanceCriteria, branch, feedback: step.feedback, allowShell: grant.allowShell }), gitWrite: true, expect: { includes: [base], base, branch } });
    const revision = await updateTaskStatus(subtask.id, 'doing', row.id);
    await dispatch(row, step, 'work', key, payload, 'run', 'dispatched', { branch, baseCommit: base, lastTaskRevision: revision ?? latest?.revision ?? null });
    running++; dispatched = true;
  }
  // Merges strictly one at a time per orchestration, in queue order.
  const mergeActive = steps.some((step) => step.kind === 'merge' && ['dispatched', 'verifying'].includes(step.status));
  const reverify = steps.find((step) => step.kind === 'merge' && step.status === 'reverify');
  if (reverify && !mergeActive) {
    const payload = runPayload(row, grant, { worktree: { existing: row.integrationPath! }, prompt: verifyPrompt({ integrationBranch: row.integrationBranch, expectedHead: reverify.mergeCommit!, includes: [reverify.resultCommit!], allowShell: grant.allowShell }), gitWrite: false, expect: { includes: [reverify.resultCommit!, reverify.mergeCommit!] } });
    const verifyCount = await prisma.nodeJob.count({ where: { stepId: reverify.id, phase: 'verify' } });
    await dispatch(row, reverify, 'verify', `orch:${reverify.id}:a${reverify.attempt}:verify:${verifyCount}`, payload, 'run', 'verifying');
    return true;
  }
  if (!mergeActive) {
    const next = steps.filter((step) => step.kind === 'merge' && step.status === 'queued').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.position - b.position)[0];
    if (next) {
      const subtask = snapshot.subtasks.find((task) => task.id === next.subtaskId)!;
      const payload = runPayload(row, grant, { worktree: { existing: row.integrationPath! }, prompt: mergePrompt({ integrationBranch: row.integrationBranch, subtaskBranch: next.branch!, resultCommit: next.resultCommit!, subtask, allowShell: grant.allowShell, feedback: next.feedback }), gitWrite: true, expect: { includes: [next.resultCommit!, row.integrationHead], branch: row.integrationBranch } });
      await dispatch(row, next, 'work', `orch:${next.id}:a${next.attempt}:work`, payload, 'run', 'dispatched', { preMergeHead: row.integrationHead });
      dispatched = true;
    }
  }
  const work = steps.filter((step) => step.kind === 'develop' || step.kind === 'merge');
  const final = steps.find((step) => step.kind === 'final');
  if (final?.status === 'pending' && work.every((step) => ['succeeded', 'skipped'].includes(step.status))) {
    await runFinal(row, final, steps, snapshot);
    return true;
  }
  return dispatched;
}

async function runFinal(row: Orchestration, final: OrchestrationStep, steps: OrchestrationStep[], snapshot: Snapshot) {
  const plan = decode<Plan>(row.planJson);
  const summaries = [];
  for (const step of steps.filter((item) => item.kind === 'develop' || item.kind === 'merge')) {
    const job = step.lastJobId ? await prisma.nodeJob.findUnique({ where: { id: step.lastJobId } }) : null;
    const parsed = job ? parseRun(job) : null;
    summaries.push({ kind: step.kind, subtask: snapshot.subtasks.find((task) => task.id === step.subtaskId)?.title, status: step.status, summary: parsed?.result?.summary?.slice(0, 2000) ?? step.error, checks: parsed?.result?.checks ?? [], head: step.mergeCommit ?? step.resultCommit });
  }
  let verdict: { satisfied: boolean; comment: string } | null = null;
  try {
    const reply = await reviewFinal({ main: snapshot.main, goalCriteria: plan.goalCriteria, steps: summaries });
    verdict = reply?.value ?? null;
    await event(row, 'final_review', 'model', final.id, { value: verdict, raw: reply?.raw ?? null, rulesOnly: !reply });
  } catch (failure) {
    await event(row, 'final_review_failed', 'model', final.id, { error: (failure as Error).message });
    if (!await stepUpdate(final, { status: 'needs_user', error: '主控最终审阅失败' })) return;
    await pause(row.id, 'invalid_model_output');
    return;
  }
  const satisfied = verdict?.satisfied ?? true;
  if (!satisfied) {
    if (!await stepUpdate(final, { status: 'needs_user', error: verdict!.comment })) return;
    await prisma.orchestration.update({ where: { id: row.id }, data: { finalComment: verdict!.comment } });
    await pause(row.id, 'final_unsatisfied', verdict!.comment);
    return;
  }
  if (!await stepUpdate(final, { status: 'succeeded' })) return;
  const current = await prisma.orchestration.findUniqueOrThrow({ where: { id: row.id } });
  await prisma.$transaction(async (tx) => {
    await setStatus(tx, current, 'awaiting_acceptance', { finalComment: verdict?.comment ?? '所有子任务已合入并通过核对（未配置主控模型，按规则判定）' });
    await appendOrchestrationEvent(tx, row.id, 'awaiting_acceptance', 'server', null, {});
  });
  publishOrchestration({ orchestrationId: row.id, taskId: row.taskId, status: 'awaiting_acceptance' });
}

/** Called after a node reports; processing itself is idempotent and also driven by the periodic tick. */
export async function onJobFinished(jobId: string) {
  const job = await prisma.nodeJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.kind === 'probe') { await applyProbeResult(job); return; }
  if (job.orchestrationId) void tickOrchestration(job.orchestrationId).catch((error) => console.error('编排推进失败：', error));
}

/** Periodic: expire leases (pause affected rounds as node_offline), auto-resume once the node is back, advance running rounds. */
export async function tickAllOrchestrations() {
  const lost = await expireLeases();
  for (const job of lost) {
    if (job.kind === 'probe') { await prisma.nodeJob.update({ where: { id: job.id }, data: { status: 'failed', error: '执行端离线', endedAt: now() } }); continue; }
    if (job.orchestrationId) await pause(job.orchestrationId, 'node_offline', { jobId: job.id });
  }
  const offline = await prisma.orchestration.findMany({ where: { status: 'paused', pauseReason: 'node_offline' } });
  for (const row of offline) {
    if (await prisma.nodeJob.count({ where: { orchestrationId: row.id, status: 'lost' } })) continue;
    await prisma.$transaction(async (tx) => { await setStatus(tx, row, 'running', { pauseReason: null }); await appendOrchestrationEvent(tx, row.id, 'resumed', 'server', null, { reason: 'node_back' }); });
    publishOrchestration({ orchestrationId: row.id, taskId: row.taskId, status: 'running' });
  }
  const active = await prisma.orchestration.findMany({ where: { status: { in: ['running', 'paused'] } }, select: { id: true } });
  for (const row of active) await tickOrchestration(row.id).catch((error) => console.error('编排推进失败：', error));
}

export function startOrchestrationScheduler(intervalMs = 2_000) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tickAllOrchestrations().catch((error) => console.error('编排调度失败：', error)).finally(() => { running = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
