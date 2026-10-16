import { describe, expect, it } from 'vitest';
import request from './test-auth.js';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import { AgentService, type ModelMessage } from './agent.js';
import { chatContextV3, contextFromRequest, validateScopeAndResolveIds, type ChatContextV3 } from './agent/chat-context.js';
import { executeBuiltinTool } from './agent/builtin-tools.js';
import { sourcesFromTool, resolveAssistantSource } from './agent/assistant-sources.js';
import { ContextService } from './application/conversation.js';
import { startChat } from './agent/runs.js';
import { appKnowledge, readPageState } from './agent/app-knowledge.js';
const api = request(app);
const context = (patch: Partial<ChatContextV3> = {}): ChatContextV3 => ({ schemaVersion: 3, page: 'inbox', scope: { kind: 'inbox' }, taskId: null, materialId: null, selectedTaskIds: [], taskFilter: null, timeZone: 'Asia/Shanghai', referencedApprovalId: null, label: '收集箱', section: null, mode: 'follow', taskRevision: null, materialRevision: null, selectedMaterialIds: [], pageState: {}, attachments: [], ...patch });
const execute = (name: string, args: Record<string, unknown>, ctx = context()) => executeBuiltinTool({ name, args, context: contextFromRequest({ context: ctx }), run: { id: '', leaseToken: '', conversationId: '', assistantMessageId: '', sourceUserMessageId: '' }, toolCallId: '' });

describe('global assistant context', () => {
  it('accepts old requests and rejects oversized or unlisted page data without silently truncating', () => {
    expect(contextFromRequest({ pageContext: { page: 'inbox' } }).schemaVersion).toBe(2);
    const { label, section, mode, taskRevision, materialRevision, selectedMaterialIds, pageState, attachments, ...v2 } = context();
    expect(contextFromRequest({ context: { ...v2, schemaVersion: 2 } }).schemaVersion).toBe(2);
    const attachment = { id: 'a', kind: 'draft', title: '草稿', text: '😀'.repeat(20000), unsaved: true };
    expect(chatContextV3.safeParse({ ...context(), attachments: [attachment, { ...attachment, id: 'b' }] }).success).toBe(true);
    expect(chatContextV3.safeParse({ ...context(), attachments: [attachment, attachment, { ...attachment, text: 'x' }] }).success).toBe(false);
    expect(chatContextV3.safeParse({ ...context(), attachments: [{ ...attachment, text: 'a'.repeat(20001) }] }).success).toBe(false);
    expect(chatContextV3.safeParse({ ...context(), pageState: { apiKey: 'should-not-pass' } }).success).toBe(false);
  });
  it('uses real page filters, intersects explicit filters with multiselection, and supports all scope', async () => {
    const topic = (await api.post('/api/topics').send({ name: `assistant-${Date.now()}` })).body.data;
    const a = (await api.post('/api/tasks').send({ topicId: null, title: `assistant-open-${Date.now()}` })).body.data;
    const b = (await api.post('/api/tasks').send({ topicId: null, title: `assistant-done-${Date.now()}` })).body.data;
    await api.patch(`/api/tasks/${b.id}`).send({ status: 'done' });
    const c = (await api.post('/api/tasks').send({ topicId: topic.id, title: `assistant-elsewhere-${Date.now()}` })).body.data;
    const picked = await execute('query_tasks', { action: 'list', status: 'open', limit: 1 }, context({ selectedTaskIds: [a.id, b.id] }));
    expect((picked.data as any).items.map((row: any) => row.id)).toEqual([a.id]);
    const filtered = await execute('query_tasks', { action: 'list' }, context({ taskFilter: { q: a.title, status: 'open' } }));
    expect((filtered.data as any).items.map((row: any) => row.id)).toEqual([a.id]);
    const global = await execute('query_tasks', { action: 'list', scope: 'all', q: c.title }, context({ selectedTaskIds: [a.id], taskFilter: { q: 'not-c' } }));
    expect((global.data as any).items.map((row: any) => row.id)).toEqual([c.id]);
    expect((global.data as any).items[0].topic).toMatchObject({ id: topic.id, name: topic.name });
    expect((picked.data as any).items[0].topic).toBeNull();
    const renamed = `assistant-renamed-${Date.now()}`;
    await api.patch(`/api/topics/${topic.id}`).send({ name: renamed });
    const reread = await execute('query_tasks', { action: 'list', scope: 'all', q: c.title }, context({ selectedTaskIds: [a.id], taskFilter: { q: 'not-c' } }));
    expect((reread.data as any).items[0].topic).toMatchObject({ id: topic.id, name: renamed });
    const next = await validateScopeAndResolveIds(contextFromRequest({ context: context({ taskId: a.id, taskRevision: 999 }) }));
    expect(next.schemaVersion === 3 && next.taskRevision).toBe(a.revision);
  });
  it('persists request context and validated source links through the real run pipeline', async () => {
    let system = '';
    let replayText = '';
    const agent = new AgentService({ stream: async function* (messages: ModelMessage[]) {
      system = String(messages[0].content);
      replayText = JSON.stringify(messages);
      if (messages.some((message) => message.role === 'tool')) { yield { text: '规划支持日周月视图。' }; return; }
      yield { toolCalls: [{ id: 'assistant-help', name: 'read_app_knowledge', arguments: { page: 'plan' } }] };
    } } as never);
    const ctx = context({ page: 'plan', label: '周规划', pageState: { layout: 'week', dateFrom: '2026-10-12', dateTo: '2026-10-18' }, attachments: [{ id: 'draft', kind: 'draft', title: '我的草稿', text: '尚未保存的想法', unsaved: true }] });
    const result = await agent.chat({ message: '规划怎么用', context: ctx });
    expect(replayText).toContain('尚未保存的想法');
    expect(system).toContain('2026-10-18');
    expect(result.events.some((event) => event.type === 'sources' && event.sources?.some((source) => source.kind === 'help' && source.id === 'plan'))).toBe(true);
    const history = await agent.messages(result.conversationId!);
    expect(history.find((message) => message.role === 'user')?.context).toMatchObject(ctx);
    expect(history.flatMap((message) => message.sources)).toContainEqual({ kind: 'help', id: 'plan', title: '规划与时间段' });
    const source = await api.get('/api/v1/assistant/sources/help/plan');
    expect(source.status).toBe(200);
    expect(source.body.data.content).toContain('应用版本');
    expect((await api.get('/api/v1/assistant/sources/task/not-existing')).status).toBe(404);
  });
  it('keeps settings secrets out of page reads and covers every page', async () => {
    const data = await readPageState(contextFromRequest({ context: context({ page: 'settings' }) }));
    expect(JSON.stringify(data)).not.toMatch(/apiKey|tokenHash|openaiBaseUrl/);
    expect(appKnowledge.map((row) => row.id)).toEqual(expect.arrayContaining(['plan', 'focus', 'reviews', 'connections', 'settings', 'library', 'knowledge', 'trash', 'changes']));
    const result = await execute('read_page_state', { apiKey: true });
    expect(result.success).toBe(false);
  });
  it('links memory search results to the actual revision and rejects fabricated sources', async () => {
    const memory = await prisma.memory.create({ data: { kind: 'fact', title: '来源样本', content: '实际保存的记忆', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    expect(await sourcesFromTool('memory_read', { action: 'search' }, { success: true, data: { matches: [memory] } })).toEqual([{ kind: 'memory', id: memory.id, title: memory.title, revision: memory.revision }]);
    expect(await sourcesFromTool('query_tasks', { action: 'list' }, { success: true, data: { items: [{ id: 'made-up', title: '虚构' }] } })).toEqual([]);
    expect(await sourcesFromTool('query_tasks', {}, { success: false, data: { id: memory.id } })).toEqual([]);
    await expect(resolveAssistantSource('memory', memory.id, 999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('freezes the actual saved material version and refreshes only latest-mode contexts', async () => {
    const at = new Date().toISOString();
    const material = await prisma.material.create({ data: { kind: 'text', title: '版本样本', revision: 2, createdAt: at, updatedAt: at, versions: { create: [1, 2].map((revision) => ({ revision, content: `正文${revision}`, contentHash: `hash${revision}`, createdAt: at })) } } });
    const latest = context({ page: 'library', materialId: material.id, materialRevision: 1, materialVersionMode: 'latest', mode: 'pinned' });
    const frozen = await validateScopeAndResolveIds(contextFromRequest({ context: latest }));
    expect(frozen.schemaVersion === 3 && frozen.materialRevision).toBe(2);
    const historical = await validateScopeAndResolveIds(contextFromRequest({ context: { ...latest, materialVersionMode: 'historical' } }));
    expect(historical.schemaVersion === 3 && historical.materialRevision).toBe(1);
    const read = await execute('library_read', { action: 'read', materialId: material.id }, context({ page: 'library', materialId: material.id, materialRevision: 1, materialVersionMode: 'historical' }));
    expect(read.data).toMatchObject({ revision: 2, viewedRevision: 1 });
    const sources = await sourcesFromTool('library_read', { action: 'read', materialId: material.id }, read);
    expect(sources[0]).toMatchObject({ id: material.id, revision: 1 });
  });
  it('uses knowledge page status and scope, and permits explicit global and cross-topic reads', async () => {
    const topic = (await api.post('/api/topics').send({ name: `memory-scope-${Date.now()}` })).body.data;
    const at = new Date().toISOString();
    const memory = await prisma.memory.create({ data: { topicId: topic.id, kind: 'fact', title: '跨清单历史样本', content: '跨清单读取内容', status: 'retired', createdAt: at, updatedAt: at } });
    const ctx = context({ page: 'knowledge', section: 'memories', pageState: { status: 'history', query: memory.title } });
    const inbox = await execute('memory_read', { action: 'search' }, ctx);
    expect((inbox.data as any).matches).toEqual([]);
    const all = await execute('memory_read', { action: 'search', scope: 'all' }, ctx);
    expect((all.data as any).matches.map((row: any) => row.id)).toContain(memory.id);
    const read = await execute('memory_read', { action: 'read', memoryId: memory.id }, ctx);
    expect(read.success).toBe(true);
    expect(JSON.stringify(read.data)).toContain(memory.content);
  });

  it('retries an accepted request with its original snapshot after saved data changes', async () => {
    const task = (await api.post('/api/tasks').send({ title: '重连版本样本', topicId: null })).body.data;
    const input = { message: '解释这个任务', requestKey: `snapshot-retry-${task.id}`, context: context({ taskId: task.id }) };
    const first = await startChat(input);
    await api.patch(`/api/tasks/${task.id}`).send({ title: '版本已更新' });
    const retry = await startChat(input);
    expect(retry.id).toBe(first.id);
    expect(JSON.parse(retry.contextJson).taskRevision).toBe(task.revision);
    await expect(startChat({ ...input, message: '其他请求' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('reads inbox memory by ID and keeps the version displayed by a historical source', async () => {
    const at = new Date().toISOString();
    const memory = await prisma.memory.create({ data: { kind: 'fact', title: '旧记忆来源', content: '新版本事实', revision: 2, createdAt: at, updatedAt: at, versions: { create: { revision: 1, kind: 'fact', title: '旧记忆来源', content: '历史版本事实', status: 'active', health: 'current', evidence: '[]', reason: '旧版', createdAt: at } } } });
    const latest = await execute('memory_read', { action: 'read', memoryId: memory.id });
    expect(latest.data).toMatchObject({ content: '新版本事实', revision: 2 });
    const historical = await execute('memory_read', { action: 'read', memoryId: memory.id }, context({ page: 'knowledge', section: 'memory', pageState: { selectedId: memory.id, selectedRevision: 1 } }));
    expect(historical.data).toMatchObject({ content: '历史版本事实', revision: 1 });
  });

  it('keeps manual attachments in later replay and explicit historical message reads', async () => {
    const first = await startChat({ message: '先看看这个草稿', context: context({ attachments: [{ id: 'draft-followup', kind: 'draft', title: '原草稿', text: '独有的第二段内容', unsaved: true }] }) });
    await startChat({ conversationId: first.conversationId, message: '把刚才草稿第二段改短', context: context() });
    const replay = await new ContextService().assemble(first.conversationId);
    expect(replay.messages.some((row) => row.role === 'user' && row.content?.includes('独有的第二段内容'))).toBe(true);
    const read = await execute('conversation_search', { messageId: first.sourceUserMessageId });
    expect(JSON.stringify(read.data)).toContain('独有的第二段内容');
    const history = await new AgentService().messages(first.conversationId);
    expect(history.find((row) => row.role === 'user')?.context).not.toHaveProperty('timeZoneSource');
  });

});
