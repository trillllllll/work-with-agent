/** Local executor (wwa-node) registry, job queue and lease protocol. The server never touches the workspace. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AgentNode, NodeJob, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../infrastructure/prisma.js';
import { DomainError } from '../../domain/task.js';
import { checkLocalOrigin } from '../security.js';
import { canonical } from '../commands.js';
import { JOB_LEASE_MS, NODE_ONLINE_MS, leaseRequestSchema, progressRequestSchema, reportRequestSchema, type JobKind, type LeasedJob } from '../../node-agent/protocol.js';

type Db = Prisma.TransactionClient;
export const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
export const activeJobStatuses = ['queued', 'leased'];

export function nodeDto(row: AgentNode) {
  const { tokenHash: _hash, capabilitiesJson, inventoryJson: _inventory, ...value } = row;
  return { ...value, capabilities: JSON.parse(capabilitiesJson), online: isOnline(row) };
}
export function isOnline(row: Pick<AgentNode, 'lastSeenAt' | 'status'>, at = Date.now()) {
  return row.status === 'active' && !!row.lastSeenAt && at - Date.parse(row.lastSeenAt) < NODE_ONLINE_MS;
}
export function jobDto(row: NodeJob) {
  const { leaseToken: _token, payloadJson, resultJson, ...value } = row;
  return { ...value, payload: JSON.parse(payloadJson), result: resultJson ? JSON.parse(resultJson) : null };
}

export class NodeService {
  async list() { return (await prisma.agentNode.findMany({ orderBy: { createdAt: 'desc' } })).map(nodeDto); }
  async create(raw: unknown, serverUrl: string) {
    const input = z.object({ name: z.string().trim().min(1).max(100) }).strict().parse(raw);
    const token = newToken();
    const row = await prisma.agentNode.create({ data: { name: input.name, tokenHash: hash(token), createdAt: now(), updatedAt: now() } });
    // The plaintext token is only returned once.
    return { node: nodeDto(row), token, serverUrl, command: `node server/dist/node-agent/index.js --server ${serverUrl} --token ${token} --roots <你的代码目录>` };
  }
  async revoke(id: string) {
    const row = await prisma.agentNode.update({ where: { id }, data: { status: 'revoked', updatedAt: now() } }).catch(() => { throw new DomainError('NOT_FOUND', '执行端不存在', 404); });
    await prisma.nodeJob.updateMany({ where: { nodeId: id, status: 'queued' }, data: { status: 'cancelled', error: '执行端已吊销', updatedAt: now(), endedAt: now() } });
    return nodeDto(row);
  }
  /** Heartbeat + capability report + lease. Also renews the leases of jobs the node still runs. */
  async lease(node: AgentNode, raw: unknown): Promise<{ jobs: LeasedJob[]; cancel: string[] }> {
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
      return { jobs, cancel };
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
    const changed = await prisma.nodeJob.updateMany({ where: { id, resultJson: null, status: { in: ['leased', 'lost'] } }, data: { status: input.ok ? 'done' : 'failed', resultJson: serialized, error: input.ok ? null : input.error ?? '执行失败', endedAt: now(), updatedAt: now() } });
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
  if (!header.startsWith('Node ')) throw new DomainError('AUTH_REQUIRED', '缺少执行端凭据', 401);
  const row = await prisma.agentNode.findUnique({ where: { tokenHash: hash(header.slice(5).trim()) } });
  if (!row || row.status !== 'active') throw new DomainError('AUTH_REQUIRED', '执行端凭据无效或已吊销', 401);
  return row;
}
export function nodeMiddleware(req: Request, _res: Response, next: NextFunction) {
  authenticateNode(req).then((node) => { (req as Request & { node: AgentNode }).node = node; next(); }, next);
}
export function getNode(req: Request) { return (req as Request & { node: AgentNode }).node; }
