import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type { Approval } from '@/chat.js';
import { TaskBatchCard } from '@/components/chat/TaskBatchCard.js';
import { ReviewCard } from '@/components/chat/ReviewCard.js';
import type { ConnectionName } from '@/lib/proposal-source.js';
import { ProposalOrigin } from './ProposalFrame.js';
import type { Proposal } from './types.js';

export function asBatchPreview(value: unknown): Approval['preview'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const preview = value as NonNullable<Approval['preview']>;
  if (preview.schemaVersion !== 1 || !Array.isArray(preview.beforeTasks) || !Array.isArray(preview.afterTasks)) return undefined;
  return preview;
}

export function isChatProposal(proposal: Proposal): boolean {
  return Boolean(proposal.appChangeCard?.review) || Boolean(proposal.batchCard) || Boolean(asBatchPreview(proposal.preview));
}

function BatchProposalCard({ proposal, onSettled }: { proposal: Proposal; onSettled: (proposal: Proposal) => void }) {
  const client = useQueryClient();
  const preview = asBatchPreview(proposal.batchCard?.preview) ?? asBatchPreview(proposal.preview);
  const [executing, setExecuting] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const batchCard = proposal.batchCard;
  if (!preview || !batchCard) return null;
  const approval: Approval = { approvalId: batchCard.approvalId, toolName: 'propose_task_changes', arguments: {}, status: batchCard.status, preview, outcome: batchCard.outcome, supersededByApprovalId: batchCard.supersededByApprovalId, resultState: 'batch', summary: preview.summary };
  const settle = () => Promise.all([client.invalidateQueries({ queryKey: ['proposals'] }), client.invalidateQueries({ queryKey: ['tasks'] })]);
  const run = async (path: 'approve' | 'reject') => {
    setExecuting(true);
    setUnknown(false);
    try {
      const response = await api<{ result?: Approval['outcome'] }>(`/api/agent/approvals/${approval.approvalId}/${path}`, { method: 'POST' });
      const outcome = response?.result;
      const code = outcome && outcome.success === false ? outcome.code : '';
      const terminal = outcome?.success === true ? 'executed' : code === 'USER_REJECTED' ? 'rejected' : outcome?.success === false ? 'failed' : batchCard.status;
      onSettled({ ...proposal, batchCard: { ...batchCard, status: terminal, outcome } });
      await settle();
    } catch {
      setUnknown(true);
      await settle().catch(() => undefined);
    } finally { setExecuting(false); }
  };
  return <TaskBatchCard approval={approval} executing={executing} unknown={unknown} onApprove={() => void run('approve')} onReject={() => void run('reject')} />;
}

function AppChangeProposalCard({ proposal, onSettled }: { proposal: Proposal; onSettled: (proposal: Proposal) => void }) {
  const client = useQueryClient();
  const card = proposal.appChangeCard;
  const review = card?.review;
  const [phase, setPhase] = useState<'' | 'approve' | 'reject'>('');
  const [unknown, setUnknown] = useState(false);
  if (!card || !review?.previewHash) return null;
  const approval: Approval = { approvalId: card.approvalId, toolName: 'propose_changes', arguments: {}, status: card.status, resultState: 'app_changes', appReview: review, appOutcome: card.outcome, proposalRevision: card.proposalRevision, previewHash: card.previewHash ?? review.previewHash, summary: review.intent, ...(card.conversationId ? { conversationId: card.conversationId } : {}) };
  const settle = () => client.invalidateQueries({ queryKey: ['proposals'] });
  const run = async (path: 'approve' | 'reject') => {
    setPhase(path);
    setUnknown(false);
    try {
      await api(`/api/agent/approvals/${approval.approvalId}/${path}`, { method: 'POST', body: JSON.stringify({ expectedProposalRevision: approval.proposalRevision, previewHash: approval.previewHash }) });
      onSettled({ ...proposal, appChangeCard: { ...card, status: path === 'approve' ? 'executed' : 'rejected' } });
      await settle();
    } catch {
      setUnknown(true);
      await settle().catch(() => undefined);
    } finally { setPhase(''); }
  };
  return <ReviewCard approval={approval} phase={phase} unknown={unknown} onApprove={() => void run('approve')} onReject={() => void run('reject')} onChanged={() => void settle()} />;
}

export function ChatProposalCards({ proposal, connections, onSettled }: { proposal: Proposal; connections?: ConnectionName[]; onSettled: (proposal: Proposal) => void }) {
  const app = Boolean(proposal.appChangeCard?.review?.previewHash);
  const batchPreview = asBatchPreview(proposal.batchCard?.preview) ?? asBatchPreview(proposal.preview);
  const batch = !app && Boolean(batchPreview && proposal.batchCard);
  if (!app && !batch) return null;
  return (
    <div className="space-y-2">
      <ProposalOrigin actorId={proposal.actorId} connectionId={proposal.connectionId} connections={connections} createdAt={proposal.createdAt} />
      {app ? <AppChangeProposalCard proposal={proposal} onSettled={onSettled} /> : <BatchProposalCard proposal={proposal} onSettled={onSettled} />}
    </div>
  );
}
