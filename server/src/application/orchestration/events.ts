import type { Prisma } from '@prisma/client';
import { publishWorkspaceChange } from '../commands.js';

type Db = Prisma.TransactionClient;
/** Append-only audit of every orchestrator decision, comparison, node report and user override. */
export async function appendOrchestrationEvent(tx: Db, orchestrationId: string, type: string, actorKind: 'model' | 'server' | 'node' | 'user', stepId: string | null | undefined, payload: unknown) {
  const last = await tx.orchestrationEvent.findFirst({ where: { orchestrationId }, orderBy: { seq: 'desc' }, select: { seq: true } });
  return tx.orchestrationEvent.create({ data: { orchestrationId, seq: (last?.seq ?? 0) + 1, type, actorKind, stepId: stepId ?? null, payload: JSON.stringify(payload ?? null), createdAt: new Date().toISOString() } });
}
export function publishOrchestration(data: { orchestrationId: string; taskId: string; status: string; pauseReason?: string | null }) {
  publishWorkspaceChange({ kind: 'orchestration', ...data, attention: data.status === 'awaiting_acceptance' || data.status === 'paused' });
}
