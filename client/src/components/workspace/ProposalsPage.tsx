import { usePageContext } from '@/lib/assistant-context.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type { Approval } from '@/chat.js';
import { json, operationNames, parseStored, usePlatformAction, type Command } from '@/lib/platform.js';
import { intlLocale } from '../../i18n/index.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { TaskBatchCard } from '@/components/chat/TaskBatchCard.js';
import { ReviewCard } from '@/components/chat/ReviewCard.js';
import type { AppOutcome, AppReview } from '../../../../server/src/domain/task-batch-types.js';

type BatchCard = { approvalId: string; status: string; preview?: Approval['preview']; outcome?: Approval['outcome']; supersededByApprovalId?: string };
type AppChangeCard = { approvalId: string; status: string; review?: AppReview; proposalRevision: number; outcome?: AppOutcome; previewHash?: string; conversationId?: string | null };
type Proposal = { id: string; status: string; revision: number; actorId: string; commands: Command[] | string; preview: unknown; createdAt: string; batchCard?: BatchCard; appChangeCard?: AppChangeCard };
function asBatchPreview(value: unknown): Approval['preview'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const preview = value as NonNullable<Approval['preview']>;
  if (preview.schemaVersion !== 1 || !Array.isArray(preview.beforeTasks) || !Array.isArray(preview.afterTasks)) return undefined;
  return preview;
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
const fieldKeys = ['title', 'name', 'description', 'content', 'dueDate', 'priority', 'status', 'resultSummary', 'reason'] as const;
export function ProposalsPage() {
  const { t } = useTranslation('workspace');
  const [status, setStatus] = useState('pending');
  usePageContext('proposals', { pageState: { status } });
  const [pinned, setPinned] = useState<Proposal[]>([]);
  const query = useQuery({ queryKey: ['proposals', status], queryFn: () => api<Proposal[]>(`/api/v1/proposals?status=${status}`) });
  const rows = new Map<string, Proposal>();
  for (const proposal of query.data ?? []) rows.set(proposal.id, proposal);
  for (const proposal of pinned) rows.set(proposal.id, proposal);
  const visible = [...rows.values()];
  const pin = (proposal: Proposal) => setPinned((current) => [...current.filter((item) => item.id !== proposal.id), proposal]);
  return <section className="mx-auto max-w-4xl space-y-5 p-5 sm:p-7"><header className="flex flex-wrap justify-between gap-3"><div><h1 className="text-2xl font-semibold">{t('proposals.title')}</h1><p className="mt-2 text-sm text-muted-foreground">{t('proposals.description')}</p></div><select className="glass-control h-10 rounded-lg px-3" aria-label={t('proposals.statusAria')} value={status} onChange={(event) => { setStatus(event.target.value); setPinned([]); }}><option value="pending">{t('proposals.pending')}</option><option value="applied">{t('proposals.applied')}</option><option value="rejected">{t('proposals.rejected')}</option></select></header>{query.error && <p role="alert">{query.error.message}</p>}{query.isLoading && !visible.length ? <p>{t('proposals.loading')}</p> : !visible.length ? <p className="py-8 text-sm text-muted-foreground">{t('proposals.empty')}</p> : visible.map((proposal) => proposal.appChangeCard?.review ? <AppChangeProposalCard key={`${proposal.id}:${proposal.revision}`} proposal={proposal} onSettled={pin} /> : proposal.batchCard || asBatchPreview(proposal.preview) ? <BatchProposalCard key={`${proposal.id}:${proposal.revision}`} proposal={proposal} onSettled={pin} /> : <ProposalCard key={`${proposal.id}:${proposal.revision}`} proposal={proposal} />)}</section>;
}
function ProposalCard({ proposal }: { proposal: Proposal }) {
  const { t } = useTranslation('workspace');
  const original = parseStored<Command[]>(proposal.commands, []);
  const [commands, setCommands] = useState(original);
  const { run, busy } = usePlatformAction();
  const preview = parseStored<any[]>(proposal.preview as any, []);
  const dirty = json(original) !== json(commands);
  const change = (index: number, key: string, value: unknown) => setCommands((all) => all.map((command, i) => i === index ? { ...command, input: { ...command.input, [key]: value } } : command));
  const fieldLabel: Record<string, string> = Object.fromEntries(fieldKeys.map((key) => [key, t(`proposals.fields.${key}`)]));
  return <article className="glass-subtle space-y-4 rounded-xl p-4"><div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{t('proposals.from', { actor: proposal.actorId })}</span><time>{new Date(proposal.createdAt).toLocaleString(intlLocale())}</time></div>{commands.map((command, index) => <div key={index} className="space-y-3 border-t pt-3"><h2 className="font-semibold">{operationNames[command.kind] ?? command.kind.replace(/_/g, ' ')}{command.targetId && <span className="ml-2 text-xs font-normal text-muted-foreground">{command.targetId}</span>}</h2>{preview[index]?.detail?.before && <p className="text-xs text-muted-foreground">{t('proposals.previous', { title: preview[index].detail.before.title ?? preview[index].detail.before.name ?? '', revision: preview[index].detail.before.revision })}</p>}{Object.entries(command.input ?? {}).map(([key, value]) => fieldLabel[key] && (typeof value === 'string' || value === null) ? <label className="block text-sm" key={key}>{fieldLabel[key]}{['description', 'content', 'resultSummary'].includes(key) ? <Textarea className="mt-1" value={String(value ?? '')} disabled={proposal.status !== 'pending'} onChange={(event) => change(index, key, event.target.value)} /> : <Input className="mt-1" type={key === 'dueDate' ? 'date' : 'text'} value={String(value ?? '')} disabled={proposal.status !== 'pending'} onChange={(event) => change(index, key, key === 'dueDate' ? event.target.value || null : event.target.value)} />}</label> : <p className="break-all text-sm text-muted-foreground" key={key}>{t('proposals.fieldValue', { key, value: Array.isArray(value) ? value.join(t('listSeparator')) : typeof value === 'object' ? t('proposals.attached') : String(value) })}</p>)}</div>)}<div className="space-y-2 text-xs text-muted-foreground">{preview.map((item, index) => { const tasks = item.detail?.affectedTasks?.map((task: any) => t('proposals.affectedTask', { title: task.title, revision: task.revision })).join(t('listSeparator')); return <p key={index}>{tasks ? t('proposals.affectedLine', { tasks }) : t('proposals.updateObject')}</p>; })}</div><details className="disclosure"><summary className="cursor-pointer text-sm text-muted-foreground">{t('proposals.evidence')}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{typeof proposal.preview === 'string' ? proposal.preview : JSON.stringify(proposal.preview, null, 2)}</pre></details>{proposal.status === 'pending' && <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => void run(() => api(`/api/v1/proposals/${proposal.id}/reject`, { method: 'POST', body: json({ expectedRevision: proposal.revision }) }), t('proposals.rejected'))}>{t('proposals.reject')}</Button>{dirty ? <Button disabled={busy} onClick={() => void run(() => api(`/api/v1/proposals/${proposal.id}`, { method: 'PATCH', body: json({ expectedRevision: proposal.revision, commands }) }), t('proposals.updated'))}>{t('proposals.savePreview')}</Button> : <Button disabled={busy} onClick={() => void run(() => api(`/api/v1/proposals/${proposal.id}/approve`, { method: 'POST', body: json({ expectedRevision: proposal.revision, requestId: crypto.randomUUID() }) }), t('proposals.appliedToast'))}>{t('proposals.confirm')}</Button>}</div>}</article>;
}
