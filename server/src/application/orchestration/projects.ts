/** Projects are metadata only. A location = a local executor + a path that executor reported and verified. */
import { z } from 'zod';
import type { NodeJob } from '@prisma/client';
import { prisma } from '../../infrastructure/prisma.js';
import { DomainError } from '../../domain/task.js';
import { providerSchema } from '../../runner/contracts.js';
import { enqueueJob, isOnline, now, reportedMaxConcurrent } from './nodes.js';
import { probeResultSchema } from '../../node-agent/protocol.js';

const branchName = z.string().trim().min(1).max(200).regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<!\/)(?<!\.lock)$/, '分支名不合法');
const projectInput = z.object({ name: z.string().trim().min(1).max(100), defaultBranch: branchName.default('main'), defaultProvider: providerSchema.default('codex'), defaultParallel: z.number().int().min(1).max(4).default(2) }).strict();

const projectInclude = { locations: { include: { node: true } }, bindings: { where: { scopeType: 'topic' }, select: { scopeId: true } } } as const;

function projectDto(row: { locations: Array<{ node: { name: string; status: string; lastSeenAt: string | null }; fingerprintJson: string } & Record<string, unknown>>; bindings: Array<{ scopeId: string }> } & Record<string, unknown>) {
  const { locations, bindings, ...project } = row;
  return {
    ...project,
    topicIds: bindings.map((binding) => binding.scopeId),
    locations: locations.map(({ node, ...location }) => ({ ...locationDto(location), nodeName: node.name, nodeOnline: isOnline(node), nodeStatus: node.status })),
  };
}

/** Cap the saved default by the smallest concurrency a location computer has reported. Unreported computers do not tighten the cap below 4. */
async function assertProjectParallel(projectId: string, parallel: number) {
  const locations = await prisma.projectLocation.findMany({ where: { projectId, node: { deletedAt: null } }, include: { node: true } });
  let limit = 4;
  let limiter: { id: string; name: string } | null = null;
  for (const location of locations) {
    const max = reportedMaxConcurrent(location.node.capabilitiesJson);
    if (max === null || max >= limit) continue;
    limit = max;
    limiter = location.node;
  }
  if (limiter && parallel > limit) throw Object.assign(new DomainError('PARALLEL_EXCEEDS_NODE', `并行数不能超过电脑「${limiter.name}」的并发上限 ${limit}`, 409), { details: { maxConcurrent: limit, nodeId: limiter.id, nodeName: limiter.name } });
}

export function locationDto(row: { fingerprintJson: string; [key: string]: unknown }) { const { fingerprintJson, ...value } = row; return { ...value, fingerprint: JSON.parse(fingerprintJson) }; }

export class ProjectService {
  async list(archived = false) {
    const rows = await prisma.project.findMany({ where: { archivedAt: archived ? { not: null } : null }, include: projectInclude, orderBy: { createdAt: 'asc' } });
    return rows.map((row) => projectDto(row));
  }
  async get(id: string) {
    const row = await prisma.project.findUnique({ where: { id }, include: projectInclude });
    if (!row) throw new DomainError('NOT_FOUND', '项目不存在', 404);
    return projectDto(row);
  }
  async create(raw: unknown) {
    const input = projectInput.parse(raw);
    return prisma.project.create({ data: { ...input, createdAt: now(), updatedAt: now() } });
  }
  async update(id: string, raw: unknown) {
    const input = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      defaultBranch: branchName.optional(),
      defaultProvider: providerSchema.optional(),
      defaultParallel: z.number().int().min(1).max(4).optional(),
      expectedRevision: z.number().int().positive(),
      archived: z.boolean().optional(),
    }).strict().parse(raw);
    const { expectedRevision, archived, ...data } = input;
    if (data.defaultParallel !== undefined) await assertProjectParallel(id, data.defaultParallel);
    const changed = await prisma.project.updateMany({ where: { id, revision: expectedRevision }, data: { ...data, ...(archived === undefined ? {} : { archivedAt: archived ? now() : null }), revision: { increment: 1 }, updatedAt: now() } });
    if (!changed.count) throw new DomainError('VERSION_CONFLICT', '项目已被修改，请刷新');
    return this.get(id);
  }
  /** Adds or replaces the location on one node and asks that node to verify the path. The server never resolves it. */
  async addLocation(projectId: string, raw: unknown) {
    const input = z.object({ nodeId: z.string().min(1), path: z.string().trim().min(1).max(4096), replace: z.boolean().optional() }).strict().parse(raw);
    return prisma.$transaction(async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (!project || project.archivedAt) throw new DomainError('NOT_FOUND', '项目不存在', 404);
      const node = await tx.agentNode.findUnique({ where: { id: input.nodeId } });
      if (!node || node.status !== 'active' || node.deletedAt) throw new DomainError('NODE_UNAVAILABLE', '电脑不存在或已断开', 400);
      const existing = await tx.projectLocation.findUnique({ where: { projectId_nodeId: { projectId, nodeId: node.id } } });
      if (existing && existing.path !== input.path && input.replace !== true) throw Object.assign(new DomainError('LOCATION_REPLACE', '这台电脑上已有项目位置，确认后会改成新路径并重新验证', 409), { details: { locationId: existing.id, currentPath: existing.path } });
      const busy = await tx.orchestration.count({ where: { locationId: { not: null }, nodeId: node.id, projectId, status: { in: ['running', 'paused'] } } });
      if (busy) throw new DomainError('ORCHESTRATION_ACTIVE', '该位置上有进行中的编排，不能修改', 409);
      const at = now();
      const location = await tx.projectLocation.upsert({ where: { projectId_nodeId: { projectId, nodeId: node.id } }, create: { projectId, nodeId: node.id, path: input.path, createdAt: at, updatedAt: at }, update: { path: input.path, status: 'pending', error: null, verifiedAt: null, fingerprintJson: '{}', updatedAt: at } });
      const { job } = await enqueueJob(tx, { nodeId: node.id, kind: 'probe', phase: 'probe', dispatchKey: `probe:${location.id}:${location.updatedAt}`, payload: { path: input.path } });
      return { location: locationDto(location), jobId: job.id };
    });
  }
  /** Re-queue a probe. An in-flight probe for this location is returned as-is; a finished one gets a new dispatch key. */
  async verifyLocation(projectId: string, locationId: string) {
    return prisma.$transaction(async (tx) => {
      const location = await tx.projectLocation.findFirst({ where: { id: locationId, projectId }, include: { node: true } });
      if (!location) throw new DomainError('NOT_FOUND', '位置不存在', 404);
      if (location.node.status !== 'active' || location.node.deletedAt) throw new DomainError('NODE_UNAVAILABLE', '电脑已断开', 409);
      const inflight = await tx.nodeJob.findFirst({ where: { nodeId: location.nodeId, kind: 'probe', status: { in: ['queued', 'leased'] }, dispatchKey: { startsWith: `probe:${location.id}:` } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      if (inflight) return { location: locationDto(location), jobId: inflight.id, replay: true };
      const updated = await tx.projectLocation.update({ where: { id: location.id }, data: { status: 'pending', error: null, updatedAt: now() } });
      const { job } = await enqueueJob(tx, { nodeId: location.nodeId, kind: 'probe', phase: 'probe', dispatchKey: `probe:${updated.id}:${updated.updatedAt}`, payload: { path: updated.path } });
      return { location: locationDto(updated), jobId: job.id, replay: false };
    });
  }
  async removeLocation(projectId: string, locationId: string) {
    const location = await prisma.projectLocation.findFirst({ where: { id: locationId, projectId } });
    if (!location) throw new DomainError('NOT_FOUND', '位置不存在', 404);
    if (await prisma.orchestration.count({ where: { locationId, status: { in: ['running', 'paused', 'awaiting_acceptance'] } } })) throw new DomainError('ORCHESTRATION_ACTIVE', '有编排正在使用该位置', 409);
    await prisma.orchestration.updateMany({ where: { locationId }, data: { locationId: null } });
    await prisma.projectLocation.delete({ where: { id: locationId } });
    return { ok: true };
  }
  async bind(scopeType: string, scopeId: string, raw: unknown) {
    const scope = z.enum(['topic', 'task']).parse(scopeType);
    const input = z.object({ projectId: z.string().min(1).nullable() }).strict().parse(raw);
    if (scope === 'task') {
      const task = await prisma.task.findUnique({ where: { id: scopeId } });
      if (!task || task.deletedAt) throw new DomainError('NOT_FOUND', '任务不存在', 404);
      if (task.parentId) throw new DomainError('INVALID_SCOPE', '只能给顶层任务单独绑定项目', 400);
    } else if (!await prisma.topic.findUnique({ where: { id: scopeId } })) throw new DomainError('NOT_FOUND', '清单不存在', 404);
    if (input.projectId === null) { await prisma.projectBinding.deleteMany({ where: { scopeType: scope, scopeId } }); return { projectId: null }; }
    if (!await prisma.project.findFirst({ where: { id: input.projectId, archivedAt: null } })) throw new DomainError('NOT_FOUND', '项目不存在', 404);
    await prisma.projectBinding.upsert({ where: { scopeType_scopeId: { scopeType: scope, scopeId } }, create: { scopeType: scope, scopeId, projectId: input.projectId, updatedAt: now() }, update: { projectId: input.projectId, updatedAt: now() } });
    return { projectId: input.projectId };
  }
  async bindings(scopeType: string, scopeId: string) {
    const row = await prisma.projectBinding.findUnique({ where: { scopeType_scopeId: { scopeType, scopeId } } });
    return { projectId: row?.projectId ?? null };
  }
  /** Replace this project's topic bindings. Task-scope bindings are left alone. */
  async bindTopics(projectId: string, raw: unknown) {
    const input = z.object({ topicIds: z.array(z.string().min(1)).max(500), replace: z.boolean().optional(), expectedRevision: z.number().int().positive() }).strict().parse(raw);
    const topicIds = [...new Set(input.topicIds)];
    return prisma.$transaction(async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (!project || project.archivedAt) throw new DomainError('NOT_FOUND', '项目不存在', 404);
      if (topicIds.length) {
        const found = await tx.topic.findMany({ where: { id: { in: topicIds } }, select: { id: true } });
        if (found.length !== topicIds.length) throw new DomainError('NOT_FOUND', '清单不存在', 404);
      }
      const occupied = topicIds.length
        ? await tx.projectBinding.findMany({ where: { scopeType: 'topic', scopeId: { in: topicIds }, projectId: { not: projectId } }, include: { project: { select: { id: true, name: true, archivedAt: true } } } })
        : [];
      const blocking = occupied.filter((row) => !row.project.archivedAt);
      if (blocking.length && input.replace !== true) throw Object.assign(new DomainError('TOPIC_BOUND', '有清单已绑定到其他项目', 409), { details: { bindings: blocking.map((row) => ({ topicId: row.scopeId, projectId: row.projectId, projectName: row.project.name })) } });
      const claimed = await tx.project.updateMany({ where: { id: projectId, revision: input.expectedRevision }, data: { revision: { increment: 1 }, updatedAt: now() } });
      if (!claimed.count) throw new DomainError('VERSION_CONFLICT', '项目已被修改，请刷新');
      for (const topicId of topicIds) {
        await tx.projectBinding.upsert({ where: { scopeType_scopeId: { scopeType: 'topic', scopeId: topicId } }, create: { scopeType: 'topic', scopeId: topicId, projectId, updatedAt: now() }, update: { projectId, updatedAt: now() } });
      }
      await tx.projectBinding.deleteMany({ where: { scopeType: 'topic', projectId, ...(topicIds.length ? { scopeId: { notIn: topicIds } } : {}) } });
      const saved = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { revision: true } });
      return { projectId, topicIds, revision: saved.revision };
    });
  }
  async listBindings(scopeType: string) {
    const scope = z.enum(['topic', 'task']).parse(scopeType);
    const rows = await prisma.projectBinding.findMany({ where: { scopeType: scope }, include: { project: { select: { name: true, archivedAt: true } } }, orderBy: { scopeId: 'asc' } });
    return { items: rows.map((row) => ({ scopeType: row.scopeType, scopeId: row.scopeId, projectId: row.projectId, projectName: row.project.name, projectArchived: !!row.project.archivedAt })) };
  }
}

/** Task binding overrides the list's default project. Inbox tasks need an explicit override. */
export async function resolveProjectForTask(taskId: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task || task.deletedAt) throw new DomainError('NOT_FOUND', '任务不存在', 404);
  const own = await prisma.projectBinding.findUnique({ where: { scopeType_scopeId: { scopeType: 'task', scopeId: task.id } } });
  const inherited = !own && task.topicId ? await prisma.projectBinding.findUnique({ where: { scopeType_scopeId: { scopeType: 'topic', scopeId: task.topicId } } }) : null;
  const binding = own ?? inherited;
  if (!binding) throw new DomainError('PROJECT_REQUIRED', task.topicId ? '请先给清单设置默认项目，或给主任务单独指定项目' : '收集箱任务需要单独指定项目', 400);
  const project = await prisma.project.findUnique({ where: { id: binding.projectId } });
  if (!project || project.archivedAt) throw new DomainError('PROJECT_REQUIRED', '绑定的项目已归档', 400);
  return { project, source: own ? 'task' as const : 'topic' as const };
}

export async function applyProbeResult(job: NodeJob) {
  const location = await prisma.projectLocation.findFirst({ where: { nodeId: job.nodeId, path: (JSON.parse(job.payloadJson) as { path: string }).path } });
  if (!location) return;
  const report = job.resultJson ? JSON.parse(job.resultJson) as { ok: boolean; result?: unknown; error?: string | null } : null;
  const parsed = report?.ok ? probeResultSchema.safeParse(report.result) : null;
  if (parsed?.success) await prisma.projectLocation.update({ where: { id: location.id }, data: { status: 'verified', fingerprintJson: JSON.stringify(parsed.data), error: null, verifiedAt: now(), updatedAt: now() } });
  else await prisma.projectLocation.update({ where: { id: location.id }, data: { status: 'failed', error: report?.error ?? (parsed ? '电脑返回的探测结果无效' : job.error ?? '探测失败'), updatedAt: now() } });
}
