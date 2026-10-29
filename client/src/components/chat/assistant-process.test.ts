import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolActivity } from '@/chat.js';
import { assistantTurns, isProcessTool, processState } from './assistant-process.js';

const tool = (overrides: Partial<ToolActivity> = {}): ToolActivity => ({ toolCallId: 't', name: 'list_tasks', arguments: {}, status: 'done', preview: '', ...overrides });
const assistant = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'assistant', content: '', ...overrides });
describe('assistant execution process', () => {
  it('combines adjacent rounds but never crosses requests, user messages, system notices or legacy boundaries', () => {
    const messages = [assistant({runId:'r1'}), assistant({runId:'r1'}), assistant({runId:'r2'}),
      {role:'user',content:'next'} as ChatMessage, assistant(), assistant(),
      {role:'system',content:'stopped'} as ChatMessage, assistant(), assistant({runId:'r3'})];
    expect(assistantTurns(messages).map(turn => turn.length)).toEqual([2,1,1,2,1,1,1]);
    expect(assistantTurns(messages).flat()).toEqual(messages);
  });
  it('keeps mutations and any approval-bearing or pending read outside the folded process', () => {
    expect(isProcessTool(tool())).toBe(true);
    expect(isProcessTool(tool({name:'load_skill'}))).toBe(true);
    for (const activity of [tool({name:'propose_task_changes'}),tool({approvalId:'a'}),tool({status:'pending'}),tool({name:'library',arguments:{action:'write'}})]) expect(isProcessTool(activity)).toBe(false);
  });
  it('counts real rounds and failed reads without treating skill loads as queries', () => {
    const state = processState([assistant({ tools:[tool(),tool({status:'error'}),tool({name:'load_skill'})], reasoning:{text:'thought',status:'completed',startedAt:'2026-10-29T00:00:00Z'} })]);
    expect(state).toMatchObject({queries:2,skills:1,failed:1,thinking:false,interrupted:false});
    expect(state.reasoning).toHaveLength(1);
  });
  it('marks stale running records interrupted instead of spinning forever after reload or stop', () => {
    expect(processState([assistant({status:'completed',tools:[tool({status:'running'})]})])).toMatchObject({runningTool:undefined,interrupted:true});
    expect(processState([assistant({status:'failed',reasoning:{text:'partial',status:'streaming',startedAt:'2026-10-29T00:00:00Z'}})])).toMatchObject({thinking:false,interrupted:true});
    expect(processState([assistant({status:'streaming',tools:[tool({status:'running'})]})]).runningTool?.name).toBe('list_tasks');
  });
  it('keeps a query active after message_end while the actual run still executes tools', () => {
    const round = assistant({status:'completed',tools:[tool({status:'running'})]});
    expect(processState([round], true)).toMatchObject({processing:true,interrupted:false,runningTool:{name:'list_tasks'}});
    expect(processState([round], false)).toMatchObject({processing:false,interrupted:true,runningTool:undefined});
  });
});
