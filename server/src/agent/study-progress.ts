import type { AgentRun } from '@prisma/client';
import type { Db } from '../application/workspace-store.js';
import type { StoredChatContext } from '../domain/chat-context.js';
import { recordLearningResume, recordPracticeAssistance } from '../application/learning-practice/service.js';
import { ownerActor } from '../application/security.js';

/** Called in the same transaction as the visible chat event. The model cannot
 * create these records through a tool or claim that help was already delivered. */
export async function recordStudyProgress(tx: Db, run: Pick<AgentRun, 'contextJson' | 'sourceUserMessageId'>, type: string, data: unknown) {
  if (!['user_context', 'message_delta', 'block_delta', 'block_commit', 'run_state'].includes(type)) return;
  const context = JSON.parse(run.contextJson) as StoredChatContext;
  if (context.identityId !== 'study' || context.schemaVersion !== 3 || !context.attachments?.length) return;
  const event = data as { delta?: string; compatibilityProjection?: boolean; state?: string; studySupport?: string; block?: { status?: string; type?: string; markdown?: string; studySupport?: string } };
  const requested = type === 'user_context';
  const delivered = (type === 'message_delta' || type === 'block_delta') && Boolean(event.delta?.trim()) && !event.compatibilityProjection
    || type === 'block_commit' && event.block?.status === 'ready' && event.block.type !== 'pending'
      && (event.block.type !== 'text' || Boolean(event.block.markdown?.trim()));
  const failed = type === 'run_state' && ['failed', 'cancelled', 'paused', 'completed'].includes(event.state ?? '');
  if (!requested && !delivered && !failed) return;
  if (requested) {
    // Only explicit sent references advance the knowledge checkpoint; browsing
    // never calls this path. Practice resume remains a separate server record.
    const nodeId = [...context.attachments].reverse().find(item => item.learningNodeId)?.learningNodeId;
    const node = nodeId ? await tx.learningNode.findUnique({ where: { id: nodeId } }) : null;
    if (node?.kind === 'item') await recordLearningResume({ nodeId: node.id, reason: 'message_sent' }, ownerActor, tx);
  }
  const seen = new Set<string>();
  for (const item of context.attachments) {
    if (!item.learningSessionId || !item.learningItemId || !item.learningAttemptId) continue;
    const key = `${item.learningItemId}:${item.learningAttemptId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (failed && await tx.learningPracticeEvent.count({ where: {
      itemId: item.learningItemId, activeAttemptId: item.learningAttemptId, sourceMessageId: run.sourceUserMessageId,
      type: { in: ['assistance_delivered', 'assistance_solution'] },
    } })) continue;
    await recordPracticeAssistance({
      sessionId: item.learningSessionId, sessionItemId: item.learningItemId, activeAttemptId: item.learningAttemptId,
      sourceMessageId: run.sourceUserMessageId, stage: requested ? 'requested' : delivered ? 'delivered' : 'failed',
      solutionExposed: delivered && (event.studySupport === 'solution' || event.block?.studySupport === 'solution'
        || context.attachments.some(ref => ref.learningItemId === item.learningItemId && ref.learningAttemptId === item.learningAttemptId && ref.learningIntent === 'solution')),
    }, ownerActor, tx);
  }
}
