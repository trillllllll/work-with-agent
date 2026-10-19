import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { orchestrationStatusLabels, pauseReasonLabels, stepKindLabels, stepStatusLabels } from './labels.js';

type Step = { id: string; kind: string; subtaskId: string | null; nodeId?: string | null; status: string; attempt: number; continueCount: number; branch: string | null; error: string | null; mergeCommit: string | null; resultCommit: string | null; dependsOn: string[] };
type PlanStep = { taskId: string; dependsOn: string[]; acceptanceCriteria: string; rationale: string };
type Orchestration = { id: string; taskId: string; round: number; status: string; revision: number; integrationBranch: string; integrationHead: string | null; pauseReason: string | null; finalComment: string | null; pushedAt: string | null; pullRequestUrl?: string | null; nodeId?: string | null; nodes?: Array<{ id: string; name: string; online: boolean; primary: boolean; gh: boolean }>; grant: { provider: string; maxParallel: number; allowShell: boolean }; plan: { goalCriteria: string; steps: PlanStep[]; fallback?: string }; taskSnapshot: { subtasks: Array<{ id: string; title: string }> }; steps?: Step[]; locations?: Array<{ id: string; nodeId: string; nodeName: string; online: boolean; path: string; originUrl?: string | null; protocol?: number }>; node?: { name: string; online: boolean } | null; events?: Array<{ seq: number; type: string; actorKind: string; createdAt: string; payload: any }> };
type Project = { id: string; name: string };
const OPEN = ['draft', 'running', 'paused', 'awaiting_acceptance'];

export function OrchestrationButton({ taskId, disabled }: { taskId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const attention = useQuery({ queryKey: ['orchestrations', 'attention'], queryFn: () => api<{ items: Array<{ taskId: string; status: string }> }>('/api/orchestrations/attention'), staleTime: 5_000 });
  const mine = attention.data?.items.find((item) => item.taskId === taskId);
  return <>
    <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setOpen(true)}>{mine ? `编排 · ${orchestrationStatusLabels[mine.status] ?? mine.status}` : '开始运行'}</Button>
    {open && <OrchestrationDialog taskId={taskId} onClose={() => setOpen(false)} />}
  </>;
}

function OrchestrationDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ['orchestrations', taskId], queryFn: () => api<Orchestration[]>(`/api/orchestrations?taskId=${encodeURIComponent(taskId)}`), refetchInterval: 3000 });
  const current = list.data?.find((row) => OPEN.includes(row.status)) ?? list.data?.[0];
  const detail = useQuery({ queryKey: ['orchestration', current?.id], enabled: !!current && current.status !== 'draft', queryFn: () => api<Orchestration>(`/api/orchestrations/${current!.id}`), refetchInterval: 3000 });
  const [draft, setDraft] = useState<Orchestration | null>(null);
  const preview = useMutation({ mutationFn: () => api<Orchestration>('/api/orchestrations/preview', { method: 'POST', body: JSON.stringify({ taskId }) }), onSuccess: (data) => { setDraft(data); void client.invalidateQueries({ queryKey: ['orchestrations'] }); }, onError: (error) => toast.error(error.message) });
  const showDraft = draft;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] max-w-[min(48rem,calc(100%-2rem))] overflow-y-auto">
      <DialogHeader><DialogTitle>主控编排</DialogTitle><DialogDescription>主控只负责派任务、读报告和验收；写代码、合入、跑测试、推送都由你电脑上的本机执行端和本机 AI 完成。</DialogDescription></DialogHeader>
      {showDraft ? <LaunchForm draft={showDraft} taskId={taskId} onStarted={() => { setDraft(null); void client.invalidateQueries({ queryKey: ['orchestrations'] }); }} />
        : current && current.status !== 'draft' ? <Progress row={detail.data ?? current} onRedispatch={(next) => setDraft(next)} />
          : <div className="space-y-3">
            <ProjectOverride taskId={taskId} />
            <Button disabled={preview.isPending} onClick={() => preview.mutate()}>{preview.isPending ? '主控正在生成计划…' : current?.status === 'draft' ? '重新生成计划' : '生成执行计划'}</Button>
          </div>}
    </DialogContent>
  </Dialog>;
}

function ProjectOverride({ taskId }: { taskId: string }) {
  const client = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') });
  const binding = useQuery({ queryKey: ['project-binding', 'task', taskId], queryFn: () => api<{ projectId: string | null }>(`/api/project-bindings/task/${taskId}`) });
  const save = useMutation({ mutationFn: (projectId: string | null) => api(`/api/project-bindings/task/${taskId}`, { method: 'PUT', body: JSON.stringify({ projectId }) }), onSuccess: () => void client.invalidateQueries({ queryKey: ['project-binding'] }), onError: (error) => toast.error(error.message) });
  return <label className="flex items-center gap-2 text-sm"><span className="text-muted-foreground">项目</span>
    <select className="rounded border bg-background px-2 py-1" value={binding.data?.projectId ?? ''} onChange={(event) => save.mutate(event.target.value || null)}>
      <option value="">跟随清单默认项目</option>
      {projects.data?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select>
    <span className="text-xs text-muted-foreground">项目和执行端在「设置 → 主控编排」里管理</span>
  </label>;
}

function LaunchForm({ draft, taskId, onStarted }: { draft: Orchestration; taskId: string; onStarted: () => void }) {
  const titles = useMemo(() => new Map(draft.taskSnapshot.subtasks.map((task) => [task.id, task.title])), [draft]);
  const [locationId, setLocationId] = useState(draft.locations?.[0]?.id ?? '');
  const [provider, setProvider] = useState(draft.grant.provider);
  const [maxParallel, setMaxParallel] = useState(draft.grant.maxParallel);
  const [allowShell, setAllowShell] = useState(draft.grant.allowShell);
  const [extra, setExtra] = useState<string[]>([]);
  const primary = draft.locations?.find((location) => location.id === locationId);
  const others = (draft.locations ?? []).filter((location) => location.id !== locationId);
  const extraIds = extra.filter((id) => others.some((location) => location.id === id));
  const start = useMutation({ mutationFn: () => api(`/api/orchestrations/${draft.id}/start`, { method: 'POST', body: JSON.stringify({ expectedRevision: draft.revision, locationId, extraLocationIds: extraIds, provider, maxParallel, allowShell }) }), onSuccess: () => { toast.success('已开始运行'); onStarted(); }, onError: (error) => toast.error(error.message) });
  void taskId;
  return <div className="space-y-4 text-sm">
    {draft.plan.fallback && <p role="status" className="rounded bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">{draft.plan.fallback}</p>}
    <section><h3 className="font-medium">执行计划</h3><p className="text-muted-foreground">目标：{draft.plan.goalCriteria}</p>
      <ol className="mt-2 space-y-2">{draft.plan.steps.map((step) => <li key={step.taskId} className="rounded border p-2"><div className="font-medium">{titles.get(step.taskId) ?? step.taskId}</div>
        <div className="text-xs text-muted-foreground">{step.dependsOn.length ? `等待：${step.dependsOn.map((id) => titles.get(id) ?? id).join('、')} 合入后开始` : '可并行'}{step.rationale ? ` · ${step.rationale}` : ''}</div>
        {step.acceptanceCriteria && <div className="mt-1 text-xs">验收标准：{step.acceptanceCriteria}</div>}</li>)}</ol>
    </section>
    <section className="space-y-2"><h3 className="font-medium">一次性授权</h3>
      <label className="flex items-center gap-2"><span className="w-24 text-muted-foreground">执行位置</span><select className="flex-1 rounded border bg-background px-2 py-1" value={locationId} onChange={(event) => setLocationId(event.target.value)}>
        {!draft.locations?.length && <option value="">（没有已验证的位置，先在设置里给项目添加位置）</option>}
        {draft.locations?.map((location) => <option key={location.id} value={location.id}>{location.nodeName}{location.online ? '' : '（离线）'} · {location.path}</option>)}</select></label>
      {others.length > 0 && <fieldset className="space-y-1"><legend className="text-muted-foreground">跨机并行（可选）</legend>
        {others.map((location) => { const usable = (location.protocol ?? 0) >= 2 && !!location.originUrl && !!primary?.originUrl; return <label key={location.id} className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={!usable} checked={extraIds.includes(location.id)} onChange={(event) => setExtra(event.target.checked ? [...extraIds, location.id] : extraIds.filter((id) => id !== location.id))} /><span>{location.nodeName}{location.online ? '' : '（离线）'} · {location.path}</span>{!usable && <span className="text-muted-foreground">（{(location.protocol ?? 0) < 2 ? '执行端版本太旧' : '仓库没有 origin 远端'}）</span>}</label>; })}
        <p className="text-xs text-muted-foreground">勾选后，子任务也会派给这些机器。集成分支和子任务分支会推送到 origin 中转（不强推），合入、核对仍在上面选的执行位置完成。</p>
      </fieldset>}
      <label className="flex items-center gap-2"><span className="w-24 text-muted-foreground">本机 AI</span><select className="rounded border bg-background px-2 py-1" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      <label className="flex items-center gap-2"><span className="w-24 text-muted-foreground">最大并行</span><input type="number" min={1} max={4} className="w-20 rounded border bg-background px-2 py-1" value={maxParallel} onChange={(event) => setMaxParallel(Math.max(1, Math.min(4, Number(event.target.value) || 1)))} /></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={allowShell} onChange={(event) => setAllowShell(event.target.checked)} /><span>允许本机 AI 运行测试命令</span></label>
      <p className="text-xs text-muted-foreground">开发和合入需要本机 AI 提交 git，因此始终授予工作区写权限和 git 写权限。集成分支：{draft.integrationBranch}。主仓库里未提交的修改不会带进 worktree。确认后整轮不再逐步询问。</p>
    </section>
    <Button disabled={!locationId || start.isPending} onClick={() => start.mutate()}>{start.isPending ? '正在开始…' : '确认并开始运行'}</Button>
  </div>;
}

function Progress({ row, onRedispatch }: { row: Orchestration; onRedispatch: (draft: Orchestration) => void }) {
  const client = useQueryClient();
  const titles = new Map(row.taskSnapshot.subtasks.map((task) => [task.id, task.title]));
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body?: unknown }) => api<any>(`/api/orchestrations/${row.id}/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) }), onSuccess: (data, variables) => { void client.invalidateQueries({ queryKey: ['orchestrations'] }); void client.invalidateQueries({ queryKey: ['orchestration'] }); if (variables.path === 'redispatch') onRedispatch(data); }, onError: (error) => toast.error(error.message) });
  const steps = (row.steps ?? []).filter((step) => !['push', 'publish', 'pull_request'].includes(step.kind) || step.status !== 'succeeded');
  const nodeNames = new Map((row.nodes ?? []).map((node) => [node.id, node.name]));
  const multi = (row.nodes ?? []).length > 1;
  const primaryNode = (row.nodes ?? []).find((node) => node.primary);
  const events = (row.events ?? []).slice(-15).reverse();
  return <div className="space-y-4 text-sm">
    <div className="flex flex-wrap items-center gap-2"><span className="rounded bg-muted px-2 py-0.5 font-medium">{orchestrationStatusLabels[row.status] ?? row.status}</span><span>第 {row.round} 轮</span><code className="text-xs">{row.integrationBranch}</code>{row.integrationHead && <code className="text-xs">{row.integrationHead.slice(0, 10)}</code>}{multi ? <span className="text-xs text-muted-foreground">执行端：{(row.nodes ?? []).map((node) => `${node.name}${node.primary ? '（主）' : ''}${node.online ? '' : '（离线）'}`).join('、')}</span> : row.node && <span className="text-xs text-muted-foreground">执行端：{row.node.name}{row.node.online ? '（在线）' : '（离线）'}</span>}</div>
    {row.pullRequestUrl && <p className="text-xs">PR：<a className="underline" href={row.pullRequestUrl} target="_blank" rel="noreferrer">{row.pullRequestUrl}</a></p>}
    {row.pauseReason && <p role="alert" className="rounded bg-amber-500/10 p-2">{pauseReasonLabels[row.pauseReason] ?? row.pauseReason}</p>}
    {row.finalComment && <p className="rounded bg-muted p-2">主控意见：{row.finalComment}</p>}
    <ul className="space-y-1">{steps.map((step) => <li key={step.id} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1">
      <span className="w-16 text-muted-foreground">{stepKindLabels[step.kind] ?? step.kind}</span>
      <span className="min-w-0 flex-1 truncate">{step.subtaskId ? titles.get(step.subtaskId) ?? step.subtaskId : ''}{step.attempt > 1 ? ` · 第 ${step.attempt} 次` : ''}{step.continueCount ? ` · 继续 ${step.continueCount}` : ''}</span>
      {multi && step.kind === 'develop' && step.nodeId && <span className="text-xs text-muted-foreground">@{nodeNames.get(step.nodeId) ?? step.nodeId}</span>}
      <span className={step.status === 'needs_user' ? 'text-amber-600' : 'text-muted-foreground'}>{stepStatusLabels[step.status] ?? step.status}</span>
      {step.status === 'needs_user' && step.kind === 'publish' && <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `steps/${step.id}/retry`, body: { mode: 'fresh' } })}>重新推送</Button>}
      {step.status === 'needs_user' && ['develop', 'merge', 'setup'].includes(step.kind) && <>
        {step.kind === 'develop' && <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `steps/${step.id}/retry`, body: { mode: 'continue', comment: step.error ?? undefined } })}>带意见继续</Button>}
        {step.kind === 'merge' && step.mergeCommit && <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `steps/${step.id}/retry`, body: { mode: 'reverify' } })}>重新核对</Button>}
        <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `steps/${step.id}/retry`, body: { mode: 'fresh' } })}>重派</Button>
        {step.kind !== 'setup' && <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `steps/${step.id}/skip`, body: { reason: '用户跳过' } })}>跳过</Button>}
      </>}
      {step.error && <div className="w-full text-xs text-muted-foreground">{step.error}</div>}
    </li>)}</ul>
    <div className="flex flex-wrap gap-2">
      {row.status === 'running' && <Button size="sm" variant="outline" onClick={() => act.mutate({ path: 'pause' })}>暂停</Button>}
      {row.status === 'paused' && <Button size="sm" variant="outline" onClick={() => act.mutate({ path: 'resume' })}>继续</Button>}
      {row.status === 'awaiting_acceptance' && <Button size="sm" onClick={() => act.mutate({ path: 'accept' })}>验收通过</Button>}
      {['accepted', 'awaiting_acceptance'].includes(row.status) && <Button size="sm" variant="outline" onClick={() => act.mutate({ path: 'push' })}>{row.pushedAt ? '再次推送集成分支' : '推送集成分支'}</Button>}
      {['accepted', 'awaiting_acceptance'].includes(row.status) && row.pushedAt && !row.pullRequestUrl && primaryNode?.gh && <Button size="sm" variant="outline" disabled={steps.some((step) => step.kind === 'pull_request' && step.status === 'dispatched')} onClick={() => act.mutate({ path: 'pull-request' })}>创建 PR</Button>}
      {['running', 'paused', 'awaiting_acceptance', 'accepted', 'cancelled'].includes(row.status) && <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: 'redispatch' })}>改完任务后重新派发</Button>}
      {['running', 'paused', 'awaiting_acceptance'].includes(row.status) && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => act.mutate({ path: 'cancel' })}>取消</Button>}
    </div>
    {events.length > 0 && <details><summary className="cursor-pointer text-muted-foreground">主控决策与执行端报告（最近 {events.length} 条）</summary>
      <ul className="mt-2 space-y-1 text-xs">{events.map((event) => <li key={event.seq}><span className="text-muted-foreground">{new Date(event.createdAt).toLocaleTimeString()} · {event.actorKind} · {event.type}</span> {summarize(event.payload)}</li>)}</ul></details>}
  </div>;
}

function summarize(payload: any) {
  if (!payload || typeof payload !== 'object') return '';
  if (Array.isArray(payload.problems) && payload.problems.length) return `问题：${payload.problems.join('；')}`;
  if (payload.ok === true) return '比对通过';
  if (payload.value?.decision) return `${payload.value.decision}：${payload.value.comment ?? ''}`;
  if (payload.message) return payload.message;
  if (payload.reason) return payload.reason;
  return '';
}
