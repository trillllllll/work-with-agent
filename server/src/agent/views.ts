import { prisma } from '../infrastructure/prisma.js';
import { readEnvelope } from './decision.js';

export async function approvalView(id: string) {
  const row = await prisma.approval.findUnique({ where: { id } });
  if (!row) return null;
  const envelope = readEnvelope(row.result);
  const removed = row.toolName.startsWith('execute_');
  const actions: string[] = [];
  if (!removed && envelope && !envelope.supersededByApprovalId) {
    if (row.status === 'pending') actions.push('approve', 'reject');
    if (envelope.outcome?.status === 'failed' && envelope.outcome.code === 'VERSION_CONFLICT') actions.push('repreview');
    if (envelope.outcome?.status === 'executed' && envelope.outcome.changeId && envelope.review.reversibility === 'supported') actions.push('undo');
  }
  return {
    id: row.id,
    status: envelope?.supersededByApprovalId ? 'superseded' : row.status,
    toolName: row.toolName,
    conversationId: row.conversationId,
    runId: row.runId,
    envelope,
    actions,
    capabilityRemoved: removed,
  };
}
