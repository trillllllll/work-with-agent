import { describe, expect, it } from 'vitest';
import { applyApprovalEvent, applyMessageEvent, parseSseFrame } from './chat.js';

describe('chat SSE state', () => {
  it('parses a framed SSE delta and incrementally completes an assistant message', () => {
    const start = parseSseFrame('event: message_start\ndata: {"messageId":"m1"}');
    const delta = parseSseFrame('event: message_delta\ndata: {"messageId":"m1","delta":"你好"}');
    const end = parseSseFrame('event: message_end\ndata: {"messageId":"m1"}');
    let messages = applyMessageEvent([], start!);
    messages = applyMessageEvent(messages, delta!);
    messages = applyMessageEvent(messages, end!);
    expect(messages).toEqual([{ id: 'm1', role: 'assistant', content: '你好', status: 'completed' }]);
  });

  it('adds a pending approval and preserves failed streamed text', () => {
    const approval = parseSseFrame('event: approval_required\ndata: {"approvalId":"a1","toolName":"create_task","arguments":{"title":"整理文档"}}');
    const approvals = applyApprovalEvent([], approval!);
    expect(approvals[0]).toMatchObject({ approvalId: 'a1', toolName: 'create_task' });
    const messages = applyMessageEvent([{ id: 'm1', role: 'assistant', content: '已收到', status: 'streaming' }], { type: 'error', code: 'MODEL_HTTP_ERROR' });
    expect(messages[0].status).toBe('failed');
  });
});
