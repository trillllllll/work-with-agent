import { describe, expect, it } from 'vitest';
import { freshPracticeAnswer, reconcilePracticeAnswer } from './learning-answer.js';
import type { PracticeDraftView } from './learning-api.js';
const draft=(values:Partial<PracticeDraftView>={}):PracticeDraftView=>({id:'d',itemId:'i',activeAttemptId:'a',attemptNo:1,answer:'original',revision:1,submitted:false,updatedAt:'2026-10-30',...values});
describe('practice answer reconciliation',()=>{
  it('keeps new typing while acknowledging an earlier draft save',()=>{
    const local={...freshPracticeAnswer(draft()),answer:'new typing',pendingSave:{requestId:'r',activeAttemptId:'a',expectedDraftRevision:1,answer:'saved typing'}};
    expect(reconcilePracticeAnswer(local,draft({revision:2,answer:'saved typing'}))).toMatchObject({conflict:false,value:{answer:'new typing',baseAnswer:'saved typing',revision:2,pendingSave:undefined}});
  });
  it('preserves a local answer when another device edits the same attempt',()=>{
    const local={...freshPracticeAnswer(draft()),answer:'mine'};
    expect(reconcilePracticeAnswer(local,draft({revision:2,answer:'theirs'}))).toEqual({value:local,conflict:true});
  });
  it('does not reinterpret an unknown submission as a new draft or retry identity',()=>{
    const pendingSubmit={requestId:'stable',activeAttemptId:'a',expectedDraftRevision:1,answer:'frozen',questionVersionId:'v',clientAttemptId:'c'};
    const local={...freshPracticeAnswer(draft()),answer:'frozen',pendingSubmit};
    expect(reconcilePracticeAnswer(local,draft({revision:2,answer:'remote'}))).toEqual({value:local,conflict:false});
    expect(reconcilePracticeAnswer(local,draft({revision:2,answer:'frozen',submitted:true}))).toMatchObject({conflict:false,value:{answer:'frozen',revision:2}});
  });
  it('never merges an old attempt into a newly assigned attempt',()=>{
    const local={...freshPracticeAnswer(draft()),answer:'old'};
    expect(reconcilePracticeAnswer(local,draft({activeAttemptId:'new'}))).toEqual({value:local,conflict:true});
  });
  it('preserves this device draft when another device already submitted a different answer',()=>{
    const local={...freshPracticeAnswer(draft()),answer:'mine'};
    expect(reconcilePracticeAnswer(local,draft({revision:2,answer:'theirs',submitted:true}))).toEqual({value:local,conflict:true});
  });
  it('keeps a durable submit intention while acknowledging the server draft',()=>{
    const submitIntent={requestId:'submit',clientAttemptId:'client',questionVersionId:'v',answer:'original'};
    const local={...freshPracticeAnswer(draft()),submitIntent};
    expect(reconcilePracticeAnswer(local,draft({revision:2}))).toMatchObject({conflict:false,value:{submitIntent,revision:2}});
    expect(reconcilePracticeAnswer(local,draft({revision:2,answer:'changed elsewhere'}))).toEqual({value:local,conflict:true});
  });
});
