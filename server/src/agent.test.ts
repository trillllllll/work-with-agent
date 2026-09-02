import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from './app.js';
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
    process.env.OPENAI_BASE_URL = 'http://mock-openai/v1';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'test-model';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const user = [...(body.messages ?? [])].reverse().find((message: any) => message.role === 'user');
      if (!body.tools) return sseResponse([{ choices: [{ delta: { content: '变更已完成。' }, finish_reason: null }] }]);
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
        const topic = (body.messages ?? []).find((message: any) => message.role === 'system')?.content.match(/topicId":"([^"]+)/)?.[1];
        return sseResponse([
          { choices: [{ delta: { content: '我先读取任务。' }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_list_tasks', function: { name: 'list_tasks' } }] }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ topicId: topic }).slice(0, 10) } }] }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ topicId: topic }).slice(10) } }] }, finish_reason: 'tool_calls' }] },
        ]);
      }
      const title = String(user?.content ?? '').replace(/^创建任务[：:]?\s*/, '') || 'Agent 任务';
      const topic = (body.messages ?? []).find((message: any) => message.role === 'system')?.content.match(/topicId":"([^"]+)/)?.[1];
      return sseResponse([
        { choices: [{ delta: { content: '我准备创建这个任务。' }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_create_task', function: { name: 'create_task' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ topicId: topic, title }).slice(0, 20) } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ topicId: topic, title }).slice(20) } }] }, finish_reason: 'tool_calls' }] },
      ]);
    }));
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
    expect(JSON.parse(String(modelRequest?.body)).tools).toHaveLength(9);
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
    const previous = { base: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL };
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    try {
      const response = await request(app).post('/api/chat').send({ message: '检查配置' });
      expect(response.status).toBe(200);
      expect(response.text).toContain('MODEL_NOT_CONFIGURED');
    } finally {
      process.env.OPENAI_BASE_URL = previous.base;
      process.env.OPENAI_API_KEY = previous.key;
      process.env.OPENAI_MODEL = previous.model;
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

  afterAll(async () => {
    vi.stubGlobal('fetch', originalFetch);
    if (taskId) await prisma.task.delete({ where: { id: taskId } }).catch(() => undefined);
    if (topicId) await prisma.topic.delete({ where: { id: topicId } }).catch(() => undefined);
    await prisma.$disconnect();
  });
});
