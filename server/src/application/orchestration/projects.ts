/** Projects are metadata only. A location = a local executor + a path that executor reported and verified. */
import { z } from 'zod';
import type { NodeJob } from '@prisma/client';
import { prisma } from '../../infrastructure/prisma.js';
import { DomainError } from '../../domain/task.js';
import { providerSchema } from '../../runner/contracts.js';
import { enqueueJob, isOnline, now } from './nodes.js';
import { probeResultSchema } from '../../node-agent/protocol.js';

const branchName = z.string().trim().min(1).max(200).regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<!\/)(?<!\.lock)$/, '分支名不合法');
const projectInput = z.object({ name: z.string().trim().min(1).max(100), defaultBranch: branchName.default('main'), defaultProvider: providerSchema.default('codex') }).strict();

export function locationDto(row: { fingerprintJson: string; [key: string]: unknown }) { const { fingerprintJson, ...value } = row; return { ...value, fingerprint: JSON.parse(fingerprintJson) }; }

export class ProjectService {
  async list() {
    const rows = await prisma.project.findMany({ where: { archivedAt: null }, include: { locations: { include: { node: true } } }, orderBy: { createdAt: 'asc' } });
    return rows.map(({ locations, ...project }) => ({ ...project, locations: locations.map(({ node, ...location }) => ({ ...locationDto(location), nodeName: node.name, nodeOnline: isOnline(node) })) }));
  }
  async get(id: string) {
    const project = (await this.list()).find((row) => row.id === id);
    if (!project) throw new DomainError('NOT_FOUND', '项目不存在', 404);
    return project;
  }
  async create(raw: unknown) {
    const input = projectInput.parse(raw);
    return prisma.project.create({ data: { ...input, createdAt: now(), updatedAt: now() } });
  }
  async update(id: string, raw: unknown) {
    const input = projectInput.partial().extend({ expectedRevision: z.number().int().positive(), archived: z.boolean().optional() }).strict().parse(raw);
    const { expectedRevision, archived, ...data } = input;
    const changed = await prisma.project.updateMany({ where: { id, revision: expectedRevision }, data: { ...data, ...(archived === undefined ? {} : { archivedAt: archived ? now() : null }), revision: { increment: 1 }, updatedAt: now() } });
    if (!changed.count) throw new DomainError('VERSION_CONFLICT', '项目已被修改，请刷新');
    return prisma.project.findUniqueOrThrow({ where: { id } });
  }
  /** Adds or replaces the location on one node and asks that node to verify the path. The server never resolves it. */
  async addLocation(projectId: string, raw: unknown) {
    const input = z.object({ nodeId: z.string().min(1), path: z.string().trim().min(1).max(4096) }).strict().parse(raw);
    return prisma.$transaction(async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (!project || project.archivedAt) throw new DomainError('NOT_FOUND', '项目不存在', 404);
      const node = await tx.agentNode.findUnique({ where: { id: input.nodeId } });
      if (!node || node.status !== 'active') throw new DomainError('NODE_UNAVAILABLE', '执行端不存在或已吊销', 400);
      const busy = await tx.orchestration.count({ where: { locationId: { not: null }, nodeId: node.id, projectId, status: { in: ['running', 'paused'] } } });
      if (busy) throw new DomainError('ORCHESTRATION_ACTIVE', '该位置上有进行中的编排，不能修改', 409);
      const location = await tx.projectLocation.upsert({ where: { projectId_nodeId: { projectId, nodeId: node.id } }, create: { projectId, nodeId: node.id, path: input.path, createdAt: now(), updatedAt: now() }, update: { path: input.path, status: 'pending', error: null, verifiedAt: null, fingerprintJson: '{}', updatedAt: now() } });
      const { job } = await enqueueJob(tx, { nodeId: node.id, kind: 'probe', phase: 'probe', dispatchKey: `probe:${location.id}:${location.updatedAt}`, payload: { path: input.path } });
      return { location: locationDto(location), jobId: job.id };
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
  else await prisma.projectLocation.update({ where: { id: location.id }, data: { status: 'failed', error: report?.error ?? (parsed ? '执行端返回的探测结果无效' : job.error ?? '探测失败'), updatedAt: now() } });
}
