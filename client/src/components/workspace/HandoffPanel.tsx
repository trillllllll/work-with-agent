import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, type Task } from '@/lib/api.js';
import { json, parseStored, usePlatformAction } from '@/lib/platform.js';
import { intlLocale } from '../../i18n/index.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { MarkdownView } from '@/components/chat/MarkdownView.js';
import { ContextPicker, type Evidence } from './ContextPicker.js';
import { downloadFileName, isMarkdownFile } from './artifact-name.js';
import { reviewPreview } from './review-text.js';
import { useHashRoute } from '@/hooks/useHashRoute.js';
import { OrchestrationRunsList } from '@/components/orchestration/OrchestrationRunsList.js';
import { DispatchStatsView } from '@/components/orchestration/DispatchStatsView.js';

const acceptancePrefix = '\n\n验收标准与产物：\n'; // i18n-ignore
const handoffStatusKeys: Record<string, string> = {
  prepared: 'handoff.status.prepared',
  created: 'handoff.status.created',
  accepted: 'handoff.status.accepted',
  running: 'handoff.status.running',
  returned: 'handoff.status.returned',
  failed: 'handoff.status.failed',
  cancelled: 'handoff.status.cancelled',
  unknown: 'handoff.status.unknown',
  accepted_result: 'handoff.status.acceptedResult',
  reviewed: 'handoff.status.reviewed',
  needs_input: 'handoff.status.needsInput',
  waiting_input: 'handoff.status.waitingInput',
  rejected: 'handoff.status.rejected',
};
export function HandoffPanel({ task, disabled = false }: { task: Task; disabled?: boolean }) {
  const { t } = useTranslation('workspace');
  const list = useQuery({ queryKey: ['handoffs', task.id], queryFn: () => api<any[]>(`/api/v1/handoffs?taskId=${encodeURIComponent(task.id)}`) });
  const [provider, setProvider] = useState('codex');
  const [mode, setMode] = useState('manual');
  const [instruction, setInstruction] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [sources, setSources] = useState<Evidence[]>([]);
  const [write, setWrite] = useState(false);
  const [allowShell, setShell] = useState(false);
  const { run, busy } = usePlatformAction();
  return <section className="space-y-3"><h2 className="text-sm font-semibold">{t('handoff.title')}</h2><p className="text-xs text-muted-foreground">{t('handoff.description')}</p>{disabled && <p className="text-xs text-muted-foreground">{t('handoff.saveFirst')}</p>}
    <fieldset className="space-y-3" disabled={disabled || busy}>
      <div className="flex flex-wrap gap-2"><select className="glass-control h-9 rounded-lg px-3 text-sm" aria-label={t('handoff.hostAria')} value={provider} onChange={(event) => setProvider(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude Code</option></select><select className="glass-control h-9 rounded-lg px-3 text-sm" aria-label={t('handoff.modeAria')} value={mode} onChange={(event) => setMode(event.target.value)}><option value="manual">{t('handoff.modeManual')}</option><option value="local">{t('handoff.modeLocal')}</option></select></div>
      <Textarea aria-label={t('handoff.goalAria')} placeholder={t('handoff.goalPlaceholder')} value={instruction} onChange={(event) => setInstruction(event.target.value)} />
      <Input aria-label={t('handoff.acceptanceAria')} placeholder={t('handoff.acceptancePlaceholder')} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} />
      <ContextPicker topicId={task.topicId ?? null} selected={sources} onChange={setSources} memories />
      {mode === 'local' && <div className="space-y-2 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} />{t('handoff.allowWrite')}</label><label className="flex items-center gap-2"><input type="checkbox" checked={allowShell} onChange={(event) => setShell(event.target.checked)} />{t('handoff.allowShell')}</label></div>}
      <Button size="sm" disabled={!instruction.trim()} onClick={() => void run(async () => { const result = await api('/api/v1/handoffs', { method: 'POST', body: json({ taskId: task.id, expectedTaskRevision: task.revision, instruction: `${instruction}${acceptance ? `${acceptancePrefix}${acceptance}` : ''}`, provider, mode, materialIds: sources.filter((ref) => ref.type === 'material').map((ref) => ref.id), memoryIds: sources.filter((ref) => ref.type === 'memory').map((ref) => ref.id), permissions: { profile: write ? 'workspace_write' : 'read_only', allowShell } }) }); setInstruction(''); setAcceptance(''); return result; }, t('handoff.frozenToast'))}>{t('handoff.prepare')}</Button>
    </fieldset>
    {list.error && <p role="alert" className="text-sm text-destructive">{list.error.message}</p>}
    {(list.data ?? []).map((handoff) => <HandoffCard key={handoff.id} handoff={handoff} task={task} />)}
  </section>;
}
export function RunsPage() {
  const { t } = useTranslation('workspace');
  const { query, setQuery } = useHashRoute();
  const tab = query.tab === 'handoffs' ? 'handoffs' : query.tab === 'stats' ? 'stats' : 'orchestrations';
  const tabClass = (selected: boolean) => `shrink-0 rounded-full px-3 py-1 text-sm ${selected ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`;
  return <section className="mx-auto max-w-5xl space-y-5 p-5 sm:p-7">
    <h1 className="text-2xl font-semibold">{t('handoff.runsTitle')}</h1>
    <p className="text-sm text-muted-foreground">{t('handoff.runsDescription')}</p>
    <div role="tablist" className="flex gap-2 overflow-x-auto">
      <button type="button" role="tab" aria-selected={tab === 'orchestrations'} data-testid="runs-tab-orchestrations" className={tabClass(tab === 'orchestrations')} onClick={() => setQuery({ tab: 'orchestrations' })}>{t('runs.tabOrchestrations')}</button>
      <button type="button" role="tab" aria-selected={tab === 'handoffs'} data-testid="runs-tab-handoffs" className={tabClass(tab === 'handoffs')} onClick={() => setQuery({ tab: 'handoffs' })}>{t('runs.tabHandoffs')}</button>
      <button type="button" role="tab" aria-selected={tab === 'stats'} data-testid="runs-tab-stats" className={tabClass(tab === 'stats')} onClick={() => setQuery({ tab: 'stats' })}>{t('runs.tabStats')}</button>
    </div>
    {tab === 'orchestrations' ? <OrchestrationRunsList /> : tab === 'stats' ? <DispatchStatsView rangeFrom={query.from} rangeTo={query.to} /> : <HandoffRunsList />}
  </section>;
}
function HandoffRunsList() {
  const { t } = useTranslation('workspace');
  const list = useQuery({ queryKey: ['handoffs'], queryFn: () => api<any[]>('/api/v1/handoffs'), refetchInterval: 5000 });
  return <>{list.error && <p role="alert">{list.error.message}</p>}{list.isLoading ? <p>{t('handoff.loading')}</p> : !list.data?.length ? <p className="py-8 text-sm text-muted-foreground">{t('handoff.empty')}</p> : list.data.map((handoff) => <HandoffCard key={handoff.id} handoff={handoff} />)}</>;
}
function HandoffCard({ handoff: initial, task }: { handoff: any; task?: Task }) {
  const { t } = useTranslation('workspace');
  const statusName = (status: string) => { const key = handoffStatusKeys[status]; return key ? t(key) : status; };
  const [open, setOpen] = useState(false);
  const detail = useQuery({ queryKey: ['handoff', initial.id], queryFn: () => api<any>(`/api/v1/handoffs/${initial.id}`), enabled: open, refetchInterval: open ? 3000 : false });
  const taskQuery = useQuery({ queryKey: ['task', initial.taskId], queryFn: () => api<Task>(`/api/tasks/${initial.taskId}?includeArchived=true`), enabled: open && !task });
  const handoff = detail.data ?? initial;
  const [sourcePath, setSourcePath] = useState('');
  const [inputFiles, setInputFiles] = useState('');
  const [inputFilesEdited, setInputFilesEdited] = useState(false);
  const [answer, setAnswer] = useState('');
  const [revisedInstruction, setRevisedInstruction] = useState<string | null>(null);
  const [completeChildren, setCompleteChildren] = useState(false);
  const [stoppedVerified, setStoppedVerified] = useState(false);
  const [extraWrite, setExtraWrite] = useState(false);
  const [extraShell, setExtraShell] = useState(false);
  const [changePermissions, setChangePermissions] = useState(false);
  const { run, busy } = usePlatformAction();
  const actualTask = task ?? taskQuery.data;
  return <article className="glass-subtle space-y-3 rounded-xl border p-4"><button type="button" className="flex w-full flex-wrap justify-between gap-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}><strong className="min-w-0 break-words text-sm">{actualTask?.title ?? handoff.instruction?.split('\n')[0] ?? handoff.taskId}</strong><span className="text-xs text-muted-foreground">{handoff.provider} · {statusName(handoff.status)}</span></button>{open && <>
    <p className="whitespace-pre-wrap break-words text-sm">{handoff.instruction}</p>{handoff.status === 'prepared' && !handoff.runs?.length && <div className="space-y-2">{revisedInstruction === null ? <Button size="sm" variant="ghost" onClick={() => setRevisedInstruction(handoff.instruction)}>{t('handoff.editGoal')}</Button> : <><Textarea aria-label={t('handoff.editAria')} value={revisedInstruction} onChange={(event) => setRevisedInstruction(event.target.value)} /><Button size="sm" disabled={busy || !actualTask || !revisedInstruction.trim()} onClick={() => void run(async () => { const result = await api(`/api/v1/handoffs/${handoff.id}`, { method: 'PATCH', body: json({ expectedRevision: handoff.revision, expectedTaskRevision: actualTask?.revision, instruction: revisedInstruction }) }); setRevisedInstruction(null); return result; }, t('handoff.savedVersionToast'))}>{t('handoff.saveVersion')}</Button></>}</div>}
    <details className="disclosure"><summary className="cursor-pointer text-xs text-muted-foreground">{t('handoff.frozenContext')}</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(parseStored(handoff.inputSnapshot, {}), null, 2)}</pre></details>
    {handoff.mode === 'manual' ? <p className="rounded-lg bg-muted p-3 text-xs">{t('handoff.manualClaim', { provider: handoff.provider, id: handoff.id })}</p> : <div className="space-y-2"><Input aria-label={t('handoff.sourceAria')} placeholder={t('handoff.sourcePlaceholder')} disabled={busy} value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} /><p className="text-xs text-muted-foreground">{t('handoff.gitHint')}</p><details className="disclosure"><summary className="cursor-pointer text-xs">{t('handoff.nonGitSummary')}</summary><Textarea className="mt-2" aria-label={t('handoff.inputFilesAria')} placeholder={t('handoff.inputFilesPlaceholder')} disabled={busy} value={inputFiles} onChange={(event) => { setInputFiles(event.target.value); setInputFilesEdited(true); }} /><p className="mt-1 text-xs text-muted-foreground">{t('handoff.inputFilesHint')}</p></details><Button size="sm" disabled={busy || !sourcePath.trim() || handoff.status !== 'prepared'} onClick={() => void run(() => api(`/api/v1/handoffs/${handoff.id}/start`, { method: 'POST', body: json({ sourcePath, inputFiles: inputFiles.split(/\r?\n/).map((path) => path.trim()).filter(Boolean), requestId: crypto.randomUUID() }) }), t('handoff.startedToast'))}>{t('handoff.start', { provider: handoff.provider === 'codex' ? 'Codex' : 'Claude Code' })}</Button></div>}
    {(handoff.runs ?? []).map((execution: any) => {
      const result = parseStored<Record<string, any>>(execution.resultJson ?? execution.result, {});
      const workspace = parseStored<Record<string, any>>(execution.workspaceJson ?? execution.workspace, {});
      return <section className="space-y-3 border-t pt-3" key={execution.id}><p className="text-xs text-muted-foreground">{statusName(execution.status)} · {new Date(execution.createdAt).toLocaleString(intlLocale())}</p>{execution.error && <p role="alert" className="text-sm text-destructive">{execution.error}</p>}{result.summary && <ReviewSummary text={String(result.summary)} />}{result.unfinished?.length > 0 && <p className="text-sm">{t('handoff.unfinished', { items: result.unfinished.join(t('clauseSeparator')) })}</p>}{result.proposedCommands?.length > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api(`/api/v1/runs/${execution.id}/proposals`, { method: 'POST', body: '{}' }), t('handoff.proposalsToast'))}>{t('handoff.makeProposal')}</Button>}{(result.questions ?? []).map((question: string) => <p className="text-sm" key={question}>{question}</p>)}
        <RunEvents runId={execution.id} />
        {workspace.inputs?.length > 0 && <details className="disclosure"><summary className="cursor-pointer text-xs text-muted-foreground">{t('handoff.inputSnapshot', { count: workspace.inputs.length })}</summary><ul className="mt-2 space-y-2 text-xs">{workspace.inputs.map((file: any) => <li className="break-all" key={file.path}>{t('handoff.fileBytes', { count: file.size, path: file.path })}<code className="mt-1 block text-muted-foreground">SHA-256 {file.hash}</code></li>)}</ul></details>}
        <RunArtifacts runId={execution.id} workspace={workspace} />
        {execution.status === 'returned' && actualTask?.children?.some((child) => child.status !== 'done') && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={completeChildren} onChange={(event) => setCompleteChildren(event.target.checked)} />{t('handoff.completeChildren')}</label>}
        <div className="flex flex-wrap gap-2">
          {execution.status === 'returned' && <><Button size="sm" disabled={busy || !actualTask} onClick={() => void run(() => api(`/api/v1/handoffs/${handoff.id}/review`, { method: 'POST', body: json({ runId: execution.id, decision: 'accept', expectedTaskRevision: actualTask?.revision }) }), t('handoff.acceptedToast'))}>{t('handoff.accept')}</Button><Button size="sm" variant="outline" disabled={busy || !actualTask} onClick={() => void run(() => api(`/api/v1/handoffs/${handoff.id}/review`, { method: 'POST', body: json({ runId: execution.id, decision: 'accept', expectedTaskRevision: actualTask?.revision, completeTask: true, completeChildren, expectedChildRevisions: Object.fromEntries((actualTask?.children ?? []).map((child) => [child.id, child.revision])) }) }), t('handoff.acceptedDoneToast'))}>{t('handoff.acceptAndComplete')}</Button><Button size="sm" variant="ghost" disabled={busy || !actualTask} onClick={() => void run(() => api(`/api/v1/handoffs/${handoff.id}/review`, { method: 'POST', body: json({ runId: execution.id, decision: 'reject', expectedTaskRevision: actualTask?.revision }) }), t('handoff.reworkToast'))}>{t('handoff.requestRework')}</Button></>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api(`/api/v1/runs/${execution.id}/reconcile`, { method: 'POST', body: '{}' }), t('handoff.reconciledToast'))}>{t('handoff.refresh')}</Button>
          {['created', 'accepted', 'running', 'unknown'].includes(execution.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api(`/api/v1/runs/${execution.id}/cancel`, { method: 'POST', body: '{}' }), t('handoff.cancelToast'))}>{execution.mode === 'manual' ? t('handoff.revokeAuth') : t('handoff.stopRun')}</Button>}
        </div>
        {execution.status === 'unknown' && <div className="space-y-2 text-xs"><label className="flex items-center gap-2"><input type="checkbox" checked={stoppedVerified} onChange={(event) => setStoppedVerified(event.target.checked)} />{t('handoff.verifiedStopped')}</label><Button size="sm" variant="outline" disabled={busy || !stoppedVerified} onClick={() => void run(() => api(`/api/v1/runs/${execution.id}/confirm-stopped`, { method: 'POST', body: json({ confirmedStopped: true }) }), t('handoff.recordedToast'))}>{t('handoff.recordStopped')}</Button></div>}
        {execution.mode === 'local' && ['returned', 'failed', 'cancelled', 'interrupted'].includes(execution.status) && <div className="space-y-2">{execution.mode === 'local' && <div className="space-y-2 text-xs"><label className="flex items-center gap-2"><input type="checkbox" checked={changePermissions} onChange={(event) => setChangePermissions(event.target.checked)} />{t('handoff.adjustPermissions')}</label>{changePermissions && <><label className="flex items-center gap-2"><input type="checkbox" checked={extraWrite} onChange={(event) => setExtraWrite(event.target.checked)} />{t('handoff.allowCopyWrite')}</label><label className="flex items-center gap-2"><input type="checkbox" checked={extraShell} onChange={(event) => setExtraShell(event.target.checked)} />{t('handoff.allowProjectCommands')}</label></>}</div>}{!execution.externalSessionId && <p className="text-xs text-muted-foreground">{t('handoff.noSession')}{!workspace.workPath && t('handoff.fixSource')}</p>}<Input aria-label={t('handoff.continueAria')} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={t('handoff.continuePlaceholder')} /><Button size="sm" disabled={busy || !answer.trim()} onClick={() => void run(async () => { const result = await api(`/api/v1/runs/${execution.id}/continue`, { method: 'POST', body: json({ answer, ...(!workspace.workPath ? { ...(sourcePath.trim() ? { sourcePath: sourcePath.trim() } : {}), ...(inputFilesEdited ? { inputFiles: inputFiles.split(/\r?\n/).map((path) => path.trim()).filter(Boolean) } : {}) } : {}), ...(changePermissions ? { permissions: { profile: extraWrite ? 'workspace_write' : 'read_only', allowShell: extraShell } } : {}), requestId: crypto.randomUUID() }) }); setAnswer(''); return result; }, t('handoff.continuedToast'))}>{execution.externalSessionId ? t('handoff.continue') : t('handoff.retryNew')}</Button></div>}
      </section>;
    })}
  </>}</article>;
}
function ReviewSummary({ text }: { text: string }) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState(false);
  const { long, preview } = reviewPreview(text);
  if (!long) return <MarkdownView content={text} />;
  return <>
    <p className="whitespace-pre-wrap break-words text-sm">{preview}</p>
    <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>{t('handoff.expand')}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent surface="glass" className="max-h-[min(85dvh,calc(100%-3rem))] max-w-[min(42rem,calc(100%-3rem))] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('handoff.resultTitle')}</DialogTitle><DialogDescription>{t('handoff.resultDescription')}</DialogDescription></DialogHeader>
        <MarkdownView content={text} />
      </DialogContent>
    </Dialog>
  </>;
}
function ArtifactPreview({ content, encoding, markdown }: { content: string; encoding: string; markdown: boolean }) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState(false);
  if (encoding !== 'utf8') return <pre className="my-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{t('handoff.binary')}</pre>;
  const { long } = reviewPreview(content);
  const body = markdown ? <MarkdownView content={content} /> : <pre className="whitespace-pre-wrap break-all text-xs">{content}</pre>;
  return <>
    <div className={long ? 'my-3 max-h-40 overflow-hidden rounded-lg border p-3' : 'my-3 max-h-80 overflow-auto rounded-lg border p-3'}>{body}</div>
    {long && <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>{t('handoff.expand')}</Button>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent surface="glass" className="max-h-[min(85dvh,calc(100%-3rem))] max-w-[min(42rem,calc(100%-3rem))] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('handoff.artifactTitle')}</DialogTitle><DialogDescription>{t('handoff.artifactDescription')}</DialogDescription></DialogHeader>
        {markdown ? <MarkdownView content={content} /> : <pre className="whitespace-pre-wrap break-all text-sm">{content}</pre>}
      </DialogContent>
    </Dialog>
  </>;
}
function RunArtifacts({ runId, workspace }: { runId: string; workspace: Record<string, any> }) {
  const { t } = useTranslation('workspace');
  const query = useQuery({ queryKey: ['artifacts', runId], queryFn: () => api<any[]>(`/api/v1/runs/${runId}/artifacts`) });
  const { run, busy } = usePlatformAction();
  const [previewed, setPreviewed] = useState<{ id: string; content: string; name: string; encoding: string; reportedPath?: string | null } | null>(null);
  function download() {
    if (!previewed) return;
    const fileName = downloadFileName(previewed.name, previewed.reportedPath);
    const content = previewed.encoding === 'base64' ? Uint8Array.from(atob(previewed.content), (char) => char.charCodeAt(0)) : previewed.content;
    const type = fileName.endsWith('.md') ? 'text/markdown;charset=utf-8' : previewed.encoding === 'base64' ? 'application/octet-stream' : 'text/plain;charset=utf-8';
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="space-y-2">{(query.data ?? []).map((artifact) => <div className="rounded-lg border p-3" key={artifact.id}><div className="flex flex-wrap items-center gap-3 text-sm"><strong>{artifact.name}</strong><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { const result = await api<any>(`/api/v1/artifacts/${artifact.id}/content`); setPreviewed({ ...result, id: artifact.id, reportedPath: parseStored<any>(artifact.metadata, {}).reportedPath ?? null }); return result; }, t('handoff.loadedToast'))}>{t('handoff.viewArtifact')}</Button>{artifact.kind === 'git_patch' && <Button size="sm" variant="outline" disabled={busy || previewed?.id !== artifact.id} onClick={() => void run(() => api(`/api/v1/runs/${runId}/apply`, { method: 'POST', body: json({ artifactId: artifact.id, expectedHead: workspace.baseHead ?? workspace.head ?? parseStored<any>(artifact.metadata, {}).baseHead, requestId: crypto.randomUUID() }) }), t('handoff.appliedToast'))}>{t('handoff.applyPreviewed')}</Button>}</div>{previewed && previewed.id === artifact.id && <><ArtifactPreview content={previewed.content} encoding={previewed.encoding} markdown={previewed.encoding === 'utf8' && isMarkdownFile(downloadFileName(previewed.name, previewed.reportedPath))} /><Button size="sm" variant="outline" onClick={download}>{t('handoff.download')}</Button></>}</div>)}</div>;
}

function RunEvents({ runId }: { runId: string }) {
  const { t } = useTranslation('workspace');
  const query = useInfiniteQuery({ queryKey: ['run-events', runId], initialPageParam: 0, queryFn: ({ pageParam }) => api<{ items: any[]; nextCursor: number | null }>(`/api/v1/runs/${runId}/events?afterSequence=${pageParam}`), getNextPageParam: (page) => page.nextCursor ?? undefined, refetchInterval: 3000 });
  return <details className="disclosure"><summary className="cursor-pointer text-xs text-muted-foreground">{t('handoff.eventsSummary')}</summary><div className="mt-2 max-h-64 space-y-2 overflow-auto">{query.error && <p role="alert">{query.error.message}</p>}{query.data?.pages.flatMap((page) => page.items).map((event) => <div key={event.id ?? event.sequence} className="border-t pt-2 text-xs"><p>{new Date(event.createdAt).toLocaleString(intlLocale())} · {event.type}</p><pre className="whitespace-pre-wrap break-all">{JSON.stringify(parseStored(event.payload, {}), null, 2)}</pre></div>)}{query.hasNextPage && <Button size="sm" variant="ghost" onClick={() => void query.fetchNextPage()}>{t('handoff.loadMoreEvents')}</Button>}</div></details>;
}
