import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { ownerActor } from '../application/security.js';

const id = z.string().trim().min(1).max(200);
const cardInput = z.object({
  kind: z.enum(['node', 'figure', 'practice']), mapId: id.optional(), nodeId: id.optional(), jobId: id.optional(), sessionId: id.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'node' && (!value.nodeId || value.jobId || value.sessionId)
    || value.kind === 'figure' && (value.jobId || value.sessionId)
    || value.kind === 'practice' && (Boolean(value.jobId) === Boolean(value.sessionId) || value.nodeId)) {
    context.addIssue({ code: 'custom', message: 'node 需要 nodeId；practice 需要且只能带 jobId 或 sessionId；其他对象参数不能混用' });
  }
});

/** Cards only identify existing objects. The native practice API owns adoption, answers and grades. */
export async function showLearningCard(args: Record<string, unknown>, run: { id: string; leaseToken: string; conversationId: string; assistantMessageId: string; toolCallId: string }) {
  const input = cardInput.safeParse(args);
  if (!input.success) throw new DomainError('INVALID_TOOL_ARGUMENTS', input.error.issues.map(issue => issue.message).join('；'), 400);
  return prisma.$transaction(async tx => {
    const owned = await tx.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    if (owned.state !== 'running' || owned.leaseToken !== run.leaseToken || !owned.leaseExpiresAt || owned.leaseExpiresAt <= new Date().toISOString()) throw new DomainError('LEASE_LOST', '这次请求已经失去执行权', 409);
    const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: run.conversationId } });
    if (conversation.activeRunId !== run.id) throw new DomainError('RUN_SUPERSEDED', '已有更新的请求', 409);
    if (conversation.identityId !== 'study') throw new DomainError('CAPABILITY_UNAVAILABLE', '只有学习助手可以展示学习卡片', 403);
    const value = input.data;
    const node = value.nodeId ? await tx.learningNode.findFirst({ where: { id: value.nodeId, kind: 'item', deletedAt: null } }) : null;
    const job = value.jobId ? await tx.learningJob.findFirst({ where: { id: value.jobId, ownerId: ownerActor.id, kind: 'generate' } }) : null;
    const session = value.sessionId ? await tx.learningPracticeSession.findFirst({ where: { id: value.sessionId, ownerId: ownerActor.id } }) : null;
    if (value.nodeId && !node || value.jobId && !job || value.sessionId && !session) throw new DomainError('NOT_FOUND', '学习卡片的对象不存在', 404);
    const objectMapId = node?.mapId ?? job?.mapId ?? session?.mapId;
    if (value.mapId && objectMapId && value.mapId !== objectMapId) throw new DomainError('INVALID_TOOL_ARGUMENTS', '卡片对象不属于指定学习主题', 400);
    const mapId = objectMapId ?? value.mapId ?? conversation.learningMapId;
    const map = mapId ? await tx.learningMap.findFirst({ where: { id: mapId, deletedAt: null } }) : null;
    if (!map) throw new DomainError('NOT_FOUND', '学习主题不存在，请先选择主题', 404);
    const part = { schemaVersion: 1, type: 'learning_card', id: createHash('sha256').update(`${run.assistantMessageId}:${run.toolCallId}`).digest('hex').slice(0, 32),
      kind: value.kind, mapId: map.id, ...(node ? { nodeId: node.id } : {}), ...(job ? { jobId: job.id } : {}), ...(session ? { sessionId: session.id } : {}), title: node?.title ?? map.title };
    const message = await tx.message.findFirstOrThrow({ where: { id: run.assistantMessageId, conversationId: run.conversationId, role: 'assistant' } });
    const parts = JSON.parse(message.partsJson || '[]') as Array<{ id?: string }>;
    if (!parts.some(item => item.id === part.id)) {
      parts.push(part);
      await tx.message.update({ where: { id: message.id }, data: { partsJson: JSON.stringify(parts) } });
    }
    return { success: true, data: { partId: part.id, kind: part.kind, mapId: part.mapId }, part };
  });
}
