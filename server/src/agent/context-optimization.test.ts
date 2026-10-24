import { describe, expect, it } from 'vitest';
import { AgentService, type ModelMessage, type ModelToolDefinition } from '../agent.js';
import { ContextService, replayWindow, type StoredMessage } from '../application/conversation.js';
import { prisma } from '../infrastructure/prisma.js';
import { builtinToolDefinitions } from './capabilities.js';
import { loadedFamilies, toolsForGroups } from './tool-loading.js';
import { buildContextStats, contextTotals } from './context-stats.js';
import { HISTORY_TOKEN_BUDGET, backgroundMessage, messagesTokens, packModelMessages, projectToolContent, textTokens } from './context-budget.js';
import { approveAppChanges, readEnvelope } from './decision.js';
import { resumeRun, scheduleRun } from './runs.js';

const now = () => new Date().toISOString();
const tool = (id: string, name: string, args: object = {}) => ({ id, name, arguments: args });
const agentWith = (stream: (messages: ModelMessage[], signal?: AbortSignal, includeTools?: boolean, tools?: ModelToolDefinition[]) => AsyncGenerator<any>) => new AgentService({ stream } as never);

describe('context optimization contracts', () => {
  it('keeps schemas typed and filters proposal families without losing available domains', () => {
    const base = toolsForGroups(['tasks'], true);
    expect(base.map(t => t.function.name)).not.toContain('propose_changes');
    expect(base.map(t => t.function.name)).not.toContain('present_reply');
    expect(base.map(t => t.function.name)).toEqual(expect.arrayContaining(['load_skill', 'load_tools', 'read_context_source']));
    const writes = toolsForGroups(['library_write', 'memory_write']);
    expect(loadedFamilies(['library_write', 'memory_write'])).toEqual(['library', 'memory']);
    const schema = writes.find(t => t.function.name === 'propose_changes')!.function.parameters as any;
    expect(schema.properties.operations.items.oneOf.map((item: any) => item.properties.family.const)).toEqual(['library', 'memory']);
    expect(textTokens(JSON.stringify(base))).toBeLessThan(textTokens(JSON.stringify(builtinToolDefinitions())) / 2);
  });

  it('preserves the whole current request and call/result pairs while trimming by budget', () => {
    const rows: StoredMessage[] = [];
    for (let i = 0; i < 24; i++) rows.push({ id: `old-${i}`, role: i % 2 ? 'assistant' : 'user', content: `原文${i} ${'历史'.repeat(500)}`, status: 'completed', toolCalls: null, toolCallId: null, compactedAt: null });
    rows.push({ id: 'current', role: 'user', content: '请继续核实，不要修改', status: 'completed', toolCalls: null, toolCallId: null, compactedAt: null });
    rows.push({ id: 'a', role: 'assistant', content: '', status: 'completed', toolCalls: JSON.stringify([{ id: 'c', function: { name: 'query_tasks', arguments: '{}' } }]), toolCallId: null, compactedAt: null });
    rows.push({ id: 't', role: 'tool', content: JSON.stringify({ success: true, data: { id: 'task-one', revision: 3, content: '原文'.repeat(8000) } }), status: 'completed', toolCalls: null, toolCallId: 'c', compactedAt: null });
    const packed = replayWindow(rows, '目标：核实任务。约束：不要修改。[messageId=old-0]');
    expect(messagesTokens(packed)).toBeLessThanOrEqual(HISTORY_TOKEN_BUDGET);
    expect(packed.find(m => m.role === 'tool')?.tool_call_id).toBe('c');
    expect(packed.find(m => m.role === 'tool')?.content).toContain('read_context_source');
    expect(packed.find(m => m.role === 'tool')?.content).toContain('"sourceMessageId":"t"');
    const huge: ModelMessage[] = [{ role: 'system', content: 'rules' }, { role: 'user', content: '保留🧑🏽‍💻'.repeat(4000) }];
    expect(packModelMessages(huge)).toEqual(huge);
    const protectedBackground = [backgroundMessage('用户约束：不要发布。来源 messageId=old-0'), ...huge];
    let repeated = protectedBackground;
    for (let i = 0; i < 8; i++) repeated = packModelMessages(repeated);
    expect(repeated).toEqual(protectedBackground);
    expect(JSON.stringify(repeated)).toContain('不要发布');
    const inRun = packModelMessages([{ role: 'system', content: 'rules' }, ...packed]);
    expect(packModelMessages(inRun)).toEqual(inRun);
    expect(JSON.parse(projectToolContent(rows.at(-1)!.content, 't')).contextProjection).toBe(true);
  });

  it('blocks unloaded writes, loads the schema, then preserves approval and recovery state', async () => {
    let count = 0;
    const approvedTitle = `按需加载批准后创建-${Date.now()}`;
    const observed: string[][] = [];
    const agent = agentWith(async function* (_messages, _signal, _includeTools, tools) {
      observed.push(tools!.map(t => t.function.name));
      count++;
      if (count === 1) { yield { toolCalls: [tool('blocked', 'propose_changes', { summary: '不该执行', operations: [{ family: 'workspace', command: { kind: 'task.create', input: { title: '不得创建' } } }] })] }; return; }
      if (count === 2) { yield { toolCalls: [tool('load', 'load_tools', { groups: ['workspace_write'] })] }; return; }
      if (count === 3) { yield { toolCalls: [tool('proposal', 'propose_changes', { summary: '创建验证任务', operations: [{ family: 'workspace', command: { kind: 'task.create', input: { title: approvedTitle } } }] })] }; return; }
      yield { text: '已收到真实执行结果。' };
    });
    const result = await agent.chat({ message: '读取当前内容', requestKey: `lazy-${Date.now()}` });
    expect(result.events.find(e => e.type === 'tool_result' && e.toolCallId === 'blocked')?.result?.code).toBe('TOOL_NOT_LOADED');
    const approvalId = result.events.find(e => e.type === 'approval_required')?.approvalId;
    expect(approvalId).toBeTruthy();
    expect(await prisma.task.count({ where: { title: '不得创建' } })).toBe(0);
    expect(await prisma.task.count({ where: { title: approvedTitle } })).toBe(0);
    const approval = await prisma.approval.findUniqueOrThrow({ where: { id: approvalId! } });
    const envelope = readEnvelope(approval.result)!;
    await expect(approveAppChanges(approval.id, { expectedProposalRevision: envelope.proposalRevision, previewHash: 'wrong' })).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });
    await approveAppChanges(approval.id, { expectedProposalRevision: envelope.proposalRevision, previewHash: envelope.review.previewHash });
    expect(await prisma.task.count({ where: { title: approvedTitle } })).toBe(1);
    const run = await prisma.agentRun.findFirstOrThrow({ where: { conversationId: result.conversationId! } });
    expect(JSON.parse(run.cursorJson).toolGroups).toContain('workspace_write');
    // Reuse the same run as an approval continuation with the persisted tool set.
    scheduleRun(run.id, async function* (_m, _s, _i, tools) { expect(tools!.some(t => t.function.name === 'propose_changes')).toBe(true); yield { text: '批准后已完成。' }; }, new ContextService());
    for (let i = 0; i < 100; i++) { if ((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).state === 'completed') break; await new Promise(r => setTimeout(r, 10)); }
    const snapshot = await new AgentService().snapshot(result.conversationId!);
    expect(snapshot.contextStats).toBeTruthy();
    expect(snapshot.contextStats.totals.requests).toBeGreaterThanOrEqual(3);
    expect(observed[0]).not.toContain('propose_changes');
    expect(observed[2]).toContain('propose_changes');
  });

  it('reads exact original chunks in the same conversation and denies other conversations', async () => {
    const conversation = await prisma.conversation.create({ data: { createdAt: now(), updatedAt: now() } });
    const original = await prisma.message.create({ data: { conversationId: conversation.id, role: 'tool', content: '原始结果🧑🏽‍💻'.repeat(800), status: 'completed', createdAt: now() } });
    const foreign = await prisma.conversation.create({ data: { createdAt: now(), updatedAt: now() } });
    const foreignMessage = await prisma.message.create({ data: { conversationId: foreign.id, role: 'user', content: '不属于本会话', status: 'completed', createdAt: now() } });
    let round = 0;
    const agent = agentWith(async function* (messages) {
      if (round++ === 0) { yield { toolCalls: [tool('source', 'read_context_source', { messageId: original.id, offset: 20, limit: 1600 }), tool('foreign', 'read_context_source', { messageId: foreignMessage.id })] }; return; }
      const source = messages.find(m => m.role === 'tool' && m.tool_call_id === 'source')!;
      expect(JSON.parse(String(source.content)).data.content).toBe(original.content.slice(20, 1620));
      yield { text: '原文已核对。' };
    });
    const result = await agent.chat({ conversationId: conversation.id, message: '核对原文' });
    const read = result.events.find(e => e.type === 'tool_result' && e.toolCallId === 'source')!.result!.data as any;
    expect(read.content).toBe(original.content.slice(20, 1620));
    expect(read.nextOffset).toBe(1620);
    expect(result.events.find(e => e.type === 'tool_result' && e.toolCallId === 'foreign')!.result!.code).toBe('NOT_FOUND');
    expect((await prisma.message.findUniqueOrThrow({ where: { id: original.id } })).content).toBe(original.content);
    const page = JSON.stringify({ toolName: 'read_context_source', sourceMessageId: 'tool-row', data: { content: original.content.slice(0, 1600), nextOffset: 1600 } });
    const packedPage = packModelMessages([{ role: 'user', content: '续读原文' }, { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_context_source', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'read', content: page }]);
    expect(packedPage.at(-1)?.content).toBe(page);
  });

  it('caps a rolling summary and accounts for its request once, without inventing provider usage', async () => {
    const conversation = await prisma.conversation.create({ data: { createdAt: now(), updatedAt: now() } });
    for (let i = 0; i < 10; i++) await prisma.message.create({ data: { conversationId: conversation.id, role: i % 2 ? 'assistant' : 'user', content: `历史 ${i} ` + '业务原文'.repeat(1000), status: 'completed', createdAt: new Date(Date.now() + i).toISOString() } });
    await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: '当前要求不修改数据', status: 'completed', createdAt: new Date(Date.now() + 20).toISOString() } });
    let calls = 0; const metrics: any[] = [];
    const context = new ContextService({ complete: async () => { calls++; return { text: '已确认约束：不修改。'.repeat(1000) }; } });
    const result = await context.assemble(conversation.id, {}, undefined, async m => { metrics.push(m); });
    expect(messagesTokens(result.messages)).toBeLessThanOrEqual(HISTORY_TOKEN_BUDGET);
    await context.assemble(conversation.id);
    expect(calls).toBe(1); expect(metrics).toHaveLength(1); expect(metrics[0].actual).toBeNull();
    expect(await prisma.message.count({ where: { conversationId: conversation.id } })).toBe(11);
    const row = buildContextStats({ runId: 'stats', round: 0, messages: result.messages, tools: toolsForGroups(['tasks']), fullTools: builtinToolDefinitions(), loadedGroups: ['tasks'] });
    expect(row.categories.reduce((sum, c) => sum + c.tokens, 0)).toBe(row.estimatedInputTokens);
    expect(row.contextWindow).toBeNull();
    const totals = contextTotals([row, { ...row, actual: { inputTokens: 80, outputTokens: 20 } }], metrics);
    expect(totals.requests).toBe(2); expect(totals.actualInputTokens).toBe(80); expect(totals.cachedInputTokens).toBeNull(); expect(totals.usageComplete).toBe(false);
    expect(contextTotals([row]).actualInputTokens).toBeNull();
  });

  it('does not execute a newly loaded family in the same parallel batch', async () => {
    let round = 0;
    const agent = agentWith(async function* () {
      if (round++ === 0) { yield { toolCalls: [
        tool('load-memory', 'load_tools', { groups: ['memory_write'] }),
        tool('same-batch', 'propose_changes', { summary: '同批不能执行', operations: [{ family: 'memory', args: { action: 'add', title: '同批不得创建', content: 'x', target: 'inbox' } }] }),
      ] }; return; }
      yield { text: '下一轮才可使用。' };
    });
    // workspace writes are already offered, so the test exercises family-level
    // gating, not merely the absent tool-name gate.
    const result = await agent.chat({ message: '创建核对任务，但先读取确认范围' });
    expect(result.events.find(e => e.type === 'tool_result' && e.toolCallId === 'same-batch')?.result?.code).toBe('TOOL_NOT_LOADED');
    expect(result.events.some(e => e.type === 'approval_required')).toBe(false);
    expect(await prisma.memory.count({ where: { title: '同批不得创建' } })).toBe(0);
  });

  it('persists provider usage separately from estimates, including reported zero', async () => {
    let round = 0;
    const agent = agentWith(async function* () {
      if (round++ === 0) { yield { usage: { inputTokens: 0, outputTokens: 0, model: 'fixture' }, toolCalls: [tool('time', 'get_time')] }; return; }
      yield { text: '已读取时间。', usage: { inputTokens: 65, outputTokens: 5, cachedInputTokens: 10, model: 'fixture' } };
    });
    const result = await agent.chat({ message: '读取当前时间' });
    const snapshot = await agent.snapshot(result.conversationId!);
    expect(snapshot.contextStats.totals).toMatchObject({ requests: 2, actualInputTokens: 65, actualOutputTokens: 5, cachedInputTokens: null, usageComplete: true });
    const run = await prisma.agentRun.findFirstOrThrow({ where: { conversationId: result.conversationId! } });
    expect(run).toMatchObject({ inputTokens: 65, outputTokens: 5, cachedInputTokens: 10, model: 'fixture' });
  });

  it('keeps the offered schema frozen when recovering midway through a tool batch', async () => {
    const conversation = await prisma.conversation.create({ data: { createdAt: now(), updatedAt: now() } });
    const source = await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: '先核实', status: 'completed', createdAt: now() } });
    const calls = [
      { id: 'load-before-crash', type: 'function', function: { name: 'load_tools', arguments: JSON.stringify({ groups: ['memory_write'] }) } },
      { id: 'write-after-crash', type: 'function', function: { name: 'propose_changes', arguments: JSON.stringify({ summary: '恢复时不应创建', operations: [{ family: 'memory', args: { action: 'add', target: 'inbox', title: '恢复同批不得创建', content: 'x' } }] }) } },
    ];
    const assistant = await prisma.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: '', status: 'completed', toolCalls: JSON.stringify(calls), createdAt: now() } });
    const run = await prisma.agentRun.create({ data: {
      conversationId: conversation.id, sourceUserMessageId: source.id, requestKey: `recover-groups-${Date.now()}`, requestHash: 'fixture', state: 'paused', pauseReason: 'interrupted',
      contextJson: JSON.stringify({ schemaVersion: 2, page: 'inbox', scope: { kind: 'inbox' }, taskId: null, materialId: null, selectedTaskIds: [], taskFilter: null, timeZone: 'Asia/Shanghai', timeZoneSource: 'default', referencedApprovalId: null }),
      cursorJson: JSON.stringify({ schemaVersion: 1, phase: 'tools', round: 0, budgetEndRound: 16, assistantMessageId: assistant.id, nextToolIndex: 1, toolGroups: ['tasks', 'workspace_write', 'memory_write'], offeredToolGroups: ['tasks', 'workspace_write'] }),
      modelMessagesJson: JSON.stringify([{ role: 'user', content: source.content }, { role: 'assistant', content: null, tool_calls: calls }, { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify({ success: true, groups: ['memory_write'] }) }]), createdAt: now(), updatedAt: now(),
    } });
    await resumeRun(run.id, async function* (_m, _s, _i, tools) {
      const offered = tools!.find(t => t.function.name === 'propose_changes')!.function.parameters as any;
      expect(offered.properties.operations.items.oneOf.some((v: any) => v.properties.family.const === 'memory')).toBe(true);
      yield { text: '下一轮已加载，但上批调用没有执行。' };
    }, new ContextService());
    for (let i = 0; i < 100; i++) { if ((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).state === 'completed') break; await new Promise(r => setTimeout(r, 10)); }
    const events = await prisma.agentRunEvent.findMany({ where: { runId: run.id, type: 'tool_result' } });
    expect(JSON.parse(events[0].dataJson).result.code).toBe('TOOL_NOT_LOADED');
    expect(await prisma.approval.count({ where: { runId: run.id } })).toBe(0);
    expect(await prisma.memory.count({ where: { title: '恢复同批不得创建' } })).toBe(0);
  });

  it('restores the latest execution statistics even when an older request finished last', async () => {
    const agent = agentWith(async function* () { yield { text: '已完成。' }; });
    const first = await agent.chat({ message: '第一条请求' });
    await agent.chat({ conversationId: first.conversationId!, message: '第二条请求' });
    const oldStats = first.events.filter(e => e.type === 'context_stats').at(-1)!.contextStats!;
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: oldStats.runId } });
    const resumedStats = { ...oldStats, round: 6 };
    await prisma.$transaction([
      prisma.agentRunEvent.create({ data: { runId: run.id, seq: run.nextEventSeq + 1, type: 'context_stats', dataJson: JSON.stringify({ contextStats: resumedStats }), createdAt: new Date(Date.now() + 1000).toISOString() } }),
      prisma.agentRun.update({ where: { id: run.id }, data: { nextEventSeq: run.nextEventSeq + 1 } }),
    ]);
    const snapshot = await agent.snapshot(first.conversationId!);
    expect(snapshot.contextStats.runId).toBe(run.id);
    expect(snapshot.contextStats.round).toBe(6);
  });
});
