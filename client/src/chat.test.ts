import { describe, expect, it } from 'vitest';
import { applyApprovalEvent, applyMessageEvent, groupToolActivities, isReadOnlyTool, pairToolMessages, parseSseFrame, toolPreview, type ToolActivity } from './chat.js';

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

  it('keeps a tool result on the assistant message', () => {
    let messages = applyMessageEvent([], { type: 'message_start', messageId: 'm1' });
    messages = applyMessageEvent(messages, { type: 'message_delta', messageId: 'm1', delta: '我先看一下。' });
    messages = applyMessageEvent(messages, { type: 'message_end', messageId: 'm1' });
    messages = applyMessageEvent(messages, { type: 'tool_call', messageId: 'm1', toolCallId: 'call_1', toolName: 'list_tasks', arguments: {} });
    messages = applyMessageEvent(messages, { type: 'tool_result', messageId: 'm1', toolCallId: 'call_1', toolName: 'list_tasks', arguments: {}, result: { success: true, data: [{ title: '青鸟' }, { title: '另一条' }] } });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.tools?.[0]).toMatchObject({ toolCallId: 'call_1', status: 'done', preview: '2 条任务 · 青鸟' });
  });

  it('summarizes finished reads and previews each tool', () => {
    const tools: ToolActivity[] = [
      { toolCallId: 'a', name: 'list_tasks', arguments: {}, status: 'done', preview: '1 条任务' },
      { toolCallId: 'b', name: 'get_task', arguments: {}, status: 'done', preview: '青鸟' },
      { toolCallId: 'c', name: 'create_task', arguments: { title: '新任务' }, status: 'pending', preview: '新任务', approvalId: 'ap1' },
    ];
    const groups = groupToolActivities(tools);
    expect(groups.map((group) => group.kind)).toEqual(['run', 'call']);
    expect(groups[0]).toMatchObject({ kind: 'run', activities: [tools[0], tools[1]] });
    expect(toolPreview('list_topics', {}, { success: true, data: [{}, {}] }, 'done')).toBe('2 个清单');
    expect(toolPreview('get_topic_progress', {}, { success: true, data: { topic: { name: '清单甲' } } }, 'done')).toBe('清单甲');
    expect(toolPreview('execute_shell', { command: 'git status' }, { success: true }, 'done')).toBe('git status');
    expect(toolPreview('create_task', { title: '甲' }, { success: false, error: '用户拒绝，数据未修改' }, 'rejected')).toBe('已拒绝');
    expect(toolPreview('update_task', { taskId: 'task-1' }, { success: false, error: '任务不存在' }, 'error')).toBe('任务不存在');
    const memoryTools: ToolActivity[] = [
      { toolCallId: 'm', name: 'memory', arguments: { action: 'read', memoryId: 'm1' }, status: 'done', preview: '暗号' },
      { toolCallId: 'h', name: 'conversation_search', arguments: { q: '青鸟原句' }, status: 'done', preview: '青鸟原句' },
      { toolCallId: 'w', name: 'memory', arguments: { action: 'add', title: '暗号' }, status: 'pending', preview: '暗号' },
    ];
    expect(groupToolActivities(memoryTools).map((group) => group.kind)).toEqual(['run', 'call']);
    expect(isReadOnlyTool('memory', { action: 'read' })).toBe(true);
    expect(isReadOnlyTool('memory', { action: 'search' })).toBe(true);
    expect(isReadOnlyTool('memory', { action: 'add' })).toBe(false);
    expect(isReadOnlyTool('conversation_search')).toBe(true);
    expect(toolPreview('memory', { action: 'add', title: '暗号' }, undefined, 'pending')).toBe('暗号');
    expect(toolPreview('memory', { action: 'read', memoryId: 'm1' }, { success: true, data: { title: '暗号' } }, 'done')).toBe('暗号');
    expect(toolPreview('conversation_search', { q: '青鸟原句' }, { success: true, data: {} }, 'done')).toBe('青鸟原句');
    expect(toolPreview('conversation_search', { messageId: 'm1' }, undefined, 'running')).toBe('前后文');
    let failed = applyMessageEvent([], { type: 'message_start', messageId: 'm9' });
    failed = applyMessageEvent(failed, { type: 'message_end', messageId: 'm9' });
    failed = applyMessageEvent(failed, { type: 'tool_call', messageId: 'm9', toolCallId: 'blank', toolName: 'memory', arguments: { action: 'search', target: 'topic', q: '' } });
    failed = applyMessageEvent(failed, { type: 'error', code: 'INVALID_TOOL_ARGUMENTS', message: 'search 需要关键词' });
    expect(failed[0]?.status).toBe('completed');
    expect(failed[0]?.tools?.[0]).toMatchObject({ status: 'error', error: 'search 需要关键词', preview: 'search 需要关键词' });
  });

  it('pairs stored tool rows and anchors a pending approval', () => {
    const visible = pairToolMessages([
      { id: 'a1', role: 'assistant', content: '我准备创建。', toolCalls: JSON.stringify([{ id: 'call_create', type: 'function', function: { name: 'create_task', arguments: '{"title":"整理文档"}' } }]) },
      { id: 't1', role: 'tool', content: '{"toolName":"list_tasks","success":true,"data":[]}', toolCallId: 'call_other' },
    ], [{ approvalId: 'ap1', toolName: 'create_task', arguments: { title: '整理文档' }, toolCallId: 'call_create' }]);
    expect(visible.some((message) => message.role === 'tool')).toBe(false);
    expect(visible[0]?.tools?.some((tool) => tool.toolCallId === 'call_create' && tool.status === 'pending' && tool.approvalId === 'ap1' && tool.preview === '整理文档')).toBe(true);
  });
});
