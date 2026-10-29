import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api.js';
import { EditorRuntime } from '@/lib/task-editor-runtime.js';
import { readLearningRecord, writeLearningRecord, removeLearningRecord } from '@/lib/learning-storage.js';
import { learningKey, type PracticeHistoryView } from '@/lib/learning-api.js';
import { submitCommands, type Command } from '@/lib/platform.js';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';
import { MarkdownView } from '@/components/shared/MarkdownView.js';
import { FormDialog } from '@/components/dialogs/FormDialog.js';
import { GradeFeedback, GradeHistory } from './PracticeHistory.js';

type ActivityPage={items:Array<{id:string;kind:string;content:string;createdAt:string;nodeId:string|null;meta?:Record<string,unknown>}>;nextCursor:string|null};
export function LearningTimeline({scope,mapId,nodeId,onSession}:{scope:string;mapId?:string;nodeId?:string;onSession:(id:string)=>void}){
  const {t,i18n}=useTranslation('learning');
  const [checkpoint,setCheckpoint]=useState(false);
  const [tab,setTab]=useState<'practice'|'notes'>('practice');
  const client=useQueryClient();
  const history=useInfiniteQuery({queryKey:learningKey(scope,'history',mapId,nodeId),initialPageParam:'',queryFn:({pageParam})=>api<PracticeHistoryView>(`/api/v1/learning/practice/history?${new URLSearchParams({...(mapId?{mapId}:{}),...(nodeId?{nodeId}:{}),...(pageParam?{cursor:pageParam}:{})})}`),getNextPageParam:last=>last.nextCursor??undefined});
  const activity=useInfiniteQuery({queryKey:learningKey(scope,'activity',mapId,nodeId),initialPageParam:'',queryFn:({pageParam})=>api<ActivityPage>(`/api/v1/learning/activity?${new URLSearchParams({...(mapId?{mapId}:{}),...(nodeId?{nodeId}:{}),...(pageParam?{cursor:pageParam}:{})})}`),getNextPageParam:last=>last.nextCursor??undefined});
  const attempts=history.data?.pages.flatMap(page=>page.items)??[];
  const activities=activity.data?.pages.flatMap(page=>page.items)??[];
  return <section className="space-y-4" data-testid="learning-timeline"><header className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{t('workflow.records.title')}</h2><div className="flex flex-wrap items-center gap-2">{!mapId&&<span className="text-xs text-muted-foreground">{t('workflow.search.allTopics')}</span>}{mapId&&<Button variant="outline" className="min-h-11" onClick={()=>setCheckpoint(true)}>{t('workflow.records.checkpoint')}</Button>}</div></header><div className="flex gap-2"><Button variant={tab==='practice'?'secondary':'ghost'} className="min-h-11" aria-pressed={tab==='practice'} onClick={()=>setTab('practice')}>{t('workflow.records.practice')}</Button><Button variant={tab==='notes'?'secondary':'ghost'} className="min-h-11" aria-pressed={tab==='notes'} onClick={()=>setTab('notes')}>{t('workflow.records.notes')}</Button></div>
    {(tab==='practice'?history.isError:activity.isError)&&<div role="alert"><p>{t('workflow.failed')}</p><Button onClick={()=>void(tab==='practice'?history.refetch():activity.refetch())}>{t('retry')}</Button></div>}
    {tab==='practice'?<>{!history.isLoading&&!history.isError&&!attempts.length&&<p className="rounded-lg border p-6 text-sm text-muted-foreground">{t('workflow.records.noPractice')}</p>}{attempts.map(attempt=><article key={attempt.id} className="space-y-3 rounded-xl border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{attempt.nodeTitle}</span><time className="text-xs text-muted-foreground">{new Date(attempt.submittedAt).toLocaleString(i18n.language)}</time></div><MarkdownView content={attempt.question.prompt}/><p className="text-xs text-muted-foreground">{t('workflow.practice.attemptNumber',{number:attempt.attemptNo})} · {t(attempt.solutionViewed?'workflow.practice.solutionUsed':attempt.assisted?'workflow.practice.assisted':'workflow.practice.independent')}</p><p className="whitespace-pre-wrap break-words text-sm">{t('workflow.practice.yourAnswer')}: {Array.isArray(attempt.answer)?attempt.answer.join(', '):attempt.answer}</p>{attempt.grade?<GradeFeedback grade={attempt.grade}/>:<p role="status" className="text-sm">{t(`workflow.grading.${attempt.gradingState}`)}</p>}<GradeHistory scope={scope} attempt={attempt}/><Button variant="outline" className="min-h-11" onClick={()=>onSession(attempt.sessionId)}>{t('workflow.records.openSession')}</Button></article>)}{history.hasNextPage&&<Button variant="outline" disabled={history.isFetchingNextPage} onClick={()=>void history.fetchNextPage()}>{t('workflow.loadMore')}</Button>}</>:<>{!activity.isLoading&&!activity.isError&&!activities.length&&<p className="rounded-lg border p-6 text-sm text-muted-foreground">{t('workflow.records.noNotes')}</p>}{activities.map(entry=><article key={entry.id} className="space-y-2 rounded-xl border p-4"><time className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString(i18n.language)}</time><MarkdownView content={entry.content}/></article>)}{activity.hasNextPage&&<Button variant="outline" disabled={activity.isFetchingNextPage} onClick={()=>void activity.fetchNextPage()}>{t('workflow.loadMore')}</Button>}</>}
    {checkpoint&&mapId&&<CheckpointForm scope={scope} mapId={mapId} nodeId={nodeId} onClose={()=>setCheckpoint(false)} onSaved={()=>{setCheckpoint(false);void client.invalidateQueries({queryKey:learningKey(scope)});}}/>}
  </section>;
}
function CheckpointForm({scope,mapId,nodeId,onClose,onSaved}:{scope:string;mapId:string;nodeId?:string;onClose:()=>void;onSaved:()=>void}){
  const {t}=useTranslation('learning');
  const [summary,setSummary]=useState('');const [questions,setQuestions]=useState('');const [next,setNext]=useState('');const [busy,setBusy]=useState(false);
  const [pending,setPending]=useState<{id:string;command:Command}|null>(null);
  const [ready,setReady]=useState(false);const lock=useRef(false);const recordId=`${mapId}:${nodeId??'topic'}`;
  const alive=useRef(true);const expired=useRef(false);
  const isCurrent=()=>alive.current&&!expired.current&&EditorRuntime.current()?.scopeKey===scope;
  useEffect(()=>{alive.current=true;const expire=()=>{expired.current=true;};window.addEventListener('workspace-session-expired',expire);return()=>{alive.current=false;window.removeEventListener('workspace-session-expired',expire);};},[]);
  useEffect(()=>{let active=true;void readLearningRecord<{id:string;command:Command}>(scope,'checkpoint-operation',recordId).then(value=>{if(active&&value)setPending(value);}).catch(()=>toast.error(t('workflow.practice.cacheFailed'))).finally(()=>{if(active)setReady(true);});return()=>{active=false;};},[scope,recordId]);
  async function save(){if(lock.current||!ready||!isCurrent())return;lock.current=true;setBusy(true);
    const content=[summary,questions?`${t('workflow.records.questions')}\n${questions}`:'',next?`${t('workflow.records.next')}\n${next}`:''].filter(Boolean).join('\n\n');
    const command:Command={kind:'learning.activity.append',input:{mapId,nodeId:nodeId??null,kind:'session',content,meta:{schemaVersion:1,type:'checkpoint',unresolvedQuestions:questions.split('\n').map(line=>line.trim()).filter(Boolean),nextStep:next,sources:[]}}};
    const operation=pending??{id:crypto.randomUUID(),command};setPending(operation);
    try{await writeLearningRecord(scope,'checkpoint-operation',recordId,operation);if(!isCurrent())return;const result=await submitCommands([operation.command],operation.id);if(result.status!=='applied')throw new Error(t('savePending'));await removeLearningRecord(scope,'checkpoint-operation',recordId,operation);if(!isCurrent())return;toast.success(t('saved'));onSaved();}catch(error){if(!isCurrent())return;toast.error(error instanceof Error?error.message:t('workflow.failed'));if(error instanceof ApiError&&error.status&&error.status>=400&&error.status<500&&error.status!==401){await removeLearningRecord(scope,'checkpoint-operation',recordId,operation).catch(()=>{});if(isCurrent())setPending(null);}}finally{lock.current=false;if(isCurrent())setBusy(false);}
  }
  return <FormDialog title={t('workflow.records.checkpoint')} onClose={onClose}><div className="space-y-4">{pending?<><p role="status" className="text-sm text-muted-foreground">{t('workflow.practice.operationPending')}</p><MarkdownView content={String(pending.command.input?.content??'')}/></>:[{label:'summary',value:summary,set:setSummary},{label:'questions',value:questions,set:setQuestions},{label:'next',value:next,set:setNext}].map(field=><label key={field.label} className="block space-y-2 text-sm"><span>{t(`workflow.records.${field.label}`)}</span><Textarea value={field.value} disabled={!ready||busy} maxLength={field.label==='summary'?2000:1000} onChange={event=>field.set(event.target.value)}/></label>)}<p className="text-xs text-muted-foreground">{t('workflow.records.checkpointHint')}</p><Button className="min-h-11" disabled={busy||!ready||!pending&&!summary.trim()} onClick={()=>void save()}>{busy?t('saving'):pending?t('retry'):t('save')}</Button></div></FormDialog>;
}
