import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { intlLocale, t } from '@/i18n/index.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { orchestrationStatusLabels } from './labels.js';

type Usage = { orchestrationId: string; taskId: string; status: string; role: 'integration' | 'subtask'; pushed: boolean };
type Entry = { path: string; name: string; branch: string | null; head: string | null; dirtyCount: number; sizeBytes: number; sizeTruncated: boolean; modifiedAt: string | null; broken: boolean; usage: Usage | null; action: 'remove' | 'blocked'; reason: string | null; warning: string | null };
type CardItem = { path: string; name: string; branch: string | null; dirtyCount: number; sizeBytes: number; usage: Usage | null; action: 'remove' | 'blocked'; reason: string | null; warning: string | null };
export type CleanupCard = { id: string; nodeId: string; nodeName: string; status: string; source: string; deleteBranches: boolean; expiresAt: string; items: CardItem[]; removableCount: number; removableBytes: number; result: { removed?: Array<{ path: string; branch: string | null; branchDeleted: boolean; branchNote: string | null }>; skipped?: Array<{ path: string; reason: string }>; error?: string } | null };
type NodeView = { node: { id: string; name: string; online: boolean; platform: string }; inventoryAt: string | null; refreshing: boolean; cleaning: boolean; runs: { count: number; sizeBytes: number } | null; freeBytes: number | null; worktrees: Entry[]; pendingCards: CleanupCard[] };

export function formatBytes(value: number | null | undefined) {
  if (value === null || value === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let size = value; let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}
const usageLabel = (usage: Usage | null) => {
  if (!usage) return t('orchestration:worktrees.unlinked');
  const pushed = usage.role === 'integration' && usage.status === 'accepted' ? usage.pushed ? t('orchestration:worktrees.pushed') : t('orchestration:worktrees.notPushed') : '';
  return t('orchestration:worktrees.usage', { role: usage.role === 'integration' ? t('orchestration:worktrees.roleIntegration') : t('orchestration:worktrees.roleSubtask'), status: orchestrationStatusLabels[usage.status] ?? usage.status, pushed });
};

/** Worktrees each local executor created. Listing and deleting are jobs for that executor; the server never touches the files. */
export function WorktreesPage() {
  const { t: tr } = useTranslation('orchestration');
  const overview = useQuery({ queryKey: ['worktrees'], queryFn: () => api<NodeView[]>('/api/worktrees'), refetchInterval: (query) => (query.state.data ?? []).some((item) => item.refreshing || item.cleaning) ? 1500 : 10_000 });
  return <div className="space-y-6 p-5 sm:p-7" aria-label={tr('worktrees.aria')}>
    <div><h1 className="text-2xl font-semibold">{tr('worktrees.title')}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{tr('worktrees.intro')}</p></div>
    {overview.isLoading && <p className="text-sm text-muted-foreground">{tr('worktrees.loading')}</p>}
    {overview.error && <p role="alert" className="text-sm text-destructive">{(overview.error as Error).message}</p>}
    {overview.data && !overview.data.length && <p className="text-sm text-muted-foreground">{tr('worktrees.empty')}</p>}
    {overview.data?.map((view) => <NodeSection key={view.node.id} view={view} />)}
  </div>;
}

function NodeSection({ view }: { view: NodeView }) {
  const { t: tr } = useTranslation('orchestration');
  const client = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [deleteBranches, setDeleteBranches] = useState(false);
  const [card, setCard] = useState<CleanupCard | null>(null);
  const refresh = useMutation({ mutationFn: () => api(`/api/nodes/${view.node.id}/inventory`, { method: 'POST', body: '{}' }), onSuccess: () => void client.invalidateQueries({ queryKey: ['worktrees'] }), onError: (error) => toast.error(error.message) });
  const preview = useMutation({ mutationFn: () => api<CleanupCard>('/api/worktree-cleanups', { method: 'POST', body: JSON.stringify({ nodeId: view.node.id, paths: selected, deleteBranches }) }), onSuccess: (data) => { setCard(data); void client.invalidateQueries({ queryKey: ['worktrees'] }); }, onError: (error) => toast.error(error.message) });
  const removable = view.worktrees.filter((entry) => entry.action === 'remove');
  const chosen = selected.filter((path) => view.worktrees.some((entry) => entry.path === path));
  const total = view.worktrees.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const reported = view.inventoryAt ? tr('worktrees.reported', { time: new Date(view.inventoryAt).toLocaleString(intlLocale()) }) : tr('worktrees.notReported');
  const runs = view.runs ? tr('worktrees.runs', { count: view.runs.count, size: formatBytes(view.runs.sizeBytes) }) : '—';
  return <section className="rounded-xl border p-4" aria-label={tr('worktrees.nodeSection', { name: view.node.name })}>
    <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{view.node.name}</h2><span className={view.node.online ? 'text-xs text-green-600' : 'text-xs text-muted-foreground'}>{view.node.online ? tr('worktrees.online') : tr('worktrees.offline')}</span>
      <span className="text-xs text-muted-foreground">{tr('worktrees.inventory', { reported, count: view.worktrees.length, total: formatBytes(total), runs, free: formatBytes(view.freeBytes) })}</span>
      <Button size="sm" variant="outline" className="ml-auto" disabled={view.refreshing || refresh.isPending} onClick={() => refresh.mutate()}>{view.refreshing ? tr('worktrees.scanning') : tr('worktrees.refresh')}</Button></div>
    {view.pendingCards.map((item) => <CleanupCardView key={item.id} card={item} />)}
    {view.worktrees.length > 0 && <>
      <table className="mt-3 w-full text-left text-xs"><thead className="text-muted-foreground"><tr><th className="w-6"><input type="checkbox" aria-label={tr('worktrees.selectAll')} checked={removable.length > 0 && removable.every((entry) => chosen.includes(entry.path))} onChange={(event) => setSelected(event.target.checked ? removable.map((entry) => entry.path) : [])} /></th><th>{tr('worktrees.name')}</th><th>{tr('worktrees.branch')}</th><th>{tr('worktrees.size')}</th><th>{tr('worktrees.state')}</th><th>{tr('worktrees.link')}</th></tr></thead>
        <tbody>{view.worktrees.map((entry) => <tr key={entry.path} className="border-t align-top">
          <td className="py-1"><input type="checkbox" aria-label={tr('worktrees.selectEntry', { name: entry.name })} disabled={entry.action === 'blocked'} checked={chosen.includes(entry.path)} onChange={(event) => setSelected(event.target.checked ? [...chosen, entry.path] : chosen.filter((path) => path !== entry.path))} /></td>
          <td className="py-1"><div className="font-medium">{entry.name}</div><code className="break-all text-muted-foreground">{entry.path}</code></td>
          <td className="py-1"><code className="break-all">{entry.branch ?? '—'}</code>{entry.head && <div className="text-muted-foreground">{entry.head.slice(0, 10)}</div>}</td>
          <td className="py-1">{formatBytes(entry.sizeBytes)}{entry.sizeTruncated ? '+' : ''}</td>
          <td className="py-1">{entry.broken ? tr('worktrees.broken') : entry.dirtyCount ? tr('worktrees.dirty', { count: entry.dirtyCount }) : tr('worktrees.clean')}{entry.reason && <div className="text-amber-600">{entry.reason}</div>}{entry.warning && <div className="text-muted-foreground">{entry.warning}</div>}</td>
          <td className="py-1">{usageLabel(entry.usage)}</td>
        </tr>)}</tbody></table>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={deleteBranches} onChange={(event) => setDeleteBranches(event.target.checked)} />{tr('worktrees.deleteBranches')}</label>
        <Button size="sm" variant="outline" className="text-destructive" disabled={!chosen.length || preview.isPending || view.cleaning} onClick={() => preview.mutate()}>{tr('worktrees.deleteSelected', { count: chosen.length })}</Button>
      </div>
    </>}
    {card && <CleanupDialog card={card} onClose={() => { setCard(null); setSelected([]); }} />}
  </section>;
}

function useCleanupActions(card: CleanupCard, onDone?: () => void) {
  const client = useQueryClient();
  const settle = () => { void client.invalidateQueries({ queryKey: ['worktrees'] }); onDone?.(); };
  const confirm = useMutation({ mutationFn: () => api<CleanupCard>(`/api/worktree-cleanups/${card.id}/confirm`, { method: 'POST', body: '{}' }), onSuccess: () => { toast.success(t('orchestration:worktrees.handedOff')); settle(); }, onError: (error) => { toast.error(error.message); settle(); } });
  const cancel = useMutation({ mutationFn: () => api(`/api/worktree-cleanups/${card.id}/cancel`, { method: 'POST', body: '{}' }), onSuccess: settle, onError: (error) => { toast.error(error.message); settle(); } });
  return { confirm, cancel };
}

function CardBody({ card }: { card: CleanupCard }) {
  const { t: tr } = useTranslation('orchestration');
  return <div className="space-y-2 text-sm">
    <ul className="space-y-1">{card.items.map((item) => <li key={item.path} className="rounded border px-2 py-1 text-xs"><span className={item.action === 'remove' ? 'font-medium text-destructive' : 'font-medium text-muted-foreground'}>{item.action === 'remove' ? tr('worktrees.remove') : tr('worktrees.keep')}</span> {item.name} <span className="text-muted-foreground">{item.branch ?? ''} · {formatBytes(item.sizeBytes)}</span>{item.reason && <div className="text-amber-600">{item.reason}</div>}{item.warning && <div className="text-muted-foreground">{item.warning}</div>}</li>)}</ul>
    <p className="text-xs text-muted-foreground">{tr('worktrees.summary', { name: card.nodeName, count: card.removableCount, bytes: formatBytes(card.removableBytes), branches: card.deleteBranches ? tr('worktrees.branchesDelete') : tr('worktrees.branchesKeep'), time: new Date(card.expiresAt).toLocaleTimeString(intlLocale()), source: card.source === 'assistant' ? tr('worktrees.sourceAssistant') : '' })}</p>
  </div>;
}

/** The confirmation card shown right after the delete button. Nothing reaches the node before the user confirms. */
function CleanupDialog({ card, onClose }: { card: CleanupCard; onClose: () => void }) {
  const { t: tr } = useTranslation('orchestration');
  const { confirm, cancel } = useCleanupActions(card, onClose);
  return <Dialog open onOpenChange={(open) => { if (!open) cancel.mutate(); }}>
    <DialogContent className="max-w-[min(40rem,calc(100%-2rem))]" aria-label={tr('worktrees.confirmAria')}>
      <DialogHeader><DialogTitle>{tr('worktrees.confirmTitle')}</DialogTitle><DialogDescription>{tr('worktrees.confirmDescription')}</DialogDescription></DialogHeader>
      <CardBody card={card} />
      <DialogFooter><Button variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>{tr('worktrees.cancel')}</Button><Button variant="destructive" disabled={!card.removableCount || confirm.isPending} onClick={() => confirm.mutate()}>{tr('worktrees.confirmCount', { count: card.removableCount })}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** A card created elsewhere (for example by the AI assistant) that still waits for the user's decision. */
export function CleanupCardView({ card }: { card: CleanupCard }) {
  const { t: tr } = useTranslation('orchestration');
  const { confirm, cancel } = useCleanupActions(card);
  if (card.status === 'confirmed') return <p role="status" className="mt-3 rounded bg-muted p-2 text-xs">{tr('worktrees.deleting', { count: card.removableCount })}</p>;
  return <div role="group" aria-label={tr('worktrees.pendingAria')} className="mt-3 rounded border border-amber-500/40 bg-amber-500/5 p-3">
    <div className="mb-2 text-sm font-medium">{tr('worktrees.pendingTitle')}</div>
    <CardBody card={card} />
    <div className="mt-2 flex gap-2"><Button size="sm" variant="destructive" disabled={!card.removableCount || confirm.isPending} onClick={() => confirm.mutate()}>{tr('worktrees.confirm')}</Button><Button size="sm" variant="ghost" onClick={() => cancel.mutate()}>{tr('worktrees.cancel')}</Button></div>
  </div>;
}

const chatStatusKeys = { cancelled: 'worktrees.chatStatus.cancelled', expired: 'worktrees.chatStatus.expired', failed: 'worktrees.chatStatus.failed' } as const;

/** The assistant's cleanup proposal inside the chat. It reads the card's live state; only the buttons here (or on #/worktrees) can confirm it. */
export function WorktreeCleanupChatCard({ cleanupId }: { cleanupId: string }) {
  const { t: tr } = useTranslation('orchestration');
  const query = useQuery({
    queryKey: ['worktrees', 'cleanup', cleanupId],
    queryFn: ({ signal }) => api<CleanupCard>(`/api/worktree-cleanups/${cleanupId}`, { signal }),
    refetchInterval: (current) => current.state.data?.status === 'confirmed' ? 3000 : false,
  });
  const card = query.data;
  if (query.error) return <p role="alert" className="mt-3 text-xs text-destructive">{tr('worktrees.chatLoadFailed', { message: query.error.message })}</p>;
  if (!card) return <p className="mt-3 text-xs text-muted-foreground">{tr('worktrees.chatLoading')}</p>;
  const expired = card.status === 'pending' && Date.parse(card.expiresAt) < Date.now();
  if ((card.status === 'pending' && !expired) || card.status === 'confirmed') return <CleanupCardView card={card} />;
  if (card.status === 'done') {
    const removed = card.result?.removed ?? [];
    const skipped = card.result?.skipped ?? [];
    return <div role="status" aria-label={tr('worktrees.chatResultAria')} className="mt-3 rounded border p-3 text-xs">
      <div className="font-medium">{tr('worktrees.chatRemoved', { name: card.nodeName, count: removed.length })}</div>
      {removed.map((item) => <div key={item.path} className="text-muted-foreground">{item.path}{item.branch ? ` · ${item.branch}${item.branchDeleted ? tr('worktrees.branchDeleted') : item.branchNote ? tr('worktrees.branchNote', { note: item.branchNote }) : ''}` : ''}</div>)}
      {skipped.map((item) => <div key={item.path} className="text-amber-600">{tr('worktrees.chatKept', { path: item.path, reason: item.reason })}</div>)}
    </div>;
  }
  const statusKey = expired ? 'expired' : card.status;
  const statusText = statusKey in chatStatusKeys ? tr(chatStatusKeys[statusKey as keyof typeof chatStatusKeys]) : card.status;
  return <p role="status" className="mt-3 rounded bg-muted p-2 text-xs">{statusText}{card.result?.error ? ` ${card.result.error}` : ''}</p>;
}
