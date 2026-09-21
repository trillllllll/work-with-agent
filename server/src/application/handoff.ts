import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { assertOwner, assertTopicAccess, refreshActor, type Actor } from './security.js';
import { providerSchema, permissionsSchema } from '../runner/contracts.js';
import { digest } from '../runner/workspaces.js';
import { activeRunStatuses, appendEvent, decode, handoffAccess, handoffAudit, handoffDto, now, requestSchema, runDto } from './handoff-contracts.js';
import { executeInTransaction } from './commands.js';
import { takeKnowledgeSnapshot } from './knowledge.js';

const prepareSchema = z.object({ taskId: z.string().min(1), expectedTaskRevision: z.number().int().positive(), instruction: z.string().trim().min(1).max(100000), provider: providerSchema, mode: z.enum(['manual', 'local']).default('manual'), permissions: permissionsSchema.default({}), materialIds: z.array(z.string()).max(100).optional(), memoryIds: z.array(z.string()).max(100).optional() }).strict();
export class HandoffService {
  async list(actor: Actor, taskId?: string) {
    actor = await refreshActor(actor);
    const rows = await prisma.handoff.findMany({ where: taskId ? { taskId } : {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const result = [];
    for (const row of rows) { try { await handoffAccess(actor, row.id); result.push(handoffDto(row)); } catch (error) { if (!(error instanceof DomainError && error.status === 403)) throw error; } }
    return result;
  }
  async get(actor: Actor, id: string) {
    const handoff = await handoffAccess(actor, id);
    return { ...handoffDto(handoff), runs: (await prisma.run.findMany({ where: { handoffId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(runDto), reviews: await prisma.handoffReview.findMany({ where: { handoffId: id }, orderBy: { createdAt: 'asc' } }) };
  }
  async prepare(actor: Actor, raw: unknown) {
    assertOwner(actor);
    const input = prepareSchema.parse(raw);
    return prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id: input.taskId }, include: { tags: { include: { tag: true } }, children: { where: { deletedAt: null } }, topic: true } });
      if (!task) throw new DomainError('NOT_FOUND', '任务不存在', 404);
      assertTopicAccess(actor, task.topicId);
      if (task.deletedAt || task.topic?.archivedAt) throw new DomainError('TASK_NOT_EDITABLE', '不能交接已删除或已归档的任务');
      if (task.revision !== input.expectedTaskRevision) throw new DomainError('VERSION_CONFLICT', '任务已变化，请刷新后准备交接');
      const knowledge = await takeKnowledgeSnapshot(actor, { topicId: task.topicId, taskIds: [], materialIds: input.materialIds, memoryIds: input.memoryIds }, tx);
      const inputSnapshot = JSON.stringify({ version: 1, task, knowledge, capturedAt: now() });
      const row = await tx.handoff.create({ data: { taskId: task.id, provider: input.provider, mode: input.mode, instruction: input.instruction, inputSnapshot, inputHash: digest(inputSnapshot), permissions: JSON.stringify(input.permissions), createdBy: actor.id, createdAt: now(), updatedAt: now() } });
      await handoffAudit(tx, actor, 'handoff', row.id, 'prepare', null, { inputHash: row.inputHash, taskId: row.taskId });
      return handoffDto(row);
    });
  }
  async claim(actor: Actor, id: string, raw: unknown) {
    actor = await refreshActor(actor);
    if (actor.kind !== 'connection') throw new DomainError('CONNECTION_REQUIRED', '请从已授权的外部 AI 会话领取交接', 403);
    const input = z.object({ requestId: requestSchema, externalSessionId: z.string().min(1).max(200).optional() }).strict().parse(raw);
    return prisma.$transaction(async (tx) => {
      const handoff = await handoffAccess(actor, id, tx);
      if (handoff.mode !== 'manual') throw new DomainError('HANDOFF_MODE', '本交接由本机运行器执行');
      const connection = await tx.connection.findUniqueOrThrow({ where: { id: actor.connectionId } });
      const host = connection.host.trim().toLowerCase().replace(/[ _]+/g, '-');
      const provider = ['claude', 'claude-code'].includes(host) ? 'claude' : host === 'codex' ? 'codex' : null;
      if (provider !== handoff.provider) throw new DomainError('HOST_MISMATCH', '此连接的 AI 宿主与交接选择的提供方不一致', 403);
      const prior = (await tx.run.findMany({ where: { handoffId: id } })).find((row) => decode<{ requestId?: string }>(row.configJson).requestId === input.requestId && row.claimOwner === actor.id);
      if (prior) return { run: runDto(prior), replay: true, claimToken: null, message: '领取令牌只在首次返回；丢失后请取消并重新交接' };
      if (!['prepared', 'needs_input', 'rejected'].includes(handoff.status)) throw new DomainError('HANDOFF_UNAVAILABLE', '交接已领取、已取消或已验收');
      if (await tx.run.count({ where: { handoffId: id, status: { in: activeRunStatuses } } })) throw new DomainError('HANDOFF_CLAIMED', '交接正在执行');
      const token = randomBytes(32).toString('base64url');
      const latest = await tx.run.findFirst({ where: { handoffId: id }, orderBy: { createdAt: 'desc' } });
      const run = await tx.run.create({ data: { handoffId: id, provider: handoff.provider, mode: 'manual', status: 'accepted', claimOwner: actor.id, claimTokenHash: digest(token), externalSessionId: input.externalSessionId, continuationOf: latest?.id, configJson: JSON.stringify({ requestId: input.requestId, actorId: actor.id, inputHash: handoff.inputHash }), createdAt: now(), updatedAt: now() } });
      await tx.handoff.update({ where: { id }, data: { status: 'running', revision: { increment: 1 }, updatedAt: now() } });
      await appendEvent(tx, run.id, 'claimed', { actorId: actor.id }, `claim:${input.requestId}`);
      await handoffAudit(tx, actor, 'run', run.id, 'claim', null, { handoffId: id });
      return { run: runDto(run), claimToken: token, handoff: handoffDto(handoff) };
    });
  }
  async revise(actor: Actor, id: string, raw: unknown) {
    assertOwner(actor);
    const input = z.object({ expectedRevision: z.number().int().positive(), expectedTaskRevision: z.number().int().positive(), instruction: z.string().trim().min(1).max(100000).optional(), provider: providerSchema.optional(), mode: z.enum(['manual', 'local']).optional(), permissions: permissionsSchema.optional(), materialIds: z.array(z.string()).max(100).optional(), memoryIds: z.array(z.string()).max(100).optional() }).strict().parse(raw);
    return prisma.$transaction(async (tx) => {
      const previous = await handoffAccess(actor, id, tx);
      if (previous.status !== 'prepared' || await tx.run.count({ where: { handoffId: id } })) throw new DomainError('HANDOFF_FROZEN', '领取或启动后交接内容已冻结，请准备新交接');
      if (previous.revision !== input.expectedRevision) throw new DomainError('VERSION_CONFLICT', '交接已被修改，请刷新');
      const task = await tx.task.findUnique({ where: { id: previous.taskId }, include: { tags: { include: { tag: true } }, children: { where: { deletedAt: null } }, topic: true } });
      if (!task || task.deletedAt || task.topic?.archivedAt) throw new DomainError('TASK_NOT_EDITABLE', '原任务已删除或归档');
      if (task.revision !== input.expectedTaskRevision) throw new DomainError('VERSION_CONFLICT', '任务已有后续修改');
      const oldSnapshot = decode<{ knowledge: { sources: Array<{ type: string; id: string }> } }>(previous.inputSnapshot);
      const knowledge = await takeKnowledgeSnapshot(actor, { topicId: task.topicId, taskIds: [], materialIds: input.materialIds ?? oldSnapshot.knowledge.sources.filter((source) => source.type === 'material').map((source) => source.id), memoryIds: input.memoryIds ?? oldSnapshot.knowledge.sources.filter((source) => source.type === 'memory').map((source) => source.id) }, tx);
      const inputSnapshot = JSON.stringify({ version: 1, task, knowledge, capturedAt: now() });
      const row = await tx.handoff.update({ where: { id }, data: { instruction: input.instruction, provider: input.provider, mode: input.mode, ...(input.permissions ? { permissions: JSON.stringify(input.permissions) } : {}), inputSnapshot, inputHash: digest(inputSnapshot), revision: { increment: 1 }, updatedAt: now() } });
      await handoffAudit(tx, actor, 'handoff', id, 'revise', previous, row);
      return handoffDto(row);
    });
  }
  async cancel(actor: Actor, id: string) {
    assertOwner(actor);
    const { RunService } = await import('./runs.js');
    const runs = await prisma.run.findMany({ where: { handoffId: id, status: { in: activeRunStatuses } } });
    for (const run of runs) await new RunService().cancel(actor, run.id);
    return prisma.$transaction(async (tx) => {
      const previous = await handoffAccess(actor, id, tx);
      const row = await tx.handoff.update({ where: { id }, data: { status: 'cancelled', revision: { increment: 1 }, updatedAt: now() } });
      await handoffAudit(tx, actor, 'handoff', id, 'cancel', previous, row);
      return handoffDto(row);
    });
  }
  async review(actor: Actor, id: string, raw: unknown) {
    assertOwner(actor);
    const input = z.object({ runId: z.string().min(1), decision: z.enum(['accept', 'reject']), comment: z.string().max(10000).default(''), expectedTaskRevision: z.number().int().positive(), completeTask: z.boolean().default(false), completeChildren: z.boolean().default(false), expectedChildRevisions: z.record(z.number().int().positive()).optional() }).strict().parse(raw);
    if (input.decision !== 'accept' && input.completeTask) throw new DomainError('INVALID_REVIEW', '拒绝结果时不能完成任务', 400);
    return prisma.$transaction(async (tx) => {
      const handoff = await handoffAccess(actor, id, tx);
      const run = await tx.run.findUnique({ where: { id: input.runId } });
      if (!run || run.handoffId !== id || run.status !== 'returned' || !run.resultJson) throw new DomainError('RESULT_NOT_READY', '只能验收已返回的结果');
      if (decode<{ outcome: string }>(run.resultJson).outcome !== 'ready_for_review' && input.decision === 'accept') throw new DomainError('RESULT_INCOMPLETE', '待输入或部分结果不能直接验收');
      if (['accepted', 'cancelled'].includes(handoff.status)) throw new DomainError('HANDOFF_TERMINAL', '交接已验收或取消');
      const latest = await tx.run.findFirst({ where: { handoffId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (latest?.id !== run.id) throw new DomainError('STALE_RUN', '该结果已被后续运行取代');
      const task = await tx.task.findUnique({ where: { id: handoff.taskId }, include: { topic: true } });
      if (!task || task.deletedAt || task.topic?.archivedAt) throw new DomainError('TASK_NOT_EDITABLE', '原任务已删除或归档，请先恢复');
      if (task.revision !== input.expectedTaskRevision) throw new DomainError('VERSION_CONFLICT', '任务已变化，验收不会覆盖后续修改');
      if (input.completeTask && input.completeChildren) {
        if (!input.expectedChildRevisions) throw new DomainError('PRECONDITION_REQUIRED', '一并完成需要提供全部有效子任务的版本', 428);
        const children = await tx.task.findMany({ where: { parentId: task.id, deletedAt: null }, select: { id: true, revision: true } });
        if (children.length !== Object.keys(input.expectedChildRevisions).length || children.some((child) => input.expectedChildRevisions![child.id] !== child.revision)) throw new DomainError('VERSION_CONFLICT', '子任务集合或内容已变化，请重新查看并确认');
      }
      const prior = await tx.handoffReview.findFirst({ where: { runId: run.id } });
      if (prior) throw new DomainError('ALREADY_REVIEWED', '该次结果已经验收');
      if (input.completeTask) await executeInTransaction(tx, actor, { kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { status: 'done', completeChildren: input.completeChildren } });
      const review = await tx.handoffReview.create({ data: { handoffId: id, runId: run.id, decision: input.decision, comment: input.comment, taskRevision: task.revision, createdAt: now() } });
      await tx.handoff.update({ where: { id }, data: { status: input.decision === 'accept' ? 'accepted' : 'rejected', revision: { increment: 1 }, updatedAt: now() } });
      await handoffAudit(tx, actor, 'handoff', id, 'review', { status: handoff.status }, { reviewId: review.id, decision: input.decision, completeTask: input.completeTask });
      return review;
    });
  }
}
