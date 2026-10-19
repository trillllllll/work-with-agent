import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
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
const usageLabel = (usage: Usage | null) => usage ? `${usage.role === 'integration' ? '集成' : '子任务'} · ${orchestrationStatusLabels[usage.status] ?? usage.status}${usage.role === 'integration' && usage.status === 'accepted' ? usage.pushed ? '（已推送）' : '（未推送）' : ''}` : '未关联编排';

/** Worktrees each local executor created. Listing and deleting are jobs for that executor; the server never touches the files. */
export function WorktreesPage() {
  const overview = useQuery({ queryKey: ['worktrees'], queryFn: () => api<NodeView[]>('/api/worktrees'), refetchInterval: (query) => (query.state.data ?? []).some((item) => item.refreshing || item.cleaning) ? 1500 : 10_000 });
  return <div className="space-y-6 p-5 sm:p-7" aria-label="Worktree 管理">
    <div><h1 className="text-2xl font-semibold">Worktree 管理</h1>
      <p className="mt-1 text-sm text-muted-foreground">这里列出各台本机执行端为主控编排建的 worktree。列表和删除都由那台执行端在本机完成，服务端只看到它上报的结果。删除前会出确认卡片；有未提交改动或正被编排使用的 worktree 不会删除。</p></div>
    {overview.isLoading && <p className="text-sm text-muted-foreground">正在加载…</p>}
    {overview.error && <p role="alert" className="text-sm text-destructive">{(overview.error as Error).message}</p>}
    {overview.data && !overview.data.length && <p className="text-sm text-muted-foreground">还没有本机执行端。在「设置 → 主控编排」里新建。</p>}
    {overview.data?.map((view) => <NodeSection key={view.node.id} view={view} />)}
  </div>;
}

function NodeSection({ view }: { view: NodeView }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [deleteBranches, setDeleteBranches] = useState(false);
  const [card, setCard] = useState<CleanupCard | null>(null);
  const refresh = useMutation({ mutationFn: () => api(`/api/nodes/${view.node.id}/inventory`, { method: 'POST', body: '{}' }), onSuccess: () => void client.invalidateQueries({ queryKey: ['worktrees'] }), onError: (error) => toast.error(error.message) });
  const preview = useMutation({ mutationFn: () => api<CleanupCard>('/api/worktree-cleanups', { method: 'POST', body: JSON.stringify({ nodeId: view.node.id, paths: selected, deleteBranches }) }), onSuccess: (data) => { setCard(data); void client.invalidateQueries({ queryKey: ['worktrees'] }); }, onError: (error) => toast.error(error.message) });
  const removable = view.worktrees.filter((entry) => entry.action === 'remove');
  const chosen = selected.filter((path) => view.worktrees.some((entry) => entry.path === path));
  const total = view.worktrees.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return <section className="rounded-xl border p-4" aria-label={`执行端 ${view.node.name}`}>
    <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{view.node.name}</h2><span className={view.node.online ? 'text-xs text-green-600' : 'text-xs text-muted-foreground'}>{view.node.online ? '在线' : '离线'}</span>
      <span className="text-xs text-muted-foreground">{view.inventoryAt ? `上报于 ${new Date(view.inventoryAt).toLocaleString()}` : '尚未上报'} · worktree {view.worktrees.length} 个，共 {formatBytes(total)} · 运行记录 {view.runs ? `${view.runs.count} 条 / ${formatBytes(view.runs.sizeBytes)}` : '—'} · 剩余空间 {formatBytes(view.freeBytes)}</span>
      <Button size="sm" variant="outline" className="ml-auto" disabled={view.refreshing || refresh.isPending} onClick={() => refresh.mutate()}>{view.refreshing ? '执行端正在扫描…' : '刷新'}</Button></div>
    {view.pendingCards.map((item) => <CleanupCardView key={item.id} card={item} />)}
    {view.worktrees.length > 0 && <>
      <table className="mt-3 w-full text-left text-xs"><thead className="text-muted-foreground"><tr><th className="w-6"><input type="checkbox" aria-label="全选可删除的" checked={removable.length > 0 && removable.every((entry) => chosen.includes(entry.path))} onChange={(event) => setSelected(event.target.checked ? removable.map((entry) => entry.path) : [])} /></th><th>名称</th><th>分支</th><th>大小</th><th>状态</th><th>关联</th></tr></thead>
        <tbody>{view.worktrees.map((entry) => <tr key={entry.path} className="border-t align-top">
          <td className="py-1"><input type="checkbox" aria-label={`选择 ${entry.name}`} disabled={entry.action === 'blocked'} checked={chosen.includes(entry.path)} onChange={(event) => setSelected(event.target.checked ? [...chosen, entry.path] : chosen.filter((path) => path !== entry.path))} /></td>
          <td className="py-1"><div className="font-medium">{entry.name}</div><code className="break-all text-muted-foreground">{entry.path}</code></td>
          <td className="py-1"><code className="break-all">{entry.branch ?? '—'}</code>{entry.head && <div className="text-muted-foreground">{entry.head.slice(0, 10)}</div>}</td>
          <td className="py-1">{formatBytes(entry.sizeBytes)}{entry.sizeTruncated ? '+' : ''}</td>
          <td className="py-1">{entry.broken ? '已损坏' : entry.dirtyCount ? `${entry.dirtyCount} 个未提交` : '干净'}{entry.reason && <div className="text-amber-600">{entry.reason}</div>}{entry.warning && <div className="text-muted-foreground">{entry.warning}</div>}</td>
          <td className="py-1">{usageLabel(entry.usage)}</td>
        </tr>)}</tbody></table>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={deleteBranches} onChange={(event) => setDeleteBranches(event.target.checked)} />同时删除已合入的本地分支（git branch -d，未合入的保留）</label>
        <Button size="sm" variant="outline" className="text-destructive" disabled={!chosen.length || preview.isPending || view.cleaning} onClick={() => preview.mutate()}>删除选中的 {chosen.length} 个…</Button>
      </div>
    </>}
    {card && <CleanupDialog card={card} onClose={() => { setCard(null); setSelected([]); }} />}
  </section>;
}

function useCleanupActions(card: CleanupCard, onDone?: () => void) {
  const client = useQueryClient();
  const settle = () => { void client.invalidateQueries({ queryKey: ['worktrees'] }); onDone?.(); };
  const confirm = useMutation({ mutationFn: () => api<CleanupCard>(`/api/worktree-cleanups/${card.id}/confirm`, { method: 'POST', body: '{}' }), onSuccess: () => { toast.success('已交给执行端删除'); settle(); }, onError: (error) => { toast.error(error.message); settle(); } });
  const cancel = useMutation({ mutationFn: () => api(`/api/worktree-cleanups/${card.id}/cancel`, { method: 'POST', body: '{}' }), onSuccess: settle, onError: (error) => { toast.error(error.message); settle(); } });
  return { confirm, cancel };
}

function CardBody({ card }: { card: CleanupCard }) {
  return <div className="space-y-2 text-sm">
    <ul className="space-y-1">{card.items.map((item) => <li key={item.path} className="rounded border px-2 py-1 text-xs"><span className={item.action === 'remove' ? 'font-medium text-destructive' : 'font-medium text-muted-foreground'}>{item.action === 'remove' ? '删除' : '保留'}</span> {item.name} <span className="text-muted-foreground">{item.branch ?? ''} · {formatBytes(item.sizeBytes)}</span>{item.reason && <div className="text-amber-600">{item.reason}</div>}{item.warning && <div className="text-muted-foreground">{item.warning}</div>}</li>)}</ul>
    <p className="text-xs text-muted-foreground">执行端「{card.nodeName}」将删除 {card.removableCount} 个 worktree（约 {formatBytes(card.removableBytes)}），{card.deleteBranches ? '并尝试用 git branch -d 删除已合入的分支' : '分支保留'}。只删除干净的 worktree，不使用 --force。卡片 {new Date(card.expiresAt).toLocaleTimeString()} 前有效{card.source === 'assistant' ? '，由 AI 助手发起' : ''}。</p>
  </div>;
}

/** The confirmation card shown right after "删除选中的…". Nothing reaches the node before 确认删除. */
function CleanupDialog({ card, onClose }: { card: CleanupCard; onClose: () => void }) {
  const { confirm, cancel } = useCleanupActions(card, onClose);
  return <Dialog open onOpenChange={(open) => { if (!open) cancel.mutate(); }}>
    <DialogContent className="max-w-[min(40rem,calc(100%-2rem))]" aria-label="确认删除 worktree">
      <DialogHeader><DialogTitle>确认删除 worktree</DialogTitle><DialogDescription>请核对下面的列表。确认后由执行端在本机执行删除。</DialogDescription></DialogHeader>
      <CardBody card={card} />
      <DialogFooter><Button variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>取消</Button><Button variant="destructive" disabled={!card.removableCount || confirm.isPending} onClick={() => confirm.mutate()}>确认删除 {card.removableCount} 个</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** A card created elsewhere (for example by the AI assistant) that still waits for the user's decision. */
export function CleanupCardView({ card }: { card: CleanupCard }) {
  const { confirm, cancel } = useCleanupActions(card);
  if (card.status === 'confirmed') return <p role="status" className="mt-3 rounded bg-muted p-2 text-xs">执行端正在删除 {card.removableCount} 个 worktree…</p>;
  return <div role="group" aria-label="待确认的删除" className="mt-3 rounded border border-amber-500/40 bg-amber-500/5 p-3">
    <div className="mb-2 text-sm font-medium">待确认的删除</div>
    <CardBody card={card} />
    <div className="mt-2 flex gap-2"><Button size="sm" variant="destructive" disabled={!card.removableCount || confirm.isPending} onClick={() => confirm.mutate()}>确认删除</Button><Button size="sm" variant="ghost" onClick={() => cancel.mutate()}>取消</Button></div>
  </div>;
}
