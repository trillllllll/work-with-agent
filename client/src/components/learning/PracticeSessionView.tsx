import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Pause, HelpCircle, RotateCcw, Ellipsis } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api.js';
import { EditorRuntime } from '@/lib/task-editor-runtime.js';
import { askAssistant, contextLabel } from '@/lib/assistant-context.js';
import { learningKey, learningWrite, loadPracticeSession, type PracticeSessionView as Session, type PracticeItemView, type PracticeAnswer } from '@/lib/learning-api.js';
import { readLearningRecord, writeLearningRecord, removeLearningRecord, readLearningPreference, writeLearningPreference } from '@/lib/learning-storage.js';
import { usePracticeAnswer } from '@/lib/learning-answer.js';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { Badge } from '@/components/ui/badge.js';
import { MarkdownView } from '@/components/shared/MarkdownView.js';
import { FormDialog } from '@/components/dialogs/FormDialog.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { ActionMenu, ActionMenuItem } from '@/components/ui/action-menu.js';
import { QuestionCard } from './QuestionCard.js';
import { GradeFeedback, GradeHistory, PreviousAttempts } from './PracticeHistory.js';

type SessionOperation={path:string;body:Record<string,unknown>};
export function PracticeSessionView({scope,sessionId,onBack,onAskAssistant,onAgain}:{scope:string;sessionId:string;onBack:(mapId?:string)=>void;onAskAssistant?:()=>boolean|void;onAgain:(mapId:string)=>void}){
  const {t}=useTranslation('learning');
  const query=useQuery({queryKey:learningKey(scope,'session',sessionId),queryFn:()=>loadPracticeSession(scope,sessionId),refetchInterval:query=>query.state.data?.session.items.some(item=>item.attempts.some(attempt=>['queued','running'].includes(attempt.gradingState)))?1800:false});
  if(query.isLoading)return <div className="space-y-3"><Skeleton className="h-12 w-full"/><Skeleton className="h-72 w-full"/></div>;
  if(query.isError||!query.data)return <div role="alert" className="space-y-3"><p>{query.error instanceof Error?query.error.message:t('workflow.failed')}</p><Button variant="outline" onClick={()=>onBack()}>{t('back')}</Button><Button onClick={()=>void query.refetch()}>{t('retry')}</Button></div>;
  return <PracticeSessionContent key={`${scope}:${sessionId}`} scope={scope} session={query.data.session} offline={query.data.offline} cacheFailed={Boolean(query.data.storageFailed)} refresh={async()=>{await query.refetch();}} onBack={()=>onBack(query.data.session.mapId)} onAskAssistant={onAskAssistant} onAgain={onAgain}/>;
}

function PracticeSessionContent({scope,session,offline,cacheFailed,refresh,onBack,onAskAssistant,onAgain}:{scope:string;session:Session;offline:boolean;cacheFailed:boolean;refresh:()=>Promise<void>;onBack:()=>void;onAskAssistant?:()=>boolean|void;onAgain:(mapId:string)=>void}){
  const {t}=useTranslation('learning');
  const client=useQueryClient();
  const [position,setPosition]=useState(()=>{
    const stored=readLearningPreference<{position:number;at:number}|null>(scope,`session-position:${session.id}`,null);
    return Math.min(Math.max(stored&&stored.at>Date.parse(session.updatedAt)?stored.position:session.currentPosition,0),Math.max(session.items.length-1,0));
  });
  const [pending,setPending]=useState<SessionOperation|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [finish,setFinish]=useState(false);
  const [questionMenu,setQuestionMenu]=useState(false);
  const [archive,setArchive]=useState(false);
  const [regrade,setRegrade]=useState('');
  const [reason,setReason]=useState('');
  const locked=useRef(false);
  const alive=useRef(true);
  const expired=useRef(false);
  const state=useRef(session);state.current=session;
  useEffect(()=>{alive.current=true;let active=true;const expire=()=>{expired.current=true;};window.addEventListener('workspace-session-expired',expire);
    void readLearningRecord<SessionOperation>(scope,'session-operation',session.id).then(value=>{if(active&&value)setPending(value);}).catch(()=>{});
    return()=>{active=false;alive.current=false;window.removeEventListener('workspace-session-expired',expire);};
  },[scope,session.id]);
  const item=session.items[position]??session.items[0];
  const isFinished=session.state==='finished';
  const isCurrent=()=>alive.current&&!expired.current&&EditorRuntime.current()?.scopeKey===scope;
  async function execute(operation:SessionOperation){
    if(locked.current||!isCurrent())return false;
    locked.current=true;setBusy(true);setError('');setPending(operation);
    try{
      await writeLearningRecord(scope,'session-operation',session.id,operation);
      if(!isCurrent())return false;
      await learningWrite(operation.path,operation.body);
      await removeLearningRecord(scope,'session-operation',session.id,operation);
      if(!isCurrent())return false;
      setPending(null);await refresh();
      if(!isCurrent())return false;
      void client.invalidateQueries({queryKey:learningKey(scope,'overview')});void client.invalidateQueries({queryKey:learningKey(scope,'reviews')});return true;
    }catch(cause){
      if(!isCurrent())return false;
      setError(cause instanceof Error?cause.message:t('workflow.failed'));
      if(cause instanceof ApiError&&cause.status&&cause.status>=400&&cause.status<500&&cause.status!==401){
        await removeLearningRecord(scope,'session-operation',session.id,operation).catch(()=>{});if(!isCurrent())return false;setPending(null);await refresh();
      }
      return false;
    }finally{locked.current=false;if(isCurrent())setBusy(false);}
  }
  function operation(path:string,body:Record<string,unknown>){return execute({path,body:{requestId:crypto.randomUUID(),...body}});}
  async function navigate(next:number){
    const bounded=Math.min(Math.max(next,0),session.items.length-1);setPosition(bounded);
    writeLearningPreference(scope,`session-position:${session.id}`,{position:bounded,at:Date.now()});
    if(!offline&&!isFinished&&!pending)await operation(`/practice/sessions/${session.id}/update`,{expectedRevision:state.current.revision,currentPosition:bounded});
  }
  async function setState(next:'active'|'paused'|'finished'){
    const ok=await operation(`/practice/sessions/${session.id}/update`,{expectedRevision:state.current.revision,state:next,currentPosition:position});
    if(ok&&isCurrent()&&next==='paused')onBack();
  }
  function ask(current:PracticeItemView,answer:PracticeAnswer,intent:'hint'|'summarize'='hint'){
    if(onAskAssistant?.()===false)return;
    const text=`${current.question.prompt}\n\n${t('workflow.practice.yourAnswer')}:\n${Array.isArray(answer)?answer.join(', '):answer}`;
    askAssistant({kind:'draft',title:contextLabel(current.question.objective||session.mapTitle),text:text.slice(0,20000),learningMapId:session.mapId,learningNodeId:current.question.nodeId,learningSessionId:session.id,learningItemId:current.id,learningAttemptId:current.draft.activeAttemptId,learningIntent:intent,unsaved:!current.draft.submitted},{prompt:t(`workflow.prompts.${intent}`)});
  }
  if(!item)return <div role="alert"><p>{t('workflow.practice.noQuestions')}</p><Button onClick={onBack}>{t('back')}</Button></div>;
  return <section className="mx-auto w-full max-w-3xl space-y-4" data-testid="practice-session" data-session-id={session.id}>
    <header className="flex flex-wrap items-center justify-between gap-2"><Button variant="ghost" className="min-h-11" onClick={onBack}><ArrowLeft/>{t('workflow.practice.back')}</Button><span className="text-xs text-muted-foreground">{session.mapTitle}</span>{!isFinished&&<Button variant="outline" className="min-h-11" disabled={busy||Boolean(pending)} onClick={()=>void setState('paused')}><Pause/>{t('workflow.practice.pause')}</Button>}</header>
    {offline&&<p role="status" className="rounded-lg border p-3 text-sm">{t('workflow.practice.offline')}</p>}
    {cacheFailed&&<p role="alert" className="text-sm text-destructive">{t('workflow.practice.cacheFailed')}</p>}
    {(session.archived||item.question.archived)&&<p role="status" className="rounded-lg border p-3 text-sm">{t('workflow.practice.archived')}</p>}
    {session.state==='paused'&&<div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"><span className="text-sm">{t('workflow.practice.paused')}</span><Button className="min-h-11" disabled={busy||Boolean(pending)} onClick={()=>void setState('active')}>{t('workflow.continuePractice')}</Button></div>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {pending&&<div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"><span>{t('workflow.practice.operationPending')}</span><Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>void execute(pending)}>{t('retry')}</Button></div>}
    {isFinished&&<PracticeResult session={session} onAgain={()=>onAgain(session.mapId)} onSummarize={()=>ask(item,item.draft.answer,'summarize')}/>}
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">{t('workflow.sessionPosition',{current:position+1,total:session.items.length})}</h2><span className="text-xs text-muted-foreground">{t('workflow.practice.answered',{count:session.summary.answered,total:session.summary.total})}</span>{!session.archived&&!item.question.archived&&<ActionMenu open={questionMenu} onOpenChange={setQuestionMenu} trigger={<Button variant="ghost" className="min-h-11 min-w-11" disabled={busy||Boolean(pending)} aria-label={t('workflow.practice.questionActions')}><Ellipsis/></Button>}><ActionMenuItem className="text-destructive" onSelect={()=>setArchive(true)}>{t('workflow.practice.archiveQuestion')}</ActionMenuItem></ActionMenu>}</div>
    <nav className="flex gap-1 overflow-x-auto py-1" aria-label={t('workflow.practice.questionNavigation')}>{session.items.map((entry,index)=><Button key={entry.id} variant={index===position?'secondary':'ghost'} className="min-h-11 min-w-11 shrink-0" aria-current={index===position?'step':undefined} aria-label={t('workflow.practice.goQuestion',{number:index+1})} onClick={()=>void navigate(index)}>{index+1}{entry.draft.submitted?' ✓':entry.skipped?' ↷':''}</Button>)}</nav>
    <PracticeAnswerPanel key={`${item.id}:${item.draft.activeAttemptId}`} scope={scope} item={item} readOnly={isFinished||session.state==='paused'||session.archived||item.question.archived} operationBusy={busy||Boolean(pending)} refresh={refresh} onEvent={type=>operation(`/practice/items/${item.id}/events`,{activeAttemptId:item.draft.activeAttemptId,type})} onRetry={async answer=>{if(answer!==undefined)await writeLearningRecord(scope,'carry-answer',item.id,{fromAttemptId:item.draft.activeAttemptId,answer});return operation(`/practice/items/${item.id}/retry`,{expectedDraftRevision:item.draft.revision});}} onRegrade={id=>{setReason('');setRegrade(id);}} onAsk={answer=>ask(item,answer)}/>
    <div className="learning-practice-navigation flex flex-wrap items-center justify-between gap-2 border-t pt-3"><Button variant="outline" className="min-h-11" disabled={position===0} onClick={()=>void navigate(position-1)}><ArrowLeft/>{t('workflow.previous')}</Button>{position<session.items.length-1?<Button className="min-h-11" onClick={()=>void navigate(position+1)}>{t('workflow.practice.next')}<ArrowRight/></Button>:!isFinished?<Button className="min-h-11" disabled={busy||Boolean(pending)} onClick={()=>setFinish(true)}>{t('workflow.practice.finish')}</Button>:<Button variant="outline" className="min-h-11" onClick={onBack}>{t('workflow.practice.back')}</Button>}</div>
    {finish&&<ConfirmDialog title={t('workflow.practice.finish')} itemName={session.mapTitle} description={t('workflow.practice.finishHint')} confirmLabel={t('workflow.practice.finish')} busy={busy} onCancel={()=>setFinish(false)} onConfirm={()=>{setFinish(false);void setState('finished');}}/>}
    {archive&&<ConfirmDialog title={t('workflow.practice.archiveQuestion')} itemName={item.question.objective||session.mapTitle} description={t('workflow.practice.archiveQuestionHint')} confirmLabel={t('workflow.practice.archiveQuestion')} busy={busy} onCancel={()=>setArchive(false)} onConfirm={()=>void operation(`/practice/items/${item.id}/archive`,{questionVersionId:item.question.versionId}).then(ok=>{if(ok)setArchive(false);})}/>}
    {regrade&&<FormDialog title={t('workflow.practice.regrade')} onClose={()=>setRegrade('')}><div className="space-y-3"><label className="block space-y-2 text-sm"><span>{t('workflow.practice.regradeReason')}</span><Textarea value={reason} maxLength={2000} onChange={event=>setReason(event.target.value)} /></label><Button className="min-h-11" disabled={busy||!reason.trim()} onClick={()=>void operation(`/practice/attempts/${regrade}/regrade`,{reason}).then(ok=>{if(ok)setRegrade('');})}>{t('workflow.practice.requestRegrade')}</Button></div></FormDialog>}
  </section>;
}

function PracticeAnswerPanel({scope,item,readOnly,operationBusy,refresh,onEvent,onRetry,onRegrade,onAsk}:{scope:string;item:PracticeItemView;readOnly:boolean;operationBusy:boolean;refresh:()=>Promise<void>;onEvent:(type:'hint'|'solution'|'skip')=>Promise<boolean>;onRetry:(answer?:PracticeAnswer)=>Promise<boolean>;onRegrade:(id:string)=>void;onAsk:(answer:PracticeAnswer)=>void}){
  const {t}=useTranslation('learning');
  const state=usePracticeAnswer(scope,item,refresh,!readOnly);
  const latest=item.attempts.find(attempt=>attempt.id===item.draft.activeAttemptId)??item.attempts[item.attempts.length-1];
  const submitted=item.draft.submitted;
  const disabled=readOnly||submitted||state.pending||!state.ready;
  const empty=Array.isArray(state.answer)?!state.answer.length:!state.answer.trim();
  return <div className="space-y-4 rounded-xl border bg-card p-4 sm:p-6">
    <QuestionCard question={item.question} answer={submitted&&!state.conflict?item.draft.answer:state.answer} onChange={state.edit} disabled={disabled} onCompositionChange={state.setComposing}/>
    <p className="text-xs text-muted-foreground">{t(`workflow.selectionReasons.${item.selectionReason}`,{defaultValue:item.selectionReason})}</p>
    <p role="status" className="text-xs text-muted-foreground" data-testid="practice-save-state">{t(`workflow.saveState.${state.storageFailed?'storageFailed':state.conflict?'conflict':submitted?'submitted':state.status}`)}</p>
    {state.storageFailed&&<div role="alert" className="space-y-2 text-sm text-destructive"><p>{t('workflow.practice.cacheFailed')}</p><Button variant="outline" className="min-h-11" onClick={()=>void navigator.clipboard.writeText(Array.isArray(state.answer)?state.answer.join(', '):state.answer).then(()=>toast.success(t('workflow.practice.copied'))).catch(()=>toast.error(t('workflow.practice.copyFailed')))}>{t('workflow.practice.copyAnswer')}</Button></div>}
    {state.error&&<p role="alert" className="text-sm text-destructive">{state.error}</p>}
    {state.conflict&&<div role="alert" className="space-y-3 rounded-lg border p-3 text-sm"><p>{t('workflow.practice.conflict')}</p><p className="whitespace-pre-wrap break-words text-xs">{t('workflow.practice.serverAnswer')}: {Array.isArray(item.draft.answer)?item.draft.answer.join(', '):item.draft.answer}</p><div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" onClick={()=>state.resolveConflict(false)}>{t('loadLatest')}</Button>{submitted?<Button variant="outline" className="min-h-11" disabled={operationBusy||readOnly} onClick={()=>void onRetry(state.answer)}>{t('workflow.practice.newAttemptWithMine')}</Button>:<Button variant="outline" className="min-h-11" onClick={()=>state.resolveConflict(true)}>{t('workflow.practice.keepMine')}</Button>}</div></div>}
    {!readOnly&&!submitted&&<div className="flex flex-wrap gap-2"><Button data-testid="practice-submit" className="min-h-11 flex-1" disabled={empty||state.busy||operationBusy||state.composing||state.conflict||!state.ready} onClick={()=>void state.submit()}>{t(state.pending?'workflow.practice.retrySubmit':'workflow.practice.submit')}</Button>{!state.pending&&<Button variant="ghost" className="min-h-11" disabled={state.busy||operationBusy} onClick={()=>void onEvent('skip')}>{t('workflow.practice.skip')}</Button>}</div>}
    {!readOnly&&<div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" disabled={operationBusy||state.busy||state.pending} onClick={()=>void onEvent('hint')}><HelpCircle/>{t('workflow.practice.hint')}</Button><Button variant="outline" className="min-h-11" disabled={operationBusy||state.busy||state.pending} onClick={()=>void onEvent('solution')}>{t('workflow.practice.solution')}</Button><Button variant="ghost" className="min-h-11" onClick={()=>onAsk(state.answer)}>{t('askAssistant')}</Button></div>}
    {item.hints.map((hint,index)=><div key={index} className="rounded-lg border p-3"><h3 className="mb-1 text-xs font-medium text-muted-foreground">{t('workflow.practice.hintNumber',{number:index+1})}</h3><MarkdownView content={hint}/></div>)}
    {submitted&&latest&&<section className="space-y-3 border-t pt-4" data-testid="practice-feedback"><div className="flex flex-wrap items-center justify-between gap-2"><Badge variant="secondary">{t(`workflow.grading.${latest.gradingState}`)}</Badge><span className="text-xs text-muted-foreground">{t(latest.assistanceUncertain?'workflow.practice.assistanceUncertain':latest.solutionViewed?'workflow.practice.solutionUsed':latest.assisted?'workflow.practice.assisted':'workflow.practice.independent')}</span></div>{latest.error&&<p role="alert" className="text-sm text-destructive">{latest.error}</p>}{latest.grade&&<GradeFeedback grade={latest.grade}/>}<GradeHistory scope={scope} attempt={latest}/><div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" disabled={item.question.archived||operationBusy||['queued','running'].includes(latest.gradingState)} onClick={()=>onRegrade(latest.id)}>{t('workflow.practice.regrade')}</Button>{!readOnly&&<Button variant="outline" className="min-h-11" disabled={operationBusy} onClick={()=>void onRetry()}><RotateCcw/>{t('workflow.practice.retryQuestion')}</Button>}</div></section>}
    {item.solution&&<section className="space-y-2 rounded-lg border p-3"><h3 className="text-sm font-medium">{t('workflow.practice.solution')}</h3><p className="whitespace-pre-wrap text-sm">{Array.isArray(item.solution.answer)?item.solution.answer.join(', '):item.solution.answer}</p><MarkdownView content={item.solution.explanation}/></section>}
    <PreviousAttempts scope={scope} item={item} currentId={latest?.id}/>
  </div>;
}
function PracticeResult({session,onAgain,onSummarize}:{session:Session;onAgain:()=>void;onSummarize:()=>void}){
  const {t}=useTranslation('learning');
  const summary=session.summary;
  return <section className="space-y-4 rounded-xl border bg-card p-4" data-testid="practice-result"><h2 className="text-lg font-semibold">{t('workflow.practice.resultTitle')}</h2><dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">{(['answered','independentCorrect','assistedCorrect','incorrect','partial','pending','unresolved','skipped','invalid'] as const).map(key=><div key={key}><dt className="text-xs text-muted-foreground">{t(`workflow.summary.${key}`)}</dt><dd className="mt-1 text-xl font-semibold">{summary[key]??0}{key==='answered'?` / ${summary.total}`:''}</dd></div>)}</dl><p className="text-xs text-muted-foreground">{t('workflow.practice.resultHint')}</p><div className="flex flex-wrap gap-2"><Button className="min-h-11" onClick={onAgain}>{t('workflow.practice.again')}</Button><Button variant="outline" className="min-h-11" onClick={onSummarize}>{t('workflow.actions.summarize')}</Button></div></section>;
}
