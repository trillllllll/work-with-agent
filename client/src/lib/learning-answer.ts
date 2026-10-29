import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api.js';
import { EditorRuntime } from './task-editor-runtime.js';
import { learningWrite, practiceAnswerEqual, type PracticeAnswer, type PracticeDraftView, type PracticeItemView, type PracticeAttemptView, type DraftSaveInput, type AttemptSubmitInput } from './learning-api.js';
import { readLearningRecord, writeLearningRecord, removeLearningRecord } from './learning-storage.js';

export type LocalPracticeAnswer = {
  activeAttemptId: string; revision: number; baseAnswer: PracticeAnswer; answer: PracticeAnswer;
  pendingSave?: DraftSaveInput; pendingSubmit?: AttemptSubmitInput; updatedAt: number;
  submitIntent?: {requestId:string;clientAttemptId:string;questionVersionId:string;answer:PracticeAnswer};
};
export const answerDirty = (value: LocalPracticeAnswer) => !practiceAnswerEqual(value.answer,value.baseAnswer);
export function freshPracticeAnswer(draft: PracticeDraftView): LocalPracticeAnswer {
  return { activeAttemptId:draft.activeAttemptId,revision:draft.revision,answer:draft.answer,baseAnswer:draft.answer,updatedAt:Date.now() };
}
export function reconcilePracticeAnswer(local:LocalPracticeAnswer,remote:PracticeDraftView): {value:LocalPracticeAnswer;conflict:boolean} {
  if(local.activeAttemptId!==remote.activeAttemptId)return {value:local,conflict:true};
  // Unknown submissions stay frozen until their receipt or authoritative submitted draft is observed.
  if(local.pendingSubmit&&!remote.submitted)return {value:local,conflict:false};
  if(remote.submitted){
    const expected=local.pendingSubmit?.answer??local.submitIntent?.answer??local.answer;
    if((answerDirty(local)||local.pendingSubmit||local.submitIntent)&&!practiceAnswerEqual(expected,remote.answer))return {value:local,conflict:true};
    return {value:freshPracticeAnswer(remote),conflict:false};
  }
  const acknowledged=local.pendingSave && remote.revision>local.pendingSave.expectedDraftRevision && practiceAnswerEqual(remote.answer,local.pendingSave.answer);
  if(acknowledged)return {value:{...local,revision:remote.revision,baseAnswer:remote.answer,pendingSave:undefined},conflict:false};
  if(local.revision===remote.revision)return {value:local,conflict:false};
  if(local.submitIntent)return practiceAnswerEqual(local.answer,remote.answer)
    ?{value:{...local,revision:remote.revision,baseAnswer:remote.answer},conflict:false}
    :{value:local,conflict:true};
  if(!answerDirty(local)&&!local.pendingSave)return {value:freshPracticeAnswer(remote),conflict:false};
  if(practiceAnswerEqual(local.answer,remote.answer))return {value:freshPracticeAnswer(remote),conflict:false};
  return {value:local,conflict:true};
}

export function usePracticeAnswer(scope:string,item:PracticeItemView,onChanged:()=>Promise<unknown>,writable=true) {
  const id=`${item.id}:${item.draft.activeAttemptId}`;
  const [local,setLocal]=useState<LocalPracticeAnswer>(()=>freshPracticeAnswer(item.draft));
  const [ready,setReady]=useState(false);
  const [busy,setBusy]=useState(false);
  const [conflict,setConflict]=useState(false);
  const [error,setError]=useState('');
  const [storageFailed,setStorageFailed]=useState(false);
  const [composing,setComposing]=useState(false);
  const current=useRef(local);current.current=local;
  const source=useRef(item);source.current=item;
  const changed=useRef(onChanged);changed.current=onChanged;
  const mounted=useRef(true);
  const locked=useRef(false);
  const submitting=useRef(false);
  const expired=useRef(false);
  const persist=async(value:LocalPracticeAnswer)=>{
    try{await writeLearningRecord(scope,'answer',id,value);if(mounted.current)setStorageFailed(false);return true;}
    catch{if(mounted.current)setStorageFailed(true);return false;}
  };
  const update=(value:LocalPracticeAnswer)=>{current.current=value;if(mounted.current)setLocal(value);};
  const scopeValid=()=>!expired.current&&EditorRuntime.current()?.scopeKey===scope;
  useEffect(()=>{
    mounted.current=true;let active=true;
    const expire=()=>{expired.current=true;};window.addEventListener('workspace-session-expired',expire);
    void Promise.all([readLearningRecord<LocalPracticeAnswer>(scope,'answer',id),readLearningRecord<{fromAttemptId:string;answer:PracticeAnswer}>(scope,'carry-answer',item.id)]).then(([saved,carry])=>{
      if(!active)return;
      if(saved&&saved.activeAttemptId===item.draft.activeAttemptId&&Number.isInteger(saved.revision)){
        const result=reconcilePracticeAnswer(saved,source.current.draft);update(result.value);setConflict(result.conflict);
      }else if(carry&&carry.fromAttemptId!==item.draft.activeAttemptId&&!item.draft.submitted){
        const next={...freshPracticeAnswer(item.draft),answer:carry.answer};update(next);
        void writeLearningRecord(scope,'answer',id,next).then(()=>removeLearningRecord(scope,'carry-answer',item.id,carry)).catch(()=>{if(active)setStorageFailed(true);});
      }
    }).catch(()=>{if(active)setStorageFailed(true);}).finally(()=>{if(active)setReady(true);});
    return()=>{active=false;mounted.current=false;window.removeEventListener('workspace-session-expired',expire);};
  },[scope,id]);
  useEffect(()=>{
    if(!ready)return;
    const result=reconcilePracticeAnswer(current.current,item.draft);
    if(result.value!==current.current)update(result.value);
    setConflict(result.conflict);
  },[item.draft,ready]);
  useEffect(()=>{if(ready&&!composing)void persist(local);},[local,ready,composing]);
  function edit(answer:PracticeAnswer){
    if(!writable||current.current.pendingSubmit||current.current.submitIntent||source.current.draft.submitted)return;
    update({...current.current,answer,updatedAt:Date.now()});setError('');
  }
  async function saveDraft(){
    if(!writable||locked.current||!ready||composing||conflict||source.current.draft.submitted||current.current.pendingSubmit||!scopeValid())return;
    const snapshot=current.current;
    if(!answerDirty(snapshot)&&!snapshot.pendingSave)return;
    locked.current=true;setBusy(true);setError('');
    const body=snapshot.pendingSave??{requestId:crypto.randomUUID(),activeAttemptId:snapshot.activeAttemptId,expectedDraftRevision:snapshot.revision,answer:structuredClone(snapshot.answer)};
    const pending={...snapshot,pendingSave:body};update(pending);
    try{
      // Never send a request whose retry identity could not be made durable.
      if(!await persist(pending))return;
      if(!scopeValid())return;
      const result=await learningWrite<{draft:PracticeDraftView}>(`/practice/items/${encodeURIComponent(item.id)}/draft`,body);
      if(!mounted.current)return;
      const latest=current.current;
      if(latest.pendingSave?.requestId===body.requestId)update({...latest,revision:result.draft.revision,baseAnswer:result.draft.answer,pendingSave:undefined});
      void changed.current();
      return true;
    }catch(cause){
      if(!mounted.current)return;
      setError(cause instanceof Error?cause.message:String(cause));
      if(cause instanceof ApiError&&cause.status&&cause.status>=400&&cause.status<500&&cause.status!==401){
        update({...current.current,pendingSave:undefined});setConflict(true);void changed.current();
      }
    }finally{locked.current=false;if(mounted.current)setBusy(false);}
  }
  async function submit(){
    if(!writable||locked.current||submitting.current||!ready||composing||conflict||source.current.draft.submitted||!scopeValid())return;
    submitting.current=true;setBusy(true);
    try{
    // A click to submit is durable even when an older autosave has an unknown result.
    if(!current.current.pendingSubmit&&!current.current.submitIntent){
      const next={...current.current,submitIntent:{requestId:crypto.randomUUID(),clientAttemptId:crypto.randomUUID(),questionVersionId:item.question.versionId,answer:structuredClone(current.current.answer)}};
      update(next);if(!await persist(next))return;
    }
    if(current.current.pendingSave){const saved=await saveDraft();if(!saved||current.current.pendingSave||!scopeValid())return;}
    if(source.current.draft.submitted||(!current.current.pendingSubmit&&!current.current.submitIntent))return;
    locked.current=true;setBusy(true);setError('');
    const snapshot=current.current;
    const body=snapshot.pendingSubmit??{...snapshot.submitIntent!,activeAttemptId:snapshot.activeAttemptId,expectedDraftRevision:snapshot.revision};
    const pending={...snapshot,pendingSubmit:body};update(pending);
    try{
      if(!await persist(pending))return;
      if(!scopeValid())return;
      await learningWrite<{attempt:PracticeAttemptView;sessionId:string;itemId:string}>(`/practice/items/${encodeURIComponent(item.id)}/submit`,body);
      if(!mounted.current)return;
      // Keep the frozen submission until the authoritative session reports submitted=true.
      await changed.current();
    }catch(cause){
      if(!mounted.current)return;
      setError(cause instanceof Error?cause.message:String(cause));
      if(cause instanceof ApiError&&cause.status&&cause.status>=400&&cause.status<500&&cause.status!==401){
        update({...current.current,pendingSubmit:undefined,submitIntent:undefined});setConflict(true);void changed.current();
      }
    }finally{locked.current=false;}
    }finally{submitting.current=false;if(mounted.current)setBusy(false);}
  }
  const saveRef=useRef(saveDraft);saveRef.current=saveDraft;
  const submitRef=useRef(submit);submitRef.current=submit;
  useEffect(()=>{
    if(!writable||!ready||busy||conflict||composing||local.pendingSave||local.pendingSubmit||local.submitIntent||!answerDirty(local)||item.draft.submitted||error)return;
    const timeout=window.setTimeout(()=>void saveRef.current(),900);return()=>clearTimeout(timeout);
  },[local,ready,busy,conflict,composing,item.draft.submitted,error,writable]);
  useEffect(()=>{
    const online=()=>{if(current.current.pendingSubmit||current.current.submitIntent)void submitRef.current();else void saveRef.current();};
    window.addEventListener('online',online);return()=>window.removeEventListener('online',online);
  },[]);
  function resolveConflict(keepLocal:boolean){
    if(current.current.pendingSubmit&&!source.current.draft.submitted)return;
    const fresh=freshPracticeAnswer(source.current.draft);
    update(keepLocal?{...fresh,answer:current.current.answer}:fresh);setConflict(false);setError('');
  }
  const status=!ready?'loading':conflict?'conflict':local.pendingSubmit||local.submitIntent?'pending':busy?'saving':error?'local':answerDirty(local)||local.pendingSave?'local':'saved';
  return {answer:local.answer,edit,ready,busy,conflict,error,storageFailed,composing,setComposing,status,pending:Boolean(local.pendingSubmit||local.submitIntent),saveDraft,submit,resolveConflict};
}
