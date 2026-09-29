import request from './test-auth.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from './app.js';
import { ContextService } from './application/conversation.js';
import { prisma } from './services.js';

describe('Agent tool gate', () => {
  let topicId = '';
  let taskId = '';
  const originalFetch = globalThis.fetch;

  const sseResponse = (frames: unknown[]) => {
    const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  beforeAll(() => {
    return prisma.appSetting.upsert({ where: { id: 'default' }, create: { id: 'default', openaiBaseUrl: 'http://mock-openai/v1', openaiApiKey: 'test-key', openaiModel: 'test-model', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, update: { openaiBaseUrl: 'http://mock-openai/v1', openaiApiKey: 'test-key', openaiModel: 'test-model', updatedAt: new Date().toISOString() } }).then(() => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const user = [...(body.messages ?? [])].reverse().find((message: any) => message.role === 'user' && !String(message.content ?? '').startsWith('[更早对话的背景'));
      const listedTopic = (body.messages ?? []).find((message: any) => message.role === 'system')?.content.match(/当前清单：([^\n]+)/)?.[1];
      const topic = listedTopic && listedTopic !== '收集箱' ? listedTopic : undefined;
      if (!body.tools) return sseResponse([{ choices: [{ delta: { content: '变更已完成。' }, finish_reason: null }] }]);
      if (String(user?.content ?? '').includes('请记住暗号青鸟')) return sseResponse([{ choices: [{ delta: { content: '已记住青鸟。' }, finish_reason: 'stop' }] }]);
      if (String(user?.content ?? '').includes('暗号是什么')) return sseResponse([{ choices: [{ delta: { content: '暗号是青鸟。' }, finish_reason: 'stop' }] }]);
      if (String(user?.content ?? '').includes('刚才读到了什么')) return sseResponse([{ choices: [{ delta: { content: '接上了上一轮工具结果。' }, finish_reason: 'stop' }] }]);
      if (String(user?.content ?? '').includes('还没批准')) return sseResponse([{ choices: [{ delta: { content: '先等审核。' }, finish_reason: 'stop' }] }]);
      if (String(user?.content ?? '').includes('拒绝之后呢')) return sseResponse([{ choices: [{ delta: { content: '已看到拒绝。' }, finish_reason: 'stop' }] }]);
      if (String(user?.content ?? '').includes('批准之后呢')) return sseResponse([{ choices: [{ delta: { content: '已看到执行结果。' }, finish_reason: 'stop' }] }]);
      if (String(user?.content ?? '').includes('上游错误')) return new Response('mock upstream failure', { status: 503 });
      if (String(user?.content ?? '').includes('未知工具')) return sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_unknown', function: { name: 'missing_tool', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      ]);
      if (String(user?.content ?? '').includes('循环读取')) return sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_loop_${Math.random()}`, function: { name: 'list_tasks', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      ]);
      if (String(user?.content ?? '').includes('列出任务') && (body.messages ?? []).some((message: any) => message.role === 'tool')) {
        return sseResponse([{ choices: [{ delta: { content: '当前任务已读取完成。' }, finish_reason: 'stop' }] }]);
      }
      if (String(user?.content ?? '').includes('列出任务')) {
        return sseResponse([
          { choices: [{ delta: { content: '我先读取任务。' }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_list_tasks', function: { name: 'list_tasks' } }] }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ topicId: topic }).slice(0, 10) } }] }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ topicId: topic }).slice(10) } }] }, finish_reason: 'tool_calls' }] },
        ]);
      }
      const hasToolReply = (body.messages ?? []).some((message: any) => message.role === 'tool');
      const userText = String(user?.content ?? '');
      const systemText = String((body.messages ?? []).find((message: any) => message.role === 'system')?.content ?? '');
      const mentionedMemoryId = userText.match(/记忆id=(\S+)/)?.[1];
      const mentionedRevision = Number(userText.match(/版本=(\d+)/)?.[1] ?? 0);
      const answer = (text: string) => sseResponse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]);
      const tool = (id: string, name: string, args: Record<string, unknown>) => sseResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }]);
      if (userText.includes('读取完整记忆') && hasToolReply) return answer('已读到记忆。');
      if (userText.includes('读取完整记忆')) {
        const memoryId = systemText.match(/id=(\S+)(?: revision=\d+ kind=\w+)? 《完整记忆标题》/)?.[1];
        return tool('call_memory_read', 'memory', { action: 'read', target: 'inbox', memoryId });
      }
      if (userText.includes('空白搜索记忆') && hasToolReply) return answer('已列出记忆。');
      if (userText.includes('空白搜索记忆')) return tool('call_memory_blank', 'memory', { action: 'search', target: 'inbox', q: '' });
      if (userText.includes('搜索溢出记忆') && hasToolReply) return answer('已搜到记忆。');
      if (userText.includes('搜索溢出记忆')) return tool('call_memory_search', 'memory', { action: 'search', target: 'inbox', q: '搜索专用溢出句青鸟' });
      if (userText.includes('记下这句长期记忆')) return tool('call_memory_add', 'memory', { action: 'add', target: 'inbox', title: '待确认记忆', content: '还没批准的事实' });
      if (userText.includes('批准这条长期记忆')) return tool('call_memory_keep', 'memory', { action: 'add', target: 'inbox', title: '长期记忆标题', content: '本地只用一种数据库' });
      if (userText.includes('再记一次同样的长期记忆')) return tool('call_memory_dup', 'memory', { action: 'add', target: 'inbox', title: '长期记忆标题', content: '本地只用一种数据库' });
      if (userText.includes('替换这条记忆')) return tool('call_memory_replace', 'memory', { action: 'replace', target: 'topic', memoryId: mentionedMemoryId, expectedRevision: mentionedRevision, title: '新标题', content: '新正文' });
      if (userText.includes('改到另一清单')) return tool('call_memory_other', 'memory', { action: 'replace', target: 'topic', memoryId: mentionedMemoryId, expectedRevision: 1, title: '越权标题', content: '越权正文' });
      if (userText.includes('退役另一清单')) return tool('call_memory_remove_other', 'memory', { action: 'remove', target: 'topic', memoryId: mentionedMemoryId, expectedRevision: 1 });
      if (userText.includes('退役版本不对')) return tool('call_memory_remove', 'memory', { action: 'remove', target: 'topic', memoryId: mentionedMemoryId, expectedRevision: 99 });
      if (userText.includes('没有清单却写清单记忆')) return tool('call_memory_nolist', 'memory', { action: 'add', target: 'topic', title: '不该写入', content: '没有清单' });
      if (userText.includes('查找历史原句') && hasToolReply) return answer('已找到原句。');
      if (userText.includes('查找历史原句')) return tool('call_history', 'conversation_search', { q: '独特青鸟原句' });
      const title = String(user?.content ?? '').replace(/^创建任务[：:]?\s*/, '') || 'Agent 任务';
      return sseResponse([
        { choices: [{ delta: { content: '我准备创建这个任务。' }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_create_task', function: { name: 'create_task' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ topicId: topic, title }).slice(0, 20) } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ topicId: topic, title }).slice(20) } }] }, finish_reason: 'tool_calls' }] },
      ]);
    }));
    });
  });

  it('requires approval before creating a task', async () => {
    const topic = await request(app).post('/api/topics').send({ name: `Agent 测试-${Date.now()}`, isExploration: true });
    topicId = topic.body.data.id;
    const response = await request(app).post('/api/chat').send({ message: '创建任务：通过审核后创建', pageContext: { topicId, page: 'board' } });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = response.text.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      return { event, ...(data ? JSON.parse(data) : {}) };
    });
    const modelRequest = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(modelRequest?.body)).tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: 'create_task' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'list_tasks' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'memory' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'conversation_search' }) }),
    ]));
    expect(events.some((event) => event.event === 'message_delta' && event.delta?.includes('我准备创建'))).toBe(true);
    expect(events.some((event) => event.event === 'approval_required')).toBe(true);
    const approval = events.find((event) => event.event === 'approval_required')!;
    const before = await request(app).get(`/api/tasks?topicId=${topicId}`);
    expect(before.body.data).toHaveLength(0);
    const approved = await request(app).post(`/api/agent/approvals/${approval.approvalId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.data.result.success).toBe(true);
    expect(approved.body.data.assistantMessage).toContain('变更已完成');
    const after = await request(app).get(`/api/tasks?topicId=${topicId}`);
    expect(after.body.data).toHaveLength(1);
    taskId = after.body.data[0].id;
  });

  it('executes read-only tools and continues with a final model answer', async () => {
    const response = await request(app).post('/api/chat').send({ message: '列出任务', pageContext: { topicId, page: 'board' } });
    expect(response.status).toBe(200);
    expect(response.text).toContain('event: tool_result');
    expect(response.text).toContain('当前任务已读取完成');
    expect(response.text).toContain('event: done');
    const calls = vi.mocked(globalThis.fetch).mock.calls.slice(-2).map((call) => JSON.parse(String(call[1]?.body)));
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.some((message: any) => message.role === 'assistant' && message.tool_calls?.[0]?.function?.name === 'list_tasks')).toBe(true);
    expect(calls[1].messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'call_list_tasks')).toBe(true);
  });

  it('returns a clear error when the model is not configured', async () => {
    const previous = await prisma.appSetting.findUnique({ where: { id: 'default' } });
    await prisma.appSetting.delete({ where: { id: 'default' } });
    try {
      const response = await request(app).post('/api/chat').send({ message: '检查配置' });
      expect(response.status).toBe(200);
      expect(response.text).toContain('MODEL_NOT_CONFIGURED');
    } finally {
      if (previous) await prisma.appSetting.create({ data: previous });
    }
  });

  it('rejects upstream and invalid tool responses without changing data', async () => {
    const before = await request(app).get(`/api/tasks?topicId=${topicId}`);
    const upstream = await request(app).post('/api/chat').send({ message: '上游错误' });
    expect(upstream.text).toContain('MODEL_HTTP_ERROR');
    const upstreamEvent = JSON.parse(upstream.text.match(/data: (.+)/)?.[1] ?? '{}');
    const upstreamMessages = await request(app).get(`/api/conversations/${upstreamEvent.conversationId}/messages`);
    expect(upstreamMessages.body.data.at(-1).status).toBe('failed');

    const unknown = await request(app).post('/api/chat').send({ message: '未知工具' });
    expect(unknown.text).toContain('UNKNOWN_TOOL');
    const after = await request(app).get(`/api/tasks?topicId=${topicId}`);
    expect(after.body.data).toHaveLength(before.body.data.length);
  });

  it('stops read-only tool loops at eight rounds', async () => {
    const response = await request(app).post('/api/chat').send({ message: '循环读取', pageContext: { topicId, page: 'board' } });
    expect(response.text).toContain('TOOL_ROUND_LIMIT');
    expect((response.text.match(/event: tool_result/g) ?? [])).toHaveLength(8);
  });

  it('restores conversation messages and pending approvals', async () => {
    const response = await request(app).post('/api/chat').send({ message: '创建任务：恢复测试', pageContext: { topicId, page: 'board' } });
    const messageStart = response.text.match(/event: message_start\ndata: (.+)/)?.[1];
    const restoredConversationId = messageStart ? JSON.parse(messageStart).conversationId : '';
    expect(restoredConversationId).toBeTruthy();
    const messages = await request(app).get(`/api/conversations/${restoredConversationId}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body.data.some((item: any) => item.role === 'user')).toBe(true);
    const pending = await request(app).get('/api/agent/approvals?status=pending');
    expect(pending.status).toBe(200);
    const approval = pending.body.data.find((item: any) => item.status === 'pending' && item.conversationId === restoredConversationId);
    expect(approval).toBeTruthy();
    expect(approval.conversationId).toBe(restoredConversationId);
  });

  it('returns 404 when the stored conversation no longer exists', async () => {
    const missing = await request(app).get('/api/conversations/missing-conversation/messages');
    expect(missing.status).toBe(404);
  });

  function conversationIdFrom(responseText: string) {
    const messageStart = responseText.match(/event: message_start\ndata: (.+)/)?.[1];
    return messageStart ? JSON.parse(messageStart).conversationId as string : '';
  }

  function modelRequestFor(text: string) {
    const calls = vi.mocked(globalThis.fetch).mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    return [...calls].reverse().find((body) => [...(body.messages ?? [])].reverse().find((message: { role?: string; content?: string }) => message.role === 'user' && !String(message.content ?? '').startsWith('[更早对话的背景'))?.content?.includes(text));
  }

  function approvalIdFrom(responseText: string) {
    const frame = responseText.split(/\r?\n\r?\n/).find((item) => item.includes('event: approval_required'));
    const data = frame?.match(/^data: (.+)$/m)?.[1];
    return data ? JSON.parse(data).approvalId as string : '';
  }

  function expectPairedToolCalls(body: { messages: Array<{ role?: string; tool_calls?: Array<{ id?: string }>; tool_call_id?: string }> }) {
    body.messages.forEach((message, index) => {
      (message.tool_calls ?? []).forEach((call, offset) => {
        expect(body.messages[index + 1 + offset]).toMatchObject({ role: 'tool', tool_call_id: call.id });
      });
    });
  }

  it('replays the previous turn in the next model request', async () => {
    const first = await request(app).post('/api/chat').send({ message: '请记住暗号青鸟', pageContext: { topicId, page: 'board' } });
    const conversationId = conversationIdFrom(first.text);
    expect(conversationId).toBeTruthy();
    await request(app).post('/api/chat').send({ conversationId, message: '暗号是什么', pageContext: { topicId, page: 'board', taskId } });
    const body = modelRequestFor('暗号是什么');
    expect(body.messages[0].content).toContain(`当前清单：${topicId}`);
    expect(body.messages[0].content).toContain(`正在查看的任务：${taskId}`);
    expect(body.messages[0].content).not.toContain('recentMessages');
    expect(body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: '请记住暗号青鸟' }),
      expect.objectContaining({ role: 'assistant', content: '已记住青鸟。' }),
    ]));
  });

  it('replays tool results with their tool call id on the next turn', async () => {
    const first = await request(app).post('/api/chat').send({ message: '列出任务', pageContext: { topicId, page: 'board' } });
    const conversationId = conversationIdFrom(first.text);
    await request(app).post('/api/chat').send({ conversationId, message: '刚才读到了什么', pageContext: { topicId, page: 'board' } });
    const body = modelRequestFor('刚才读到了什么');
    const assistant = body.messages.find((message: { role?: string; tool_calls?: Array<{ id?: string }> }) => message.tool_calls?.some((call) => call.id === 'call_list_tasks'));
    const toolAt = body.messages.findIndex((message: { role?: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'call_list_tasks');
    const assistantAt = body.messages.indexOf(assistant);
    expect(assistantAt).toBe(toolAt - 1);
    expect(body.messages[toolAt].content).toContain('通过审核后创建');
    expect(body.messages[0].content).not.toContain('recentMessages');
  });

  it('does not replay a write until it has a tool result', async () => {
    const first = await request(app).post('/api/chat').send({ message: '创建任务：待审核事项', pageContext: { topicId, page: 'board' } });
    const conversationId = conversationIdFrom(first.text);
    expect(approvalIdFrom(first.text)).toBeTruthy();
    await request(app).post('/api/chat').send({ conversationId, message: '还没批准', pageContext: { topicId, page: 'board' } });
    const body = modelRequestFor('还没批准');
    expect(body.messages.some((message: { tool_calls?: unknown[] }) => message.tool_calls?.length)).toBe(false);
    expectPairedToolCalls(body);
  });

  it('replays a rejected write beside the original tool call', async () => {
    const first = await request(app).post('/api/chat').send({ message: '创建任务：拒绝这条', pageContext: { topicId, page: 'board' } });
    const conversationId = conversationIdFrom(first.text);
    const rejected = await request(app).post(`/api/agent/approvals/${approvalIdFrom(first.text)}/reject`);
    expect(rejected.status).toBe(200);
    await request(app).post('/api/chat').send({ conversationId, message: '拒绝之后呢', pageContext: { topicId, page: 'board' } });
    const body = modelRequestFor('拒绝之后呢');
    expectPairedToolCalls(body);
    const tool = body.messages.find((message: { role?: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'call_create_task');
    expect(tool.content).toContain('用户拒绝，数据未修改');
  });

  it('replays an approved write beside the original tool call', async () => {
    const first = await request(app).post('/api/chat').send({ message: '创建任务：批准后可见', pageContext: { topicId, page: 'board' } });
    const conversationId = conversationIdFrom(first.text);
    const approved = await request(app).post(`/api/agent/approvals/${approvalIdFrom(first.text)}/approve`);
    expect(approved.status).toBe(200);
    await request(app).post('/api/chat').send({ conversationId, message: '批准之后呢', pageContext: { topicId, page: 'board' } });
    const body = modelRequestFor('批准之后呢');
    expectPairedToolCalls(body);
    const tool = body.messages.find((message: { role?: string; tool_call_id?: string; content?: string }) => message.role === 'tool' && message.tool_call_id === 'call_create_task');
    expect(tool.content).toContain('"success":true');
  });

  it('keeps a fallback summary when compaction fails and does not split a tool pair', async () => {
    let calls = 0;
    const context = new ContextService({ complete: async () => { calls += 1; throw new Error('summary down'); } });
    const filler = '早期内容'.repeat(800);
    const toolCalls = JSON.stringify([{ id: 'call_boundary', type: 'function', function: { name: 'list_tasks', arguments: '{}' } }]);
    const rows: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; toolCalls?: string; toolCallId?: string }> = [
      { role: 'user', content: '头一' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '头二' },
      { role: 'assistant', content: '答二' },
    ];
    for (let index = 0; index < 12; index += 1) {
      rows.push({ role: 'user', content: `填充${index}${filler}` }, { role: 'assistant', content: `回应${index}` });
    }
    rows.push(
      { role: 'user', content: '请读取' },
      { role: 'assistant', content: '我先读', toolCalls },
      { role: 'tool', content: JSON.stringify({ toolName: 'list_tasks', success: true, data: [{ title: '边界任务甲' }] }), toolCallId: 'call_boundary' },
      { role: 'assistant', content: '读完边界任务甲' },
      { role: 'user', content: '边界一' },
      { role: 'assistant', content: '甲一' },
      { role: 'user', content: '边界二' },
      { role: 'assistant', content: '甲二' },
      { role: 'user', content: '边界三' },
      { role: 'assistant', content: '甲三' },
    );
    const timestamp = new Date().toISOString();
    const conversation = await prisma.conversation.create({ data: { createdAt: timestamp, updatedAt: timestamp } });
    try {
      for (const [index, row] of rows.entries()) {
        await prisma.message.create({ data: { conversationId: conversation.id, role: row.role, content: row.content, status: 'completed', toolCalls: row.toolCalls ?? null, toolCallId: row.toolCallId ?? null, createdAt: new Date(Date.now() + index).toISOString() } });
      }
      const assembled = await context.assemble(conversation.id, { page: 'inbox' });
      const summaryAt = assembled.messages.findIndex((message) => String(message.content ?? '').includes('更早对话的背景'));
      const assistantAt = assembled.messages.findIndex((message) => message.tool_calls?.some((call) => call.id === 'call_boundary'));
      const toolAt = assembled.messages.findIndex((message) => message.role === 'tool' && message.tool_call_id === 'call_boundary');
      expect(summaryAt).toBeGreaterThan(-1);
      expect(assistantAt).toBe(toolAt - 1);
      expect(summaryAt).toBeLessThan(assistantAt);
      expect(assembled.systemPrompt).toContain('当前清单：收集箱');
      expect(assembled.systemPrompt).not.toContain('recentMessages');
      const stored = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(stored.summary).toContain('用户：');
      expect(await prisma.message.count({ where: { conversationId: conversation.id, compactedAt: { not: null } } })).toBeGreaterThan(0);
      expect((await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).compactedAt).toBeNull();
      expect((await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })).compactedAt).toBeNull();
      await context.assemble(conversation.id, { page: 'inbox' });
      expect(calls).toBe(1);
    } finally {
      await prisma.conversation.delete({ where: { id: conversation.id } }).catch(() => undefined);
    }
  });

  async function proposalCommands(responseText: string) {
    const approvalId = approvalIdFrom(responseText);
    const approval = await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } });
    const link = JSON.parse(approval.result ?? '{}') as { proposalId: string };
    const proposal = await prisma.proposal.findUniqueOrThrow({ where: { id: link.proposalId } });
    return { approvalId, commands: JSON.parse(proposal.commands) as Array<{ kind: string; entityId?: string; input: { title?: string; content?: string; evidence?: Array<{ type: string; id: string; revision: number }> } }> };
  }

  it('reads a memory immediately and returns the part left out of the prompt', async () => {
    const suffix = '读到的完整后缀';
    await prisma.memory.create({ data: { id: 'agent-memory-read', topicId: null, kind: 'fact', title: '完整记忆标题', content: `${'甲'.repeat(400)}${suffix}`, importance: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    const response = await request(app).post('/api/chat').send({ message: '读取完整记忆', pageContext: { page: 'inbox' } });
    expect(response.status).toBe(200);
    expect(response.text).toContain('event: tool_result');
    expect(response.text).toContain(suffix);
    expect(response.text).toContain('已读到记忆');
    expect(response.text).not.toContain('event: approval_required');
    const system = modelRequestFor('读取完整记忆').messages.find((message: { role?: string }) => message.role === 'system').content as string;
    expect(system).toContain('完整记忆标题');
    expect(system).not.toContain(suffix);
  });

  it('lists memories when search is called without a keyword', async () => {
    const response = await request(app).post('/api/chat').send({ message: '空白搜索记忆', pageContext: { page: 'inbox' } });
    expect(response.text).toContain('event: tool_result');
    expect(response.text).toContain('已列出记忆');
    expect(response.text).not.toContain('INVALID_TOOL_ARGUMENTS');
    expect(response.text).not.toContain('event: error');
  });

  it('searches memories that are outside the visible block', async () => {
    await prisma.memory.create({ data: { id: 'agent-memory-search', topicId: null, kind: 'fact', title: '搜索标题', content: `搜索专用溢出句青鸟${'隐'.repeat(280)}`, importance: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    const response = await request(app).post('/api/chat').send({ message: '搜索溢出记忆', pageContext: { page: 'inbox' } });
    expect(response.text).toContain('搜索专用溢出句青鸟');
    expect(response.text).toContain('已搜到记忆');
    expect(response.text).not.toContain('event: approval_required');
  });

  it('keeps a memory add pending and cites the chat in the same proposal', async () => {
    const response = await request(app).post('/api/chat').send({ message: '记下这句长期记忆', pageContext: { page: 'inbox' } });
    expect(response.text).toContain('event: approval_required');
    expect(await prisma.memory.findFirst({ where: { title: '待确认记忆' } })).toBeNull();
    expect(await prisma.material.findFirst({ where: { title: { contains: '待确认记忆' } } })).toBeNull();
    const { approvalId, commands } = await proposalCommands(response.text);
    const material = commands.find((command) => command.kind === 'material.create');
    const memory = commands.find((command) => command.kind === 'memory.create');
    expect(material?.entityId).toBeTruthy();
    expect(memory?.input.evidence?.[0]).toMatchObject({ type: 'material', id: material?.entityId, revision: 1 });
    expect(memory?.input.content).toBe('还没批准的事实');
    const preview = await request(app).post(`/api/agent/approvals/${approvalId}/preview`);
    expect(preview.status).toBe(200);
    const previewText = JSON.stringify(preview.body);
    expect(previewText).toContain('还没批准的事实');
    expect(previewText).toContain('记下这句长期记忆');
  });

  it('records a rejection without writing the memory', async () => {
    const response = await request(app).post('/api/chat').send({ message: '记下这句长期记忆', pageContext: { page: 'inbox' } });
    const rejected = await request(app).post(`/api/agent/approvals/${approvalIdFrom(response.text)}/reject`);
    expect(rejected.status).toBe(200);
    const messages = await request(app).get(`/api/conversations/${conversationIdFrom(response.text)}/messages`);
    expect(messages.body.data.some((item: { role: string; content: string }) => item.role === 'tool' && item.content.includes('用户拒绝，数据未修改'))).toBe(true);
    expect(await prisma.memory.findFirst({ where: { title: '待确认记忆' } })).toBeNull();
  });

  it('applies an approved memory with the chat excerpt as evidence and rejects a duplicate', async () => {
    const response = await request(app).post('/api/chat').send({ message: '批准这条长期记忆', pageContext: { page: 'inbox' } });
    const approved = await request(app).post(`/api/agent/approvals/${approvalIdFrom(response.text)}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.data.result.success).toBe(true);
    const saved = approved.body.data.result.data;
    expect(saved.kind).toBe('fact');
    expect(saved.origin).toBe('ai');
    const material = await prisma.material.findUniqueOrThrow({ where: { id: saved.evidence[0].id } });
    expect(material.kind).toBe('thread');
    const version = await prisma.materialVersion.findFirstOrThrow({ where: { materialId: material.id } });
    expect(version.content).toContain('批准这条长期记忆');
    const row = await prisma.memory.findFirstOrThrow({ where: { title: '长期记忆标题' } });
    expect(row.origin).toBe('ai');
    expect(row.content).toBe('本地只用一种数据库');

    const duplicate = await request(app).post('/api/chat').send({ message: '再记一次同样的长期记忆', pageContext: { page: 'inbox' } });
    expect(duplicate.text).toContain('完全相同的记忆已经存在');
    expect(duplicate.text).not.toContain('event: error');
    expect(await prisma.memory.count({ where: { title: '长期记忆标题', content: '本地只用一种数据库' } })).toBe(1);
  });

  it('prepares a replacement without changing the memory before approval', async () => {
    const timestamp = new Date().toISOString();
    const row = await prisma.memory.create({ data: { id: 'agent-memory-replace', topicId, kind: 'fact', title: '旧标题', content: '旧正文', createdAt: timestamp, updatedAt: timestamp } });
    const response = await request(app).post('/api/chat').send({ message: `替换这条记忆 记忆id=${row.id} 版本=1`, pageContext: { topicId, page: 'board' } });
    expect(response.text).toContain('event: approval_required');
    const stored = await prisma.memory.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({ title: '旧标题', content: '旧正文', revision: 1 });
    const { commands } = await proposalCommands(response.text);
    expect(commands.map((command) => command.kind)).toEqual(['material.create', 'memory.update']);
    expect(commands[1]?.input).toMatchObject({ title: '新标题', content: '新正文' });
    expect(await prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ content: '旧正文' });
  });

  it('refuses to edit a memory outside the open list', async () => {
    const timestamp = new Date().toISOString();
    const other = await prisma.topic.create({ data: { name: '另一清单', createdAt: timestamp, updatedAt: timestamp } });
    const row = await prisma.memory.create({ data: { id: 'agent-memory-other', topicId: other.id, kind: 'fact', title: '另一处标题', content: '另一处正文', createdAt: timestamp, updatedAt: timestamp } });
    const replaced = await request(app).post('/api/chat').send({ message: `改到另一清单 记忆id=${row.id}`, pageContext: { topicId, page: 'board' } });
    expect(replaced.text).toContain('这条记忆不属于当前范围');
    expect(replaced.text).not.toContain('event: error');
    const removed = await request(app).post('/api/chat').send({ message: `退役另一清单 记忆id=${row.id}`, pageContext: { topicId, page: 'board' } });
    expect(removed.text).toContain('这条记忆不属于当前范围');
    expect(await prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ title: '另一处标题', content: '另一处正文', status: 'active', revision: 1 });
  });

  it('refuses a stale revision and a topic memory when no list is open', async () => {
    const timestamp = new Date().toISOString();
    const row = await prisma.memory.create({ data: { id: 'agent-memory-version', topicId, kind: 'fact', title: '版本标题', content: '版本正文', createdAt: timestamp, updatedAt: timestamp } });
    const stale = await request(app).post('/api/chat').send({ message: `退役版本不对 记忆id=${row.id}`, pageContext: { topicId, page: 'board' } });
    expect(stale.text).toContain('记忆版本不一致，请先 read 再修改');
    expect(stale.text).not.toContain('event: error');
    expect(await prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ content: '版本正文', status: 'active', revision: 1 });
    const missingList = await request(app).post('/api/chat').send({ message: '没有清单却写清单记忆', pageContext: { page: 'inbox' } });
    expect(missingList.text).toContain('没有打开清单，不能使用清单记忆');
    expect(missingList.text).not.toContain('event: approval_required');
    const messages = await request(app).get(`/api/conversations/${conversationIdFrom(missingList.text)}/messages`);
    expect(messages.body.data.find((item: { role: string }) => item.role === 'assistant').status).toBe('completed');
    expect(await prisma.memory.findFirst({ where: { title: '不该写入' } })).toBeNull();
  });

  it('finds an original sentence in another conversation without editing it', async () => {
    const timestamp = new Date().toISOString();
    const older = await prisma.conversation.create({ data: { createdAt: timestamp, updatedAt: timestamp } });
    const kept = '独特青鸟原句在另一段对话';
    const message = await prisma.message.create({ data: { conversationId: older.id, role: 'assistant', content: kept, status: 'completed', createdAt: timestamp } });
    const response = await request(app).post('/api/chat').send({ message: '查找历史原句', pageContext: { page: 'inbox' } });
    expect(response.text).toContain('独特青鸟原句');
    expect(response.text).toContain('已找到原句');
    expect(response.text).not.toContain('event: approval_required');
    expect((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).content).toBe(kept);
    await prisma.conversation.delete({ where: { id: older.id } });
  });

  afterAll(async () => {
    vi.stubGlobal('fetch', originalFetch);
    if (taskId) await prisma.task.delete({ where: { id: taskId } }).catch(() => undefined);
    if (topicId) await prisma.topic.delete({ where: { id: topicId } }).catch(() => undefined);
    await prisma.appSetting.deleteMany();
    await prisma.$disconnect();
  });
});
