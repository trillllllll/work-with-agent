/** Local executor (wwa-node) registry, job queue and lease protocol. The server never touches the workspace. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AgentNode, NodeJob, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../infrastructure/prisma.js';
import { DomainError } from '../../domain/task.js';
import { localize } from '../../i18n/index.js';
import { checkLocalOrigin } from '../security.js';
import { canonical } from '../commands.js';
import { JOB_LEASE_MS, NODE_ONLINE_MS, NODE_RESULT_FEATURES, leaseRequestSchema, progressRequestSchema, reportRequestSchema, runResultSchema, type JobKind, type LeasedJob } from '../../node-agent/protocol.js';
import { boundedJson, costMicroUsd, int32, int32Any } from '../run-usage.js';
import { appendOrchestrationEvent, publishOrchestration } from './events.js';

type Db = Prisma.TransactionClient;
export const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
export const activeJobStatuses = ['queued', 'leased'];
const openJobStatuses = ['queued', 'leased', 'lost'] as const;

type LocationBrief = { id: string; projectId: string; path: string; status: string; project?: { name: string } | null };

export function nodeDto(row: AgentNode, locations: LocationBrief[] = [], activeJobs = 0) {
  const { tokenHash: _hash, capabilitiesJson, inventoryJson: _inventory, ...value } = row;
  return {
    ...value,
    capabilities: JSON.parse(capabilitiesJson),
    online: isOnline(row),
    locations: locations.map((location) => ({ id: location.id, projectId: location.projectId, projectName: location.project?.name ?? '', path: location.path, status: location.status })),
    activeJobs,
  };
}

export function reportedMaxConcurrent(capabilitiesJson: string): number | null {
  try {
    const parsed = JSON.parse(capabilitiesJson) as { maxConcurrent?: unknown };
    return typeof parsed.maxConcurrent === 'number' && Number.isFinite(parsed.maxConcurrent) ? parsed.maxConcurrent : null;
  } catch { return null; }
}

export function providerAvailable(capabilitiesJson: string, provider: string) {
  try {
    const parsed = JSON.parse(capabilitiesJson) as { providers?: Array<{ provider?: unknown; available?: unknown }> };
    return Array.isArray(parsed.providers) && parsed.providers.some((item) => item?.provider === provider && item.available === true);
  } catch { return false; }
}

export function reportedProviders(capabilitiesJson: string): unknown[] {
  try {
    const parsed = JSON.parse(capabilitiesJson) as { providers?: unknown };
    return Array.isArray(parsed.providers) ? parsed.providers : [];
  } catch { return []; }
}

const locationInclude = { include: { project: { select: { name: true } } } } as const;

async function present(row: AgentNode) {
  const [locations, activeJobs] = await Promise.all([
    prisma.projectLocation.findMany({ where: { nodeId: row.id }, ...locationInclude }),
    prisma.nodeJob.count({ where: { nodeId: row.id, status: { in: activeJobStatuses } } }),
  ]);
  return nodeDto(row, locations, activeJobs);
}

function nodeCommand(serverUrl: string, token: string) {
  return `node server/dist/node-agent/index.js --server ${serverUrl} --token ${token} --roots <${localize('你的代码目录')}>`;
}

function orchestrationUsesNode(row: { nodeId: string | null; extraLocationsJson: string; steps: Array<{ nodeId: string | null }> }, nodeId: string) {
  if (row.nodeId === nodeId) return true;
  try {
    const extra = JSON.parse(row.extraLocationsJson) as Array<{ nodeId?: string }>;
    if (Array.isArray(extra) && extra.some((item) => item?.nodeId === nodeId)) return true;
  } catch { /* a malformed extra list does not match */ }
  return row.steps.some((step) => step.nodeId === nodeId);
}

/** Cancel queued/leased/lost work and pause running rounds that still use this computer. Caller publishes after commit. */
async function cancelWorkOnNode(tx: Db, nodeId: string, at: string) {
  const open = await tx.nodeJob.findMany({ where: { nodeId, status: { in: [...openJobStatuses] } }, select: { id: true } });
  const openIds = open.map((job) => job.id);
  if (openIds.length) await tx.nodeJob.updateMany({ where: { id: { in: openIds }, status: { in: [...openJobStatuses] } }, data: { status: 'cancelled', error: '电脑已断开', endedAt: at, updatedAt: at } });
  const cancelled = openIds.length ? await tx.nodeJob.findMany({ where: { id: { in: openIds }, status: 'cancelled', error: '电脑已断开' }, select: { id: true, kind: true, stepId: true } }) : [];
  const cancelledJobIds = cancelled.map((job) => job.id);
  if (cancelledJobIds.length) {
    const stepIds = cancelled.map((job) => job.stepId).filter((id): id is string => !!id);
    await tx.orchestrationStep.updateMany({
      where: { status: { in: ['dispatched', 'verifying'] }, OR: [...(stepIds.length ? [{ id: { in: stepIds } }] : []), { lastJobId: { in: cancelledJobIds } }] },
      data: { status: 'needs_user', error: '电脑已断开，这一步已取消', updatedAt: at },
    });
    const cleanupIds = cancelled.filter((job) => job.kind === 'cleanup').map((job) => job.id);
    if (cleanupIds.length) await tx.worktreeCleanup.updateMany({ where: { jobId: { in: cleanupIds } }, data: { status: 'failed', resultJson: JSON.stringify({ error: '电脑已断开' }), updatedAt: at } });
  }
  const running = await tx.orchestration.findMany({ where: { status: 'running' }, select: { id: true, taskId: true, nodeId: true, extraLocationsJson: true, steps: { select: { nodeId: true } } } });
  const paused: Array<{ id: string; taskId: string }> = [];
  for (const row of running) {
    if (!orchestrationUsesNode(row, nodeId)) continue;
    const changed = await tx.orchestration.updateMany({ where: { id: row.id, status: 'running' }, data: { status: 'paused', pauseReason: 'computer_offline', revision: { increment: 1 }, updatedAt: at } });
    if (!changed.count) continue;
    await appendOrchestrationEvent(tx, row.id, 'paused', 'server', null, { reason: 'computer_offline', nodeId });
    paused.push({ id: row.id, taskId: row.taskId });
  }
  return { cancelledJobIds, pausedOrchestrationIds: paused.map((item) => item.id), paused };
}

function publishPaused(paused: Array<{ id: string; taskId: string }>) {
  for (const item of paused) publishOrchestration({ orchestrationId: item.id, taskId: item.taskId, status: 'paused', pauseReason: 'computer_offline' });
}
export function isOnline(row: Pick<AgentNode, 'lastSeenAt' | 'status'>, at = Date.now()) {
  return row.status === 'active' && !!row.lastSeenAt && at - Date.parse(row.lastSeenAt) < NODE_ONLINE_MS;
}
export function jobDto(row: NodeJob) {
  const { leaseToken: _token, payloadJson, resultJson, ...value } = row;
  return { ...value, payload: JSON.parse(payloadJson), result: resultJson ? JSON.parse(resultJson) : null };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function payloadProvider(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as { provider?: unknown };
    return typeof payload.provider === 'string' && payload.provider.length > 0 && payload.provider.length <= 200 ? payload.provider : null;
  } catch { return null; }
}
/** Column patch for a run report. Old nodes omit the new keys; those columns stay unset (null). Parse failures write nothing. */
export function columnsForRunReport(job: { kind: string; payloadJson: string }, input: { ok: boolean; result?: unknown }): Prisma.NodeJobUpdateManyMutationInput {
  if (job.kind !== 'run') return {};
  const provider = payloadProvider(job.payloadJson);
  if (!input.ok) return provider ? { provider } : {};
  const parsed = runResultSchema.safeParse(input.result);
  if (!parsed.success) return {};
  const data: Prisma.NodeJobUpdateManyMutationInput = {};
  if (provider) data.provider = provider;
  if (!isRecord(input.result)) return data;
  if ('exitCode' in input.result) data.exitCode = int32Any(parsed.data.exitCode);
  if ('usage' in input.result && parsed.data.usage) {
    const usage = parsed.data.usage;
    data.cliVersion = usage.cliVersion;
    data.model = usage.model;
    data.inputTokens = int32(usage.inputTokens);
    data.cachedInputTokens = int32(usage.cachedInputTokens);
    data.outputTokens = int32(usage.outputTokens);
    data.costMicroUsd = costMicroUsd(usage.costUsd);
    data.numTurns = int32(usage.numTurns);
    data.cliDurationMs = int32(usage.cliDurationMs);
    data.runDurationMs = int32(usage.runDurationMs);
    data.usageJson = boundedJson(usage);
  }
  const facts = input.result.facts;
  if (isRecord(facts) && 'diff' in facts && parsed.data.facts?.diff) {
    const diff = parsed.data.facts.diff;
    data.filesChanged = int32(diff.filesChanged);
    data.linesAdded = int32(diff.linesAdded);
    data.linesDeleted = int32(diff.linesDeleted);
    data.diffStatJson = JSON.stringify(diff);
  }
  return data;
}

export class NodeService {
  async list() {
    const rows = await prisma.agentNode.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, include: { locations: locationInclude } });
    const ids = rows.map((row) => row.id);
    const counts = ids.length ? await prisma.nodeJob.groupBy({ by: ['nodeId'], where: { nodeId: { in: ids }, status: { in: activeJobStatuses } }, _count: { _all: true } }) : [];
    const active = new Map(counts.map((row) => [row.nodeId, row._count._all]));
    return rows.map((row) => nodeDto(row, row.locations, active.get(row.id) ?? 0));
  }
  async create(raw: unknown, serverUrl: string) {
    const input = z.object({ name: z.string().trim().min(1).max(100) }).strict().parse(raw);
    const token = newToken();
    const row = await prisma.agentNode.create({ data: { name: input.name, tokenHash: hash(token), createdAt: now(), updatedAt: now() } });
    // The plaintext token is only returned once.
    return { node: await present(row), token, serverUrl, command: nodeCommand(serverUrl, token) };
  }
  async rename(id: string, raw: unknown) {
    const input = z.object({ name: z.string().trim().min(1).max(100) }).strict().parse(raw);
    const existing = await prisma.agentNode.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new DomainError('NOT_FOUND', '电脑不存在', 404);
    if (existing.status !== 'active') throw new DomainError('NODE_UNAVAILABLE', '已断开的电脑不能改名', 409);
    const row = await prisma.agentNode.update({ where: { id }, data: { name: input.name, updatedAt: now() } });
    return present(row);
  }
  /** Disconnect: revoke the token and cancel in-flight work. Repeating it on an already-revoked computer is a no-op. */
  async revoke(id: string) {
    const at = now();
    const outcome = await prisma.$transaction(async (tx) => {
      const existing = await tx.agentNode.findUnique({ where: { id } });
      if (!existing || existing.deletedAt) throw new DomainError('NOT_FOUND', '电脑不存在', 404);
      const row = await tx.agentNode.update({ where: { id }, data: { status: 'revoked', updatedAt: at } });
      const cancelled = await cancelWorkOnNode(tx, id, at);
      return { row, ...cancelled };
    });
    publishPaused(outcome.paused);
    return { node: await present(outcome.row), cancelledJobIds: outcome.cancelledJobIds, pausedOrchestrationIds: outcome.pausedOrchestrationIds };
  }
  /** Rotate the token of an active computer. In-flight work is cancelled the same way as a disconnect; the computer stays active. */
  async reissue(id: string, serverUrl: string) {
    const token = newToken();
    const at = now();
    const outcome = await prisma.$transaction(async (tx) => {
      const existing = await tx.agentNode.findUnique({ where: { id } });
      if (!existing || existing.deletedAt) throw new DomainError('NOT_FOUND', '电脑不存在', 404);
      if (existing.status !== 'active') throw new DomainError('NODE_UNAVAILABLE', '已断开的电脑不能重新生成连接命令', 409);
      const row = await tx.agentNode.update({ where: { id }, data: { tokenHash: hash(token), updatedAt: at } });
      const cancelled = await cancelWorkOnNode(tx, id, at);
      return { row, ...cancelled };
    });
    publishPaused(outcome.paused);
    return { node: await present(outcome.row), token, serverUrl, command: nodeCommand(serverUrl, token) };
  }
  /** Soft-delete a revoked computer. Locations stay unless the caller confirms they should go too. */
  async remove(id: string, removeLocations: boolean) {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.agentNode.findUnique({ where: { id }, include: { locations: true } });
      if (!existing || existing.deletedAt) throw new DomainError('NOT_FOUND', '电脑不存在', 404);
      if (existing.status !== 'revoked') throw new DomainError('NODE_NOT_REVOKED', '只能删除已断开的电脑', 409);
      if (existing.locations.length && !removeLocations) throw Object.assign(new DomainError('NODE_HAS_LOCATIONS', '这台电脑还有项目位置，确认后会一并移除', 409), { details: { locationIds: existing.locations.map((location) => location.id) } });
      if (removeLocations && existing.locations.length) {
        for (const location of existing.locations) {
          if (await tx.orchestration.count({ where: { locationId: location.id, status: { in: ['running', 'paused', 'awaiting_acceptance'] } } })) throw new DomainError('ORCHESTRATION_ACTIVE', '有编排正在使用该位置', 409);
        }
        const ids = existing.locations.map((location) => location.id);
        await tx.orchestration.updateMany({ where: { locationId: { in: ids } }, data: { locationId: null } });
        await tx.projectLocation.deleteMany({ where: { id: { in: ids } } });
      }
      const at = now();
      await tx.agentNode.update({ where: { id }, data: { deletedAt: at, updatedAt: at } });
    });
    return { ok: true };
  }
  /** Heartbeat + capability report + lease. Also renews the leases of jobs the node still runs. */
  async lease(node: AgentNode, raw: unknown): Promise<{ jobs: LeasedJob[]; cancel: string[]; accepts: string[]; nodeId: string }> {
    const input = leaseRequestSchema.parse(raw);
    const at = now();
    const expires = new Date(Date.now() + JOB_LEASE_MS).toISOString();
    return prisma.$transaction(async (tx) => {
      await tx.agentNode.update({ where: { id: node.id }, data: { lastSeenAt: at, platform: input.capabilities.platform, version: input.capabilities.version, capabilitiesJson: JSON.stringify(input.capabilities), updatedAt: at } });
      // Renew the leases the node still holds; tell it which ones were cancelled server-side.
      const held = input.activeJobIds.length ? await tx.nodeJob.findMany({ where: { id: { in: input.activeJobIds }, nodeId: node.id } }) : [];
      const cancel = held.filter((job) => job.status === 'cancelled').map((job) => job.id);
      for (const job of held) if (job.status === 'leased' || job.status === 'lost') await tx.nodeJob.update({ where: { id: job.id }, data: { status: 'leased', leaseExpiresAt: expires, updatedAt: at } });
      const lowDisk = input.capabilities.freeBytes !== null && input.capabilities.freeBytes < 2 * 1024 ** 3;
      const slots = lowDisk ? 0 : Math.max(0, Math.min(input.max, input.capabilities.maxConcurrent - input.activeJobIds.length));
      const jobs: LeasedJob[] = [];
      if (slots) {
        const queued = await tx.nodeJob.findMany({ where: { nodeId: node.id, status: 'queued' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: slots });
        for (const job of queued) {
          const leaseToken = newToken();
          const changed = await tx.nodeJob.updateMany({ where: { id: job.id, status: 'queued' }, data: { status: 'leased', leaseToken, leaseExpiresAt: expires, startedAt: job.startedAt ?? at, updatedAt: at } });
          if (changed.count) jobs.push({ id: job.id, kind: job.kind as JobKind, phase: job.phase, leaseToken, payload: JSON.parse(job.payloadJson) });
        }
      }
      return { jobs, cancel, accepts: [...NODE_RESULT_FEATURES], nodeId: node.id };
    });
  }
  async progress(node: AgentNode, id: string, raw: unknown) {
    const input = progressRequestSchema.parse(raw);
    const job = await this.ownedJob(node, id, input.leaseToken);
    if (!['leased', 'lost'].includes(job.status)) return { ignored: true };
    if (job.orchestrationId) {
      const { appendOrchestrationEvent } = await import('./events.js');
      await prisma.$transaction((tx) => appendOrchestrationEvent(tx, job.orchestrationId!, 'node_progress', 'node', job.stepId, { jobId: id, message: input.message }));
    }
    return { ok: true };
  }
  /** Results are immutable: an identical retry is a replay, different content is a conflict. A late report on a `lost` job is accepted. */
  async report(node: AgentNode, id: string, raw: unknown) {
    const input = reportRequestSchema.parse(raw);
    const job = await this.ownedJob(node, id, input.leaseToken);
    const serialized = canonical({ ok: input.ok, result: input.result ?? null, error: input.error ?? null });
    if (job.resultJson !== null) {
      if (canonical(JSON.parse(job.resultJson)) !== serialized) throw new DomainError('RESULT_CONFLICT', '本任务的结果已经固定，不能覆盖');
      return { replay: true };
    }
    if (job.status === 'cancelled') return { ignored: true };
    const usageColumns = columnsForRunReport(job, input);
    const changed = await prisma.nodeJob.updateMany({ where: { id, resultJson: null, status: { in: ['leased', 'lost'] } }, data: { status: input.ok ? 'done' : 'failed', resultJson: serialized, error: input.ok ? null : input.error ?? '执行失败', endedAt: now(), updatedAt: now(), ...usageColumns } });
    if (!changed.count) throw new DomainError('JOB_CONFLICT', '任务状态已变化');
    const { onJobFinished } = await import('./service.js');
    await onJobFinished(id).catch((error) => console.error('编排处理任务结果失败：', error));
    return { ok: true };
  }
  private async ownedJob(node: AgentNode, id: string, leaseToken: string) {
    const job = await prisma.nodeJob.findUnique({ where: { id } });
    if (!job || job.nodeId !== node.id) throw new DomainError('NOT_FOUND', '任务不存在', 404);
    if (!job.leaseToken || job.leaseToken.length !== leaseToken.length || !timingSafeEqual(Buffer.from(job.leaseToken), Buffer.from(leaseToken))) throw new DomainError('LEASE_INVALID', '租约凭据不匹配', 403);
    return job;
  }
}

/** Idempotent enqueue: one job per dispatchKey. Returns the existing job on replay. */
export async function enqueueJob(tx: Db, input: { nodeId: string; kind: JobKind; phase?: string; dispatchKey: string; payload: unknown; orchestrationId?: string | null; stepId?: string | null }) {
  const prior = await tx.nodeJob.findUnique({ where: { dispatchKey: input.dispatchKey } });
  if (prior) return { job: prior, replay: true };
  const job = await tx.nodeJob.create({ data: { nodeId: input.nodeId, kind: input.kind, phase: input.phase ?? 'work', dispatchKey: input.dispatchKey, payloadJson: JSON.stringify(input.payload), orchestrationId: input.orchestrationId ?? null, stepId: input.stepId ?? null, createdAt: now(), updatedAt: now() } });
  return { job, replay: false };
}

/** Leased jobs whose node stopped renewing become `lost`. Returns the affected jobs. */
export async function expireLeases(at = now()) {
  const expired = await prisma.nodeJob.findMany({ where: { status: 'leased', leaseExpiresAt: { lt: at } } });
  const lost: NodeJob[] = [];
  for (const job of expired) {
    const changed = await prisma.nodeJob.updateMany({ where: { id: job.id, status: 'leased', leaseExpiresAt: { lt: at } }, data: { status: 'lost', updatedAt: at } });
    if (changed.count) lost.push(job);
  }
  return lost;
}

export async function authenticateNode(req: Request): Promise<AgentNode> {
  checkLocalOrigin(req);
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Node ')) throw new DomainError('AUTH_REQUIRED', '缺少电脑凭据', 401);
  const row = await prisma.agentNode.findUnique({ where: { tokenHash: hash(header.slice(5).trim()) } });
  if (!row) throw new DomainError('NODE_TOKEN_INVALID', '电脑凭据无效', 401);
  if (row.status !== 'active' || row.deletedAt) throw new DomainError('NODE_REVOKED', '电脑已断开', 401);
  return row;
}
export function nodeMiddleware(req: Request, _res: Response, next: NextFunction) {
  authenticateNode(req).then((node) => { (req as Request & { node: AgentNode }).node = node; next(); }, next);
}
export function getNode(req: Request) { return (req as Request & { node: AgentNode }).node; }
