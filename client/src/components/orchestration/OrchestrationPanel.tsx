import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { intlLocale, t as translate } from '@/i18n/index.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { orchestrationStatusLabels, pauseReasonLabels, stepKindLabels, stepStatusLabels } from './labels.js';
import { formatCost, formatDiff, formatDuration, formatMissing, formatTokens, jobDurationMs, readJobChecks } from './format.js';

type Step = { id: string; kind: string; subtaskId: string | null; nodeId?: string | null; status: string; attempt: number; continueCount: number; branch: string | null; error: string | null; mergeCommit: string | null; resultCommit: string | null; dependsOn: string[] };
type OrchestrationJob = { id: string; stepId: string | null; kind: string; phase: string; createdAt: string; startedAt: string | null; endedAt: string | null; model: string | null; inputTokens: number | null; outputTokens: number | null; costMicroUsd: number | null; filesChanged: number | null; linesAdded: number | null; linesDeleted: number | null; result?: unknown };
type PlanStep = { taskId: string; dependsOn: string[]; acceptanceCriteria: string; rationale: string };
type Orchestration = { id: string; taskId: string; round: number; status: string; revision: number; integrationBranch: string; integrationHead: string | null; pauseReason: string | null; finalComment: string | null; pushedAt: string | null; pullRequestUrl?: string | null; nodeId?: string | null; nodes?: Array<{ id: string; name: string; online: boolean; primary: boolean; gh: boolean }>; grant: { provider: string; maxParallel: number; allowShell: boolean }; plan: { goalCriteria: string; steps: PlanStep[]; fallback?: string }; taskSnapshot: { subtasks: Array<{ id: string; title: string }> }; steps?: Step[]; jobs?: OrchestrationJob[]; locations?: Array<{ id: string; nodeId: string; nodeName: string; online: boolean; path: string; originUrl?: string | null; protocol?: number }>; node?: { name: string; online: boolean } | null; events?: Array<{ seq: number; type: string; actorKind: string; createdAt: string; payload: any }> };
type Project = { id: string; name: string };
const OPEN = ['draft', 'running', 'paused', 'awaiting_acceptance'];

export function OrchestrationButton({ taskId, disabled }: { taskId: string; disabled?: boolean }) {
  const { t } = useTranslation('orchestration');
  const [open, setOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const attention = useQuery({ queryKey: ['orchestrations', 'attention'], queryFn: () => api<{ items: Array<{ taskId: string; status: string }> }>('/api/orchestrations/attention'), staleTime: 5_000 });
  const mine = attention.data?.items.find((item) => item.taskId === taskId);
  useEffect(() => {
    const raw = sessionStorage.getItem('wwa-open-orchestration');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { taskId?: string; orchestrationId?: string };
      if (parsed.taskId !== taskId) return;
      sessionStorage.removeItem('wwa-open-orchestration');
      setFocusId(parsed.orchestrationId ?? null);
      setOpen(true);
    } catch { sessionStorage.removeItem('wwa-open-orchestration'); }
  }, [taskId]);
  return <>
    <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setOpen(true)}>{mine ? t('panel.buttonMine', { status: orchestrationStatusLabels[mine.status] ?? mine.status }) : t('panel.buttonStart')}</Button>
    {open && <OrchestrationDialog taskId={taskId} focusId={focusId} onClose={() => setOpen(false)} />}
  </>;
}

function OrchestrationDialog({ taskId, focusId, onClose }: { taskId: string; focusId?: string | null; onClose: () => void }) {
  const { t } = useTranslation('orchestration');
  const client = useQueryClient();
  const list = useQuery({ queryKey: ['orchestrations', taskId], queryFn: () => api<Orchestration[]>(`/api/orchestrations?taskId=${encodeURIComponent(taskId)}`), refetchInterval: 3000 });
  const current = (focusId && list.data?.find((row) => row.id === focusId)) || list.data?.find((row) => OPEN.includes(row.status)) || list.data?.[0];
  const detail = useQuery({ queryKey: ['orchestration', current?.id], enabled: !!current && current.status !== 'draft', queryFn: () => api<Orchestration>(`/api/orchestrations/${current!.id}`), refetchInterval: 3000 });
  const [draft, setDraft] = useState<Orchestration | null>(null);
  const preview = useMutation({ mutationFn: () => api<Orchestration>('/api/orchestrations/preview', { method: 'POST', body: JSON.stringify({ taskId }) }), onSuccess: (data) => { setDraft(data); void client.invalidateQueries({ queryKey: ['orchestrations'] }); }, onError: (error) => toast.error(error.message) });
  const showDraft = draft;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] max-w-[min(48rem,calc(100%-2rem))] overflow-y-auto">
      <DialogHeader><DialogTitle>{t('panel.title')}</DialogTitle><DialogDescription>{t('panel.description')}</DialogDescription></DialogHeader>
      {showDraft ? <LaunchForm draft={showDraft} taskId={taskId} onStarted={() => { setDraft(null); void client.invalidateQueries({ queryKey: ['orchestrations'] }); }} />
        : current && current.status !== 'draft' ? <Progress row={detail.data ?? current} onRedispatch={(next) => setDraft(next)} />
          : <div className="space-y-3">
            <ProjectOverride taskId={taskId} />
            <Button disabled={preview.isPending} onClick={() => preview.mutate()}>{preview.isPending ? t('panel.generating') : current?.status === 'draft' ? t('panel.regenerate') : t('panel.generate')}</Button>
          </div>}
    </DialogContent>
  </Dialog>;
}

function ProjectOverride({ taskId }: { taskId: string }) {
  const { t } = useTranslation('orchestration');
  const client = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') });
  const binding = useQuery({ queryKey: ['project-binding', 'task', taskId], queryFn: () => api<{ projectId: string | null }>(`/api/project-bindings/task/${taskId}`) });
  const save = useMutation({ mutationFn: (projectId: string | null) => api(`/api/project-bindings/task/${taskId}`, { method: 'PUT', body: JSON.stringify({ projectId }) }), onSuccess: () => void client.invalidateQueries({ queryKey: ['project-binding'] }), onError: (error) => toast.error(error.message) });
  return <label className="flex items-center gap-2 text-sm"><span className="text-muted-foreground">{t('panel.project')}</span>
    <select className="rounded border bg-background px-2 py-1" value={binding.data?.projectId ?? ''} onChange={(event) => save.mutate(event.target.value || null)}>
      <option value="">{t('panel.followTopic')}</option>
      {projects.data?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select>
    <span className="text-xs text-muted-foreground">{t('panel.manageHint')}</span>
  </label>;
}

function LaunchForm({ draft, taskId, onStarted }: { draft: Orchestration; taskId: string; onStarted: () => void }) {
  const { t } = useTranslation('orchestration');
  const titles = useMemo(() => new Map(draft.taskSnapshot.subtasks.map((task) => [task.id, task.title])), [draft]);
  const [locationId, setLocationId] = useState(draft.locations?.[0]?.id ?? '');
  const [provider, setProvider] = useState(draft.grant.provider);
  const [maxParallel, setMaxParallel] = useState(draft.grant.maxParallel);
  const [allowShell, setAllowShell] = useState(draft.grant.allowShell);
  const [extra, setExtra] = useState<string[]>([]);
  const primary = draft.locations?.find((location) => location.id === locationId);
  const others = (draft.locations ?? []).filter((location) => location.id !== locationId);
  const extraIds = extra.filter((id) => others.some((location) => location.id === id));
  const start = useMutation({ mutationFn: () => api(`/api/orchestrations/${draft.id}/start`, { method: 'POST', body: JSON.stringify({ expectedRevision: draft.revision, locationId, extraLocationIds: extraIds, provider, maxParallel, allowShell }) }), onSuccess: () => { toast.success(t('panel.started')); onStarted(); }, onError: (error) => toast.error(error.message) });
  void taskId;
  return <div className="space-y-4 text-sm">
    {draft.plan.fallback && <p role="status" className="rounded bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">{draft.plan.fallback}</p>}
    <section><h3 className="font-medium">{t('panel.planTitle')}</h3><p className="text-muted-foreground">{t('panel.goal', { criteria: draft.plan.goalCriteria })}</p>
      <ol className="mt-2 space-y-2">{draft.plan.steps.map((step) => <li key={step.taskId} className="rounded border p-2"><div className="font-medium">{titles.get(step.taskId) ?? step.taskId}</div>
        <div className="text-xs text-muted-foreground">{step.dependsOn.length ? t('panel.waitFor', { names: step.dependsOn.map((id) => titles.get(id) ?? id).join(t('panel.sep')) }) : t('panel.parallel')}{step.rationale ? t('panel.rationale', { rationale: step.rationale }) : ''}</div>
        {step.acceptanceCriteria && <div className="mt-1 text-xs">{t('panel.acceptance', { criteria: step.acceptanceCriteria })}</div>}</li>)}</ol>
    </section>
    <section className="space-y-2"><h3 className="font-medium">{t('panel.grantTitle')}</h3>
      <label className="flex items-center gap-2"><span className="w-24 text-muted-foreground">{t('panel.location')}</span><select className="flex-1 rounded border bg-background px-2 py-1" value={locationId} onChange={(event) => setLocationId(event.target.value)}>
        {!draft.locations?.length && <option value="">{t('panel.noLocation')}</option>}
        {draft.locations?.map((location) => <option key={location.id} value={location.id}>{location.nodeName}{location.online ? '' : t('panel.offlineMark')} · {location.path}</option>)}</select></label>
      {others.length > 0 && <fieldset className="space-y-1"><legend className="text-muted-foreground">{t('panel.crossMachine')}</legend>
        {others.map((location) => { const usable = (location.protocol ?? 0) >= 2 && !!location.originUrl && !!primary?.originUrl; return <label key={location.id} className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={!usable} checked={extraIds.includes(location.id)} onChange={(event) => setExtra(event.target.checked ? [...extraIds, location.id] : extraIds.filter((id) => id !== location.id))} /><span>{location.nodeName}{location.online ? '' : t('panel.offlineMark')} · {location.path}</span>{!usable && <span className="text-muted-foreground">{(location.protocol ?? 0) < 2 ? t('panel.nodeOutdated') : t('panel.noOrigin')}</span>}</label>; })}
        <p className="text-xs text-muted-foreground">{t('panel.crossHint')}</p>
      </fieldset>}
      <label className="flex items-center gap-2"><span className="w-24 text-muted-foreground">{t('panel.localAi')}</span><select className="rounded border bg-background px-2 py-1" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      <label className="flex items-center gap-2"><span className="w-24 text-muted-foreground">{t('panel.maxParallel')}</span><input type="number" min={1} max={4} className="w-20 rounded border bg-background px-2 py-1" value={maxParallel} onChange={(event) => setMaxParallel(Math.max(1, Math.min(4, Number(event.target.value) || 1)))} /></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={allowShell} onChange={(event) => setAllowShell(event.target.checked)} /><span>{t('panel.allowShell')}</span></label>
      <p className="text-xs text-muted-foreground">{t('panel.grantHint', { branch: draft.integrationBranch })}</p>
    </section>
    <Button disabled={!locationId || start.isPending} onClick={() => start.mutate()}>{start.isPending ? t('panel.starting') : t('panel.confirmStart')}</Button>
  </div>;
}

function Progress({ row, onRedispatch }: { row: Orchestration; onRedispatch: (draft: Orchestration) => void }) {
  const { t } = useTranslation('orchestration');
  const client = useQueryClient();
  const titles = new Map(row.taskSnapshot.subtasks.map((task) => [task.id, task.title]));
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body?: unknown }) => api<any>(`/api/orchestrations/${row.id}/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) }), onSuccess: (data, variables) => { void client.invalidateQueries({ queryKey: ['orchestrations'] }); void client.invalidateQueries({ queryKey: ['orchestration'] }); if (variables.path === 'redispatch') onRedispatch(data); }, onError: (error) => toast.error(error.message) });
  const steps = (row.steps ?? []).filter((step) => !['push', 'publish', 'pull_request'].includes(step.kind) || step.status !== 'succeeded');
  const nodeNames = new Map((row.nodes ?? []).map((node) => [node.id, node.name]));
  const multi = (row.nodes ?? []).length > 1;
  const primaryNode = (row.nodes ?? []).find((node) => node.primary);
  const events = (row.events ?? []).slice(-15).reverse();
  const nodeList = (row.nodes ?? []).map((node) => `${node.name}${node.primary ? t('panel.primaryMark') : ''}${node.online ? '' : t('panel.offlineMark')}`).join(t('panel.sep'));
  return <div className="space-y-4 text-sm">
    <div className="flex flex-wrap items-center gap-2"><span className="rounded bg-muted px-2 py-0.5 font-medium">{orchestrationStatusLabels[row.status] ?? row.status}</span><span>{t('panel.round', { round: row.round })}</span><code className="text-xs">{row.integrationBranch}</code>{row.integrationHead && <code className="text-xs">{row.integrationHead.slice(0, 10)}</code>}{multi ? <span className="text-xs text-muted-foreground">{t('panel.nodes', { list: nodeList })}</span> : row.node && <span className="text-xs text-muted-foreground">{t('panel.nodeOne', { name: row.node.name, state: row.node.online ? t('panel.onlineMark') : t('panel.offlineMark') })}</span>}</div>
    {row.pullRequestUrl && <p className="text-xs">{t('panel.pr')}<a className="underline" href={row.pullRequestUrl} target="_blank" rel="noreferrer">{row.pullRequestUrl}</a></p>}
    {row.pauseReason && <p role="alert" className="rounded bg-amber-500/10 p-2">{pauseReasonLabels[row.pauseReason] ?? row.pauseReason}</p>}
    {row.finalComment && <p className="rounded bg-muted p-2">{t('panel.finalComment', { comment: row.finalComment })}</p>}
    <ul className="space-y-1">{steps.map((step) => <li key={step.id} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1">
      <span className="w-16 text-muted-foreground">{stepKindLabels[step.kind] ?? step.kind}</span>
      <span className="min-w-0 flex-1 truncate">{step.subtaskId ? titles.get(step.subtaskId) ?? step.subtaskId : ''}{step.attempt > 1 ? t('panel.attempt', { count: step.attempt }) : ''}{step.continueCount ? t('panel.continued', { count: step.continueCount }) : ''}</span>
      {multi && step.kind === 'develop' && step.nodeId && <span className="text-xs text-muted-foreground">@{nodeNames.get(step.nodeId) ?? step.nodeId}</span>}
      <span className={step.status === 'needs_user' ? 'text-amber-600' : 'text-muted-foreground'}>{stepStatusLabels[step.status] ?? step.status}</span>
      {step.status === 'needs_user' && step.kind === 'publish' && <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `steps/${step.id}/retry`, body: { mode: 'fresh' } })}>{t('panel.republish')}</Button>}
      {step.status === 'needs_user' && ['develop', 'merge', 'setup'].includes(step.kind) && <>
        {step.kind === 'develop' && <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `steps/${step.id}/retry`, body: { mode: 'continue', comment: step.error ?? undefined } })}>{t('panel.continueWithFeedback')}</Button>}
        {step.kind === 'merge' && step.mergeCommit && <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `steps/${step.id}/retry`, body: { mode: 'reverify' } })}>{t('panel.reverify')}</Button>}
        <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `steps/${step.id}/retry`, body: { mode: 'fresh' } })}>{t('panel.retryFresh')}</Button>
        {step.kind !== 'setup' && <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `steps/${step.id}/skip`, body: { reason: t('panel.skipReason') } })}>{t('panel.skip')}</Button>}
      </>}
      {step.error && <div className="w-full text-xs text-muted-foreground">{step.error}</div>}
      <StepUsage step={step} jobs={row.jobs} />
    </li>)}</ul>
    <div className="flex flex-wrap gap-2">
      {row.status === 'running' && <Button size="sm" variant="outline" onClick={() => act.mutate({ path: 'pause' })}>{t('panel.pause')}</Button>}
      {row.status === 'paused' && <Button size="sm" variant="outline" onClick={() => act.mutate({ path: 'resume' })}>{t('panel.resume')}</Button>}
      {row.status === 'awaiting_acceptance' && <Button size="sm" onClick={() => act.mutate({ path: 'accept' })}>{t('panel.accept')}</Button>}
      {['accepted', 'awaiting_acceptance'].includes(row.status) && <Button size="sm" variant="outline" onClick={() => act.mutate({ path: 'push' })}>{row.pushedAt ? t('panel.pushAgain') : t('panel.push')}</Button>}
      {['accepted', 'awaiting_acceptance'].includes(row.status) && row.pushedAt && !row.pullRequestUrl && primaryNode?.gh && <Button size="sm" variant="outline" disabled={steps.some((step) => step.kind === 'pull_request' && step.status === 'dispatched')} onClick={() => act.mutate({ path: 'pull-request' })}>{t('panel.createPr')}</Button>}
      {['running', 'paused', 'awaiting_acceptance', 'accepted', 'cancelled'].includes(row.status) && <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: 'redispatch' })}>{t('panel.redispatch')}</Button>}
      {['running', 'paused', 'awaiting_acceptance'].includes(row.status) && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => act.mutate({ path: 'cancel' })}>{t('panel.cancel')}</Button>}
    </div>
    {events.length > 0 && <details><summary className="cursor-pointer text-muted-foreground">{t('panel.events', { count: events.length })}</summary>
      <ul className="mt-2 space-y-1 text-xs">{events.map((event) => <li key={event.seq}><span className="text-muted-foreground">{new Date(event.createdAt).toLocaleTimeString(intlLocale())} · {event.actorKind} · {event.type}</span> {summarize(event.payload)}</li>)}</ul></details>}
  </div>;
}

function latestRun(jobs: OrchestrationJob[] | undefined, stepId: string, phase: 'work' | 'verify') {
  const matches = (jobs ?? []).filter((job) => job.stepId === stepId && job.kind === 'run' && (phase === 'verify' ? job.phase === 'verify' : job.phase !== 'verify'));
  const ordered = matches.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return ordered.length ? ordered[ordered.length - 1] : null;
}
function StepFacts({ job, step, prefix }: { job: OrchestrationJob; step: Step; prefix?: string }) {
  const { t } = useTranslation('orchestration');
  const checks = readJobChecks(job);
  const passed = checks.filter((item) => item.passed).length;
  const shas = [step.resultCommit, step.mergeCommit].filter((sha): sha is string => !!sha).map((sha) => sha.slice(0, 7));
  const parts = [prefix, formatDuration(jobDurationMs(job.startedAt, job.endedAt)), job.model || formatMissing(), t('history.tokens', { input: formatTokens(job.inputTokens), output: formatTokens(job.outputTokens) }), formatCost(job.costMicroUsd), shas.join('/') || formatMissing(), formatDiff(job.filesChanged, job.linesAdded, job.linesDeleted), checks.length ? t('history.checks', { passed, total: checks.length }) : formatMissing()].filter((part): part is string => !!part);
  return <div className="w-full text-xs text-muted-foreground">{parts.join(' · ')}</div>;
}
function StepUsage({ step, jobs }: { step: Step; jobs?: OrchestrationJob[] }) {
  const { t } = useTranslation('orchestration');
  const work = latestRun(jobs, step.id, 'work');
  const verify = latestRun(jobs, step.id, 'verify');
  if (!work && !verify) return null;
  return <>
    {work && <StepFacts job={work} step={step} />}
    {verify && <StepFacts job={verify} step={step} prefix={t('stepPhase.verify')} />}
  </>;
}
function summarize(payload: any) {
  if (!payload || typeof payload !== 'object') return '';
  if (Array.isArray(payload.problems) && payload.problems.length) return translate('orchestration:panel.problems', { problems: payload.problems.join(translate('orchestration:panel.problemSep')) });
  if (payload.ok === true) return translate('orchestration:panel.checksPassed');
  if (payload.value?.decision) return translate('orchestration:panel.decision', { decision: payload.value.decision, comment: payload.value.comment ?? '' });
  if (payload.message) return payload.message;
  if (payload.reason) return payload.reason;
  return '';
}
