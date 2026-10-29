import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api.js';
import { EditorRuntime } from '@/lib/task-editor-runtime.js';
import { readLearningRecord, writeLearningRecord, removeLearningRecord } from '@/lib/learning-storage.js';
import { learningKey, learningWrite, type PracticeReviewView, type PracticeReviewEventView, type ReviewUpdateInput } from '@/lib/learning-api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { FormDialog } from '@/components/dialogs/FormDialog.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';

export function ReviewQueue({ scope, mapId, nodeId, initialDue='all', onPractice, onNode }: { scope: string; mapId?: string; nodeId?: string; initialDue?:'all'|'due'; onPractice: (mapId: string,nodeId: string) => void; onNode: (mapId: string,nodeId: string) => void }) {
  const { t, i18n } = useTranslation('learning');
  const [due, setDue] = useState<string>(initialDue);
  useEffect(()=>setDue(initialDue),[initialDue]);
  const [editing, setEditing] = useState<PracticeReviewView | null>(null);
  const client = useQueryClient();
  const query = useInfiniteQuery({ queryKey: learningKey(scope,'reviews',mapId,nodeId,due), initialPageParam: '', queryFn: ({pageParam}) => {
    const params = new URLSearchParams({ ...(mapId ? {mapId} : {}), ...(nodeId ? {nodeId} : {}), ...(due === 'due' ? {due:'true'} : {}), ...(pageParam ? {cursor:pageParam} : {}) });
    return api<{items:PracticeReviewView[];nextCursor:string|null}>(`/api/v1/learning/reviews?${params}`);
  }, getNextPageParam: last => last.nextCursor ?? undefined });
  const items = query.data?.pages.flatMap(page => page.items) ?? [];
  const refresh = () => client.invalidateQueries({queryKey:learningKey(scope)});
  return <section className="space-y-4" data-testid="learning-review-queue" aria-label={t('workflow.reviews.title')}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{t('workflow.reviews.title')}</h2><Select value={due} onValueChange={setDue}><SelectTrigger className="min-h-11 w-36" aria-label={t('workflow.reviews.filter')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('workflow.reviews.all')}</SelectItem><SelectItem value="due">{t('workflow.reviews.due')}</SelectItem></SelectContent></Select></div>
    <p className="text-sm text-muted-foreground">{t('workflow.reviews.explanation')}</p>
    {!mapId&&<p className="text-xs text-muted-foreground">{t('workflow.search.allTopics')}</p>}
    {query.isError && <div role="alert"><p>{t('workflow.failed')}</p><Button onClick={() => void query.refetch()}>{t('retry')}</Button></div>}
    {!query.isLoading && !query.isError && !items.length && <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">{t('workflow.reviews.empty')}</p>}
    {items.map(item => <article key={item.id} className="space-y-3 rounded-xl border p-4"><div className="flex flex-wrap items-start justify-between gap-2"><Button variant="link" size="bare" className="min-h-11 break-words text-left font-medium whitespace-normal" onClick={() => onNode(item.mapId,item.nodeId)}>{item.title}</Button><span className="text-xs text-muted-foreground">{item.paused ? t('workflow.reviews.paused') : item.dueAt ? new Date(item.dueAt).toLocaleString(i18n.language) : t('workflow.reviews.noDate')}</span></div>
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

function ReviewEditor({scope,item,onClose,onSaved}:{scope:string;item:PracticeReviewView;onClose:()=>void;onSaved:()=>void}) {
  const {t}=useTranslation('learning');
  const [date,setDate]=useState(() => item.dueAt ? localDateTime(item.dueAt) : '');
  const [paused,setPaused]=useState(item.paused);
  const [policy,setPolicy]=useState(item.policy);
  const [busy,setBusy]=useState(false);
  const [pending,setPending]=useState<ReviewUpdateInput|null>(null);
  const [ready,setReady]=useState(false);
  const lock=useRef(false);
  const alive=useRef(true);const expired=useRef(false);
  const isCurrent=()=>alive.current&&!expired.current&&EditorRuntime.current()?.scopeKey===scope;
  useEffect(()=>{alive.current=true;const expire=()=>{expired.current=true;};window.addEventListener('workspace-session-expired',expire);return()=>{alive.current=false;window.removeEventListener('workspace-session-expired',expire);};},[]);
  useEffect(()=>{let active=true;void readLearningRecord<ReviewUpdateInput>(scope,'review-operation',item.id).then(value=>{if(!active||!value)return;setPending(value);if(value.dueAt!==undefined)setDate(value.dueAt?localDateTime(value.dueAt):'');if(value.paused!==undefined)setPaused(value.paused);if(value.policy)setPolicy(value.policy);}).catch(()=>toast.error(t('workflow.practice.cacheFailed'))).finally(()=>{if(active)setReady(true);});return()=>{active=false;};},[scope,item.id]);
  async function save(){
    if(lock.current||!ready||!isCurrent())return;
    lock.current=true;
    setBusy(true);
    const body:ReviewUpdateInput=pending??{requestId:crypto.randomUUID(),id:item.id,expectedRevision:item.revision,...(date!==(item.dueAt?localDateTime(item.dueAt):'')?{dueAt:date?new Date(date).toISOString():null}:{}),...(paused!==item.paused?{paused}:{}),...(policy!==item.policy?{policy}:{})};
    setPending(body);
    try{await writeLearningRecord(scope,'review-operation',item.id,body);if(!isCurrent())return;await learningWrite('/reviews/update',body);await removeLearningRecord(scope,'review-operation',item.id,body);if(!isCurrent())return;toast.success(t('saved'));onSaved();}catch(error){if(!isCurrent())return;toast.error(error instanceof Error?error.message:t('workflow.failed'));if(error instanceof ApiError&&error.status&&error.status>=400&&error.status<500&&error.status!==401){await removeLearningRecord(scope,'review-operation',item.id,body);if(!isCurrent())return;setPending(null);onSaved();}}finally{lock.current=false;if(isCurrent())setBusy(false);}
  }
  return <FormDialog title={t('workflow.reviews.adjust')} onClose={onClose}><div className="space-y-4"><p className="font-medium">{item.title}</p>{pending&&<p role="status" className="text-sm text-muted-foreground">{t('workflow.practice.operationPending')}</p>}<label className="block space-y-2 text-sm"><span>{t('workflow.reviews.nextDate')}</span><Input type="datetime-local" className="min-h-11" disabled={Boolean(pending)||!ready} value={date} onChange={event=>setDate(event.target.value)} /></label><label className="block space-y-2 text-sm"><span>{t('workflow.reviews.policy')}</span><Select disabled={Boolean(pending)||!ready} value={policy} onValueChange={value=>setPolicy(value as typeof policy)}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="manual">{t('workflow.reviews.manualPolicy')}</SelectItem><SelectItem value="spaced-v1">{t('workflow.reviews.spacedPolicy')}</SelectItem></SelectContent></Select></label><p className="text-xs text-muted-foreground">{t('workflow.reviews.policyHint')}</p><Button variant="outline" className="min-h-11" disabled={Boolean(pending)||!ready} aria-pressed={paused} onClick={()=>setPaused(value=>!value)}>{t(paused?'workflow.reviews.resume':'workflow.reviews.pause')}</Button><div className="flex justify-end gap-2"><Button variant="outline" className="min-h-11" onClick={onClose}>{t('cancel')}</Button><Button className="min-h-11" disabled={busy||!ready||Boolean(date&&!Number.isFinite(new Date(date).getTime()))} onClick={()=>void save()}>{busy?t('saving'):pending?t('retry'):t('save')}</Button></div></div></FormDialog>;
}
function localDateTime(value:string){const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
