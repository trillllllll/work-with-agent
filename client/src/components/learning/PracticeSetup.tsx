import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LoaderCircle } from 'lucide-react';
import { api, ApiError } from '@/lib/api.js';
import { currentLanguage } from '@/i18n/index.js';
import { EditorRuntime } from '@/lib/task-editor-runtime.js';
import { learningKey, learningWrite, learningOverviewOptions, useLearningCapabilities, type PracticeConfig, type PracticeJobView, type PracticeSessionView, type PracticeQuestionType, type PracticeMode, type PracticeDifficulty } from '@/lib/learning-api.js';
import { readLearningRecord, writeLearningRecord, removeLearningRecord } from '@/lib/learning-storage.js';
import { FormDialog } from '@/components/dialogs/FormDialog.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Checkbox } from '@/components/ui/checkbox.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';

type SavedRequest = { path: string; body: Record<string, unknown> };
export function PracticeSetup({ scope, mapId, nodeIds, scopeLabel, initialMode = 'knowledge', initialJobId, onClose, onStarted }: {
  scope: string; mapId: string; nodeIds?: string[]; scopeLabel?: string; initialMode?: PracticeMode; initialJobId?: string; onClose: () => void; onStarted: (id: string) => void;
}) {
  const { t } = useTranslation('learning');
  const client = useQueryClient();
  const { overview, unsupported } = useLearningCapabilities(scope);
  const [mode, setMode] = useState<PracticeMode>(initialMode);
  const [difficulty, setDifficulty] = useState<PracticeDifficulty>('medium');
  const [count, setCount] = useState(5);
  const [types, setTypes] = useState<PracticeQuestionType[]>(['single', 'short']);
  const [goal, setGoal] = useState('');
  const [jobId, setJobId] = useState(initialJobId ?? '');
  const [pending, setPending] = useState<SavedRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const alive = useRef(true);
  const expired = useRef(false);
  useEffect(() => { alive.current = true; const expire=()=>{expired.current=true;};window.addEventListener('workspace-session-expired',expire);return () => { alive.current = false;window.removeEventListener('workspace-session-expired',expire); }; }, []);
  useEffect(() => {
    let active = true;
    void readLearningRecord<SavedRequest>(scope, 'setup-pending', mapId).then(value => { if (active && value) setPending(value); }).catch(() => {}).finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [scope, mapId]);
  const job = useQuery({ queryKey: learningKey(scope, 'job', jobId), enabled: Boolean(jobId) && !unsupported, queryFn: () => api<PracticeJobView>(`/api/v1/learning/jobs/${encodeURIComponent(jobId)}`), refetchInterval: query => ['queued','running'].includes(query.state.data?.state ?? '') ? 1500 : false });
  const isCurrent = () => alive.current && !expired.current && EditorRuntime.current()?.scopeKey === scope;
  async function execute(operation: SavedRequest) {
    if (lock.current || !isCurrent() || unsupported) return;
    lock.current = true; setBusy(true); setError(''); setPending(operation);
    try {
      // Confirm support before a new write, including direct links opened before the probe finishes.
      if (await client.fetchQuery(learningOverviewOptions(scope)) === null) return;
      if (!isCurrent()) return;
      // Persist the exact id before any request. Closing the sheet or losing a response is recoverable.
      await writeLearningRecord(scope, 'setup-pending', mapId, operation);
      if(!isCurrent())return;
      const result = await learningWrite<{ job?: PracticeJobView; session?: PracticeSessionView }>(operation.path, operation.body);
      await removeLearningRecord(scope, 'setup-pending', mapId, operation);
      if (!isCurrent()) return;
      setPending(null);
      if (result.session) { onStarted(result.session.id); return; }
      if (result.job) { setJobId(result.job.id); client.setQueryData(learningKey(scope, 'job', result.job.id), result.job); }
      void client.invalidateQueries({ queryKey: learningKey(scope, 'overview') });
    } catch (cause) { if (isCurrent()) {
      setError(cause instanceof Error ? cause.message : t('workflow.failed'));
      if(cause instanceof ApiError&&cause.status&&cause.status>=400&&cause.status<500&&cause.status!==401){
        await removeLearningRecord(scope,'setup-pending',mapId,operation).catch(()=>{});if(!isCurrent())return;setPending(null);if(jobId)void job.refetch();
      }
    } }
    finally { lock.current = false; if (isCurrent()) setBusy(false); }
  }
  function generate() {
    const config: PracticeConfig = { mapId, ...(nodeIds?.length ? { nodeIds } : {}), mode, difficulty, count, types, goal, language: currentLanguage() };
    void execute({ path: '/practice/generate', body: { requestId: crypto.randomUUID(), ...config } });
  }
  const waiting = ['queued','running'].includes(job.data?.state ?? '');
  if (unsupported) return <FormDialog title={t('workflow.setup.title')} onClose={onClose}>
    <p role="status" className="text-sm">{t('workflow.unsupported')}</p>
    <div className="mt-4 flex flex-wrap gap-2"><Button variant="outline" disabled={overview.isFetching} onClick={() => void overview.refetch()}>{t('workflow.checkSupport')}</Button><Button variant="ghost" onClick={onClose}>{t('workflow.setup.close')}</Button></div>
  </FormDialog>;
  return <FormDialog title={t('workflow.setup.title')} onClose={onClose} description={t('workflow.setup.description')}>
    <div className="space-y-4" data-testid="practice-setup">
      {scopeLabel&&<p className="text-sm text-muted-foreground">{t('workflow.setup.scope')}: {scopeLabel}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {pending ? <div className="space-y-3 rounded-lg border p-3"><p className="text-sm">{t('workflow.setup.pending')}</p><Button className="min-h-11" disabled={busy || !ready} onClick={() => void execute(pending)}>{t('retry')}</Button></div> : !jobId ? <>
        <label className="block space-y-2 text-sm"><span>{t('workflow.setup.mode')}</span><Select value={mode} onValueChange={value => setMode(value as PracticeMode)}><SelectTrigger aria-label={t('workflow.setup.mode')} className="min-h-11"><SelectValue /></SelectTrigger><SelectContent>{(['knowledge','wrong','review','mixed'] as const).map(value => <SelectItem key={value} value={value}>{t(`workflow.modes.${value}`)}</SelectItem>)}</SelectContent></Select></label>
        <div className="grid grid-cols-2 gap-3"><label className="space-y-2 text-sm"><span>{t('workflow.setup.count')}</span><Input aria-label={t('workflow.setup.count')} type="number" min={1} max={20} value={count} className="min-h-11" onChange={event => setCount(Number(event.target.value))} /></label><label className="space-y-2 text-sm"><span>{t('workflow.setup.difficulty')}</span><Select value={difficulty} onValueChange={value => setDifficulty(value as PracticeDifficulty)}><SelectTrigger aria-label={t('workflow.setup.difficulty')} className="min-h-11"><SelectValue /></SelectTrigger><SelectContent>{(['easy','medium','hard'] as const).map(value => <SelectItem key={value} value={value}>{t(`workflow.difficulty.${value}`)}</SelectItem>)}</SelectContent></Select></label></div>
        <fieldset><legend className="mb-2 text-sm">{t('workflow.setup.types')}</legend><div className="flex flex-wrap gap-2">{(['single','multiple','boolean','short'] as const).map(type => <label key={type} className="flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm"><Checkbox checked={types.includes(type)} onChange={event => setTypes(values => event.target.checked ? [...values,type] : values.filter(value => value !== type))} />{t(`workflow.types.${type}`)}</label>)}</div></fieldset>
        <label className="block space-y-2 text-sm"><span>{t('workflow.setup.goal')}</span><Textarea aria-label={t('workflow.setup.goal')} value={goal} maxLength={2000} onChange={event => setGoal(event.target.value)} /></label>
        <Button className="min-h-11 w-full" disabled={busy || !ready || !types.length || !Number.isInteger(count) || count < 1 || count > 20} onClick={generate}>{t('workflow.setup.generate')}</Button>
      </> : <>
        {job.isError && <div role="alert"><p className="text-sm">{t('workflow.setup.loadFailed')}</p><Button variant="outline" className="min-h-11" onClick={() => void job.refetch()}>{t('retry')}</Button></div>}
        {(waiting || job.isLoading) && <p role="status" className="flex items-center gap-2 py-5 text-sm"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />{t('workflow.setup.generating')}</p>}
        {job.data?.error && <p role="alert" className="text-sm text-destructive">{job.data.error}</p>}
        {job.data?.candidate && <section className="space-y-3 rounded-xl border p-4" data-testid="practice-candidate"><h3 className="font-medium">{job.data.candidate.title}</h3><p className="text-sm text-muted-foreground">{t('workflow.setup.candidate', { count: job.data.candidate.questions.length })}</p><ol className="list-inside list-decimal space-y-2 text-sm">{job.data.candidate.questions.map((question,index) => <li key={index}>{t(`workflow.types.${question.type}`)} · {question.objective}</li>)}</ol><p className="text-xs text-muted-foreground">{t('workflow.setup.sourceHint')}</p>
          <Button className="min-h-11 w-full" disabled={busy || !job.data.candidateRevision} onClick={() => void execute({ path: '/practice/start', body: { requestId: crypto.randomUUID(), jobId, candidateRevision: job.data!.candidateRevision } })}>{t('workflow.setup.adopt')}</Button></section>}
        {job.data?.adoptedSessionId && <Button className="min-h-11" onClick={() => onStarted(job.data!.adoptedSessionId!)}>{t('workflow.continue')}</Button>}
        <div className="flex flex-wrap gap-2">{job.data && ['failed','cancelled'].includes(job.data.state) && <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void execute({ path: `/jobs/${jobId}/retry`, body: { requestId: crypto.randomUUID() } })}>{t('retry')}</Button>}{waiting && <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void execute({ path: `/jobs/${jobId}/cancel`, body: { requestId: crypto.randomUUID() } })}>{t('workflow.setup.cancelGeneration')}</Button>}<Button variant="ghost" className="min-h-11" onClick={onClose}>{t('workflow.setup.close')}</Button></div>
      </>}
    </div>
  </FormDialog>;
}
