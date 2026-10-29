import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { DomainError } from '../domain/task.js';
import { ownerActor } from './security.js';
import type { MutationContext } from './workspace-store.js';

export const checkpointMeta = z.object({
  schemaVersion: z.literal(1), type: z.literal('checkpoint'),
  unresolvedQuestions: z.array(z.string().trim().min(1).max(1000)).max(30).default([]),
  nextStep: z.string().max(2000).default(''),
  sources: z.array(z.object({ kind: z.enum(['message', 'session', 'attempt']), id: z.string().min(1).max(200) }).strict()).max(30).default([]),
}).strict();

export async function checkedCheckpoint(tx: Prisma.TransactionClient, input: { mapId: string; nodeId: string | null; kind: string; meta?: Record<string, unknown> }) {
  if (input.meta?.type !== 'checkpoint') return null;
  if (input.kind !== 'session') throw new DomainError('INVALID_CHECKPOINT', '学习收尾必须保存为学习记录', 400);
  const meta = checkpointMeta.parse(input.meta);
  for (const source of meta.sources) {
    let valid = false;
    if (source.kind === 'message') {
      valid = Boolean(await tx.message.findFirst({ where: { id: source.id, conversation: { identityId: 'study' } }, select: { id: true } }));
    } else if (source.kind === 'session') {
      valid = Boolean(await tx.learningPracticeSession.findFirst({ where: { id: source.id, ownerId: ownerActor.id, mapId: input.mapId }, select: { id: true } }));
    } else {
      const attempt = await tx.learningAttempt.findFirst({ where: { id: source.id, ownerId: ownerActor.id } });
      const item = attempt ? await tx.learningPracticeItem.findUnique({ where: { id: attempt.itemId } }) : null;
      const session = item ? await tx.learningPracticeSession.findUnique({ where: { id: item.sessionId } }) : null;
      const version = attempt ? await tx.learningQuestionVersion.findUnique({ where: { id: attempt.questionVersionId } }) : null;
      valid = session?.mapId === input.mapId && (!input.nodeId || version?.nodeId === input.nodeId);
    }
    if (!valid) throw new DomainError('INVALID_CHECKPOINT_SOURCE', '学习收尾引用的来源不存在或不属于当前学习范围', 400);
  }
  return meta;
}

export function confirmedCheckpoint(meta: z.infer<typeof checkpointMeta>, context: MutationContext, confirmedAt: string) {
  return { ...meta, confirmation: {
    kind: context.source === 'agent' ? 'approval' : 'user',
    actorId: context.approvedByActorId ?? context.actor?.id ?? ownerActor.id,
    proposalId: context.proposalId ?? null, approvalId: context.approvalId ?? null,
    conversationId: context.conversationId ?? null, confirmedAt,
  } };
}
