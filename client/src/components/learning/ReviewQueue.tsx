import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api.js';
import { isEditorRuntimeActive } from '@/lib/task-editor-runtime.js';
import { readLearningRecord, writeLearningRecord, removeLearningRecord } from '@/lib/learning-storage.js';
import { learningKey, learningWrite, type PracticeReviewView, type PracticeReviewEventView, type ReviewUpdateInput } from '@/lib/learning-api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { FormDialog } from '@/components/dialogs/FormDialog.js';
import { UnsavedChangesDialog } from '@/components/dialogs/UnsavedChangesDialog.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';

type ReviewPage = { items: PracticeReviewView[]; nextCursor: string | null };

export function ReviewQueue({ scope, mapId, nodeId, initialDue='all', onPractice, onNode }: { scope: string; mapId?: string; nodeId?: string; initialDue?:'all'|'due'; onPractice: (mapId: string,nodeId: string) => void; onNode: (mapId: string,nodeId: string) => void }) {
  const { t, i18n } = useTranslation('learning');
  const [due, setDue] = useState<string>(initialDue);
  useEffect(()=>setDue(initialDue),[initialDue]);
  const [editing, setEditing] = useState<PracticeReviewView | null>(null);
  const client = useQueryClient();
  const query = useInfiniteQuery({ queryKey: learningKey(scope,'reviews',mapId,nodeId,due), initialPageParam: '', queryFn: ({pageParam}) => {
    const params = new URLSearchParams({ ...(mapId ? {mapId} : {}), ...(nodeId ? {nodeId} : {}), ...(due === 'due' ? {due:'true'} : {}), ...(pageParam ? {cursor:pageParam} : {}) });
    return api<ReviewPage>(`/api/v1/learning/reviews?${params}`);
  }, getNextPageParam: last => last.nextCursor ?? undefined });
  const items = query.data?.pages.flatMap(page => page.items) ?? [];
  const refresh = () => client.invalidateQueries({queryKey:learningKey(scope)});
  return <section className="workspace-sheet workspace-learning-records space-y-4 p-4 sm:p-6" data-testid="learning-review-queue" aria-label={t('workflow.reviews.title')}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{t('workflow.reviews.title')}</h2><Select value={due} onValueChange={setDue}><SelectTrigger className="min-h-11 w-36" aria-label={t('workflow.reviews.filter')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('workflow.reviews.all')}</SelectItem><SelectItem value="due">{t('workflow.reviews.due')}</SelectItem></SelectContent></Select></div>
    <p className="text-sm text-muted-foreground">{t('workflow.reviews.explanation')}</p>
    {!mapId&&<p className="text-xs text-muted-foreground">{t('workflow.search.allTopics')}</p>}
    {query.isError && <div role="alert"><p>{t('workflow.failed')}</p><Button onClick={() => void query.refetch()}>{t('retry')}</Button></div>}
    {!query.isLoading && !query.isError && !items.length && <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">{t('workflow.reviews.empty')}</p>}
    {items.map(item => <article key={item.id} className="workspace-row space-y-3 py-4"><div className="flex flex-wrap items-start justify-between gap-2"><Button variant="link" size="bare" className="min-h-11 break-words text-left font-medium whitespace-normal" onClick={() => onNode(item.mapId,item.nodeId)}>{item.title}</Button><span className="text-xs text-muted-foreground">{item.paused ? t('workflow.reviews.paused') : item.dueAt ? new Date(item.dueAt).toLocaleString(i18n.language) : t('workflow.reviews.noDate')}</span></div>
      <p className="text-sm text-muted-foreground">{item.reasons.map(reason => t(`workflow.reviewReasons.${reason}`,{defaultValue:reason})).join(' · ')}</p><p className="text-xs text-muted-foreground">{t(item.policy === 'spaced-v1' ? 'workflow.reviews.spacedPolicy' : 'workflow.reviews.manualPolicy')}{item.manualSchedule ? ` · ${t('workflow.reviews.manualSchedule')}` : ''}</p>
      <div className="flex flex-wrap gap-2"><Button className="min-h-11" onClick={() => onPractice(item.mapId,item.nodeId)}>{t('workflow.reviews.practice')}</Button><Button variant="outline" className="min-h-11" onClick={() => setEditing(item)}>{t('workflow.reviews.adjust')}</Button></div><ReviewEventHistory scope={scope} id={item.id} revision={item.revision}/></article>)}
    {query.hasNextPage && <Button variant="outline" className="min-h-11" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t('workflow.loadMore')}</Button>}
    {editing && <ReviewEditor scope={scope} item={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); }} />}
  </section>;
}

function ReviewEventHistory({scope,id,revision}:{scope:string;id:string;revision:number}){
  const {t,i18n}=useTranslation('learning');const [open,setOpen]=useState(false);
  const query=useInfiniteQuery({queryKey:learningKey(scope,'review-events',id,revision),enabled:open,initialPageParam:'',queryFn:({pageParam})=>api<{items:PracticeReviewEventView[];nextCursor:string|null}>(`/api/v1/learning/reviews/${encodeURIComponent(id)}/events${pageParam?`?cursor=${encodeURIComponent(pageParam)}`:''}`),getNextPageParam:last=>last.nextCursor??undefined});
  const date=(value:string|null)=>value?new Date(value).toLocaleString(i18n.language):t('workflow.reviews.noDate');
  return <Disclosure open={open} onToggle={event=>setOpen(event.currentTarget.open)}><DisclosureTrigger className="min-h-11 text-sm">{t('workflow.reviews.events')}</DisclosureTrigger><div className="space-y-2 pt-2">{query.isLoading&&<p role="status" className="text-sm">{t('workflow.loading')}</p>}{query.isError&&<Button variant="outline" className="min-h-11" onClick={()=>void query.refetch()}>{t('retry')}</Button>}{query.data?.pages.flatMap(page=>page.items).map(event=><article key={event.id} className="space-y-1 rounded-lg border p-3 text-xs"><p>{t(event.kind==='evidence'?'workflow.reviews.evidenceEvent':'workflow.reviews.manualEvent')} · {new Date(event.createdAt).toLocaleString(i18n.language)}</p><p>{event.before?`${date(event.before.dueAt)} → `:''}{date(event.after.dueAt)} · {t(event.after.paused?'workflow.reviews.paused':'workflow.reviews.active')}</p><p>{t(event.after.policy==='spaced-v1'?'workflow.reviews.spacedPolicy':'workflow.reviews.manualPolicy')} · {event.after.reasons.map(reason=>t(`workflow.reviewReasons.${reason}`,{defaultValue:reason})).join(' · ')}</p></article>)}{query.data&&!query.data.pages[0].items.length&&<p className="text-xs text-muted-foreground">{t('workflow.reviews.noEvents')}</p>}{query.hasNextPage&&<Button className="min-h-11" variant="outline" disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>{t('workflow.loadMore')}</Button>}</div></Disclosure>;
}

/** True when the review editor holds unsaved edits relative to the item snapshot. */
export function reviewEditorDirty(date: string, paused: boolean, policy: string, item: Pick<PracticeReviewView, 'dueAt' | 'paused' | 'policy'>) {
  return date !== (item.dueAt ? localDateTime(item.dueAt) : '') || paused !== item.paused || policy !== item.policy;
}

async function latestReview(item: PracticeReviewView) {
  const params = new URLSearchParams({ mapId: item.mapId, nodeId: item.nodeId, limit: '100' });
  for (;;) {
    const page = await api<ReviewPage>(`/api/v1/learning/reviews?${params}`, { cache: 'no-store' });
    // A review marked on a node can become a real scheduled review while the editor is open.
    const latest = page.items.find((row) => row.id === item.id || (item.id.startsWith('node:') && row.questionId === null));
    if (latest || !page.nextCursor) return latest;
    params.set('cursor', page.nextCursor);
  }
}

function ReviewEditor({ scope, item, onClose, onSaved }: { scope: string; item: PracticeReviewView; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('learning');
  const [baseline, setBaseline] = useState(item);
  const [date, setDate] = useState(() => item.dueAt ? localDateTime(item.dueAt) : '');
  const [paused, setPaused] = useState(item.paused);
  const [policy, setPolicy] = useState(item.policy);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ReviewUpdateInput | null>(null);
  const [ready, setReady] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [conflict, setConflict] = useState<'reload' | 'loaded' | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const isCurrent = () => alive.current && isEditorRuntimeActive(scope);
  const dirty = reviewEditorDirty(date, paused, policy, baseline);
  const dateValid = date === '' || Number.isFinite(new Date(date).getTime());
  const controlsDisabled = busy || Boolean(pending) || !ready;
  const interceptClose = () => {
    if (busy) return true;
    if (dirty) setConfirmLeave(true);
    return dirty;
  };

  useEffect(() => {
    alive.current = true;
    let active = true;
    void readLearningRecord<ReviewUpdateInput>(scope, 'review-operation', item.id).then((value) => {
      if (!active || !value) return;
      setPending(value);
      if (value.dueAt !== undefined) setDate(value.dueAt ? localDateTime(value.dueAt) : '');
      if (value.paused !== undefined) setPaused(value.paused);
      if (value.policy) setPolicy(value.policy);
    }).catch(() => {
      if (active) toast.error(t('workflow.practice.cacheFailed'));
    }).finally(() => {
      if (active) setReady(true);
    });
    return () => { active = false; alive.current = false; };
  }, [scope, item.id]);

  async function reloadConflict(changes: Pick<ReviewUpdateInput, 'dueAt' | 'paused' | 'policy'>) {
    const latest = await latestReview(baseline).catch(() => undefined);
    if (!isCurrent() || !latest) return;
    const dueAt = changes.dueAt === undefined ? latest.dueAt : changes.dueAt;
    setDate(dueAt ? localDateTime(dueAt) : '');
    setPaused(changes.paused ?? latest.paused);
    setPolicy(changes.policy ?? latest.policy);
    setBaseline(latest);
    setConflict('loaded');
  }

  async function save() {
    if (lock.current || !ready || !dateValid || !isCurrent()) return;
    lock.current = true;
    setBusy(true);
    const changes = {
      ...(date !== (baseline.dueAt ? localDateTime(baseline.dueAt) : '') ? { dueAt: date ? new Date(date).toISOString() : null } : {}),
      ...(paused !== baseline.paused ? { paused } : {}),
      ...(policy !== baseline.policy ? { policy } : {}),
    };
    try {
      if (conflict === 'reload') {
        await reloadConflict(changes);
        return;
      }
      const body: ReviewUpdateInput = pending ?? { requestId: crypto.randomUUID(), id: baseline.id, expectedRevision: baseline.revision, ...changes };
      const recordId = body.id ?? baseline.id;
      setPending(body);
      try {
        await writeLearningRecord(scope, 'review-operation', recordId, body);
        if (!isCurrent()) return;
        await learningWrite('/reviews/update', body);
      } catch (error) {
        if (!isCurrent()) return;
        const rejected = error instanceof ApiError && error.status && error.status >= 400 && error.status < 500 && error.status !== 401;
        if (rejected) {
          await removeLearningRecord(scope, 'review-operation', recordId, body).catch(() => { toast.error(t('workflow.practice.cacheFailed')); });
          if (!isCurrent()) return;
          setPending(null);
          if (error.code === 'VERSION_CONFLICT' || error.code === 'REVIEW_EXISTS') {
            setConflict('reload');
            await reloadConflict(body);
            return;
          }
        }
        toast.error(error instanceof Error ? error.message : t('workflow.failed'));
        return;
      }
      await removeLearningRecord(scope, 'review-operation', recordId, body).catch(() => { toast.error(t('workflow.practice.cacheFailed')); });
      if (!isCurrent()) return;
      toast.success(t('saved'));
      onSaved();
    } finally {
      lock.current = false;
      if (isCurrent()) setBusy(false);
    }
  }

  return <>
    <FormDialog title={t('workflow.reviews.adjust')} confirmClose={interceptClose} onClose={onClose}>
      <div className="space-y-4">
        <p className="font-medium">{baseline.title}</p>
        {pending && <p role="status" className="text-sm text-muted-foreground">{t('workflow.practice.operationPending')}</p>}
        {conflict === 'reload' && !busy && <p role="alert" className="text-sm text-destructive">{t('workflow.reviews.conflictReload')}</p>}
        {conflict === 'loaded' && <p role="status" className="text-sm text-muted-foreground">{t('workflow.reviews.conflictLoaded')}</p>}
        <label className="block space-y-2 text-sm">
          <span>{t('workflow.reviews.nextDate')}</span>
          <Input type="datetime-local" className="min-h-11" disabled={controlsDisabled} value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        <label className="block space-y-2 text-sm">
          <span>{t('workflow.reviews.policy')}</span>
          <Select disabled={controlsDisabled} value={policy} onValueChange={(value) => setPolicy(value as typeof policy)}>
            <SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">{t('workflow.reviews.manualPolicy')}</SelectItem>
              <SelectItem value="spaced-v1">{t('workflow.reviews.spacedPolicy')}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <p className="text-xs text-muted-foreground">{t('workflow.reviews.policyHint')}</p>
        <Button variant="outline" className="min-h-11" disabled={controlsDisabled} aria-pressed={paused} onClick={() => setPaused((value) => !value)}>
          {t(paused ? 'workflow.reviews.resume' : 'workflow.reviews.pause')}
        </Button>
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => { if (!interceptClose()) onClose(); }}>{t('cancel')}</Button>
          <Button className="min-h-11" disabled={busy || !ready || !dateValid} onClick={() => void save()}>
            {busy ? t('saving') : pending || conflict === 'reload' ? t('retry') : t('save')}
          </Button>
        </div>
      </div>
    </FormDialog>
    {confirmLeave && <UnsavedChangesDialog
      busy={busy}
      canSave={ready && dateValid && conflict !== 'reload'}
      onKeep={() => setConfirmLeave(false)}
      onDiscard={() => { setConfirmLeave(false); onClose(); }}
      onSave={() => { setConfirmLeave(false); void save(); }}
    />}
  </>;
}
export function localDateTime(value:string){const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
