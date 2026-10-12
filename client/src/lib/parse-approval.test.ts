import { describe, expect, it } from 'vitest';
import { pairToolMessages } from '../chat.js';
import { parseApproval } from './api.js';

const preview = { schemaVersion: 1 as const, summary: '整组调整', operationCount: 3, beforeTasks: [], afterTasks: [], changes: [] };

describe('parseApproval history', () => {
  it('keeps an old pending single-task approval on the proposal link', () => {
    const approval = parseApproval({ id: 'old-pending', toolName: 'create_task', arguments: '{"title":"整理文档"}', status: 'pending', result: JSON.stringify({ proposalId: 'p1', proposalRevision: 1, toolCallId: 'call-old' }) });
    expect(approval).toMatchObject({ approvalId: 'old-pending', status: 'pending', toolCallId: 'call-old', resultState: 'proposal' });
    expect(approval.preview).toBeUndefined();
  });

  it('keeps an old executed bare result', () => {
    const approval = parseApproval({ id: 'old-done', toolName: 'update_task', arguments: '{}', status: 'executed', result: JSON.stringify({ success: true, data: { title: '已改' } }) });
    expect(approval).toMatchObject({ approvalId: 'old-done', status: 'executed', resultState: 'result' });
    expect(approval.preview).toBeUndefined();
  });

  it('reads the new batch envelope and does not surface a missing result', () => {
    const approval = parseApproval({
      id: 'batch-1', toolName: 'propose_task_changes', arguments: '{"summary":"整组调整"}', status: 'executed', conversationId: 'conv-1',
      result: JSON.stringify({ schemaVersion: 1, kind: 'task_batch', proposalId: 'p9', proposalRevision: 2, toolCallId: 'call-batch', assistantMessageId: 'assistant-1', summary: '整组调整', preview, outcome: { success: true, data: { proposalId: 'p9', changeId: 'c1', operationCount: 3, affectedTaskIds: [], tasks: [] } } }),
    });
    expect(approval).toMatchObject({ resultState: 'batch', toolCallId: 'call-batch', summary: '整组调整', preview });
    const visible = pairToolMessages([
      { id: 'assistant-1', role: 'assistant', content: '准备整组修改', toolCalls: JSON.stringify([{ id: 'call-batch', type: 'function', function: { name: 'propose_task_changes', arguments: '{"summary":"整组调整"}' } }]) },
      { id: 'tool-1', role: 'tool', toolCallId: 'call-batch', content: JSON.stringify({ toolName: 'propose_task_changes', toolCallId: 'call-batch', assistantMessageId: 'assistant-1', success: true, data: { operationCount: 3 } }) },
    ], [approval]);
    expect(visible[0]?.tools?.[0]).toMatchObject({ status: 'done', toolCallId: 'call-batch', approvalId: 'batch-1' });
    expect(visible[0]?.tools?.[0]?.error).toBeUndefined();
    expect(JSON.stringify(visible)).not.toContain('没有返回结果');
  });

  it('marks illegal approval JSON unreadable', () => {
    expect(parseApproval({ id: 'bad', toolName: 'update_task', arguments: '{}', status: 'executed', result: '{oops' }).resultState).toBe('unreadable');
  });
});
