import type { ModelToolDefinition } from './agent.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentService, type ModelMessage } from './agent.js';
import { builtinSystemPrompt } from './agent/capabilities.js';
import { initialToolGroups, isGroupAllowedFor, systemPromptFor, toolsForGroups } from './agent/tool-loading.js';
import { registerLearningCommands } from './application/learning-commands.js';
import { SettingsService } from './application/settings.js';
import { prisma } from './infrastructure/prisma.js';
import { runAgentMemoryTool } from './application/agent-memory.js';
import { executeBuiltinTool } from './agent/builtin-tools.js';
import { relayPathAllowed } from './application/workspace-relay.js';
import { contextFromRequest } from './agent/chat-context.js';
import type { ToolCall } from './application/workspace.js';

registerLearningCommands();

let seq = 0;
const stamp = () => `学习身份-${Date.now()}-${seq += 1}`;

type ReviewEvent = { approvalId: string; proposalRevision?: number; previewHash?: string; review?: { entities: Array<{ entityType: string; operation?: string }> } };
type Decision = { outcome?: { status: string; changeId: string | null; code?: string; message?: string } };
type ProposeParameters = { properties: { operations: { items: { oneOf: Array<{ properties: { family: { const: string } } }> } } } };

function agentFor(script: (messages: ModelMessage[], tools?: ModelToolDefinition[]) => { text?: string; toolCalls?: ToolCall[] }) {
  return new AgentService({
    stream: async function* (messages: ModelMessage[], _signal?: AbortSignal, _includeTools?: boolean, tools?: ModelToolDefinition[]) {
      const delta = script(messages, tools);
      if (delta.text) yield { text: delta.text };
      if (delta.toolCalls?.length) yield { toolCalls: delta.toolCalls };
    },
  } as never);
}

function latestUser(messages: ModelMessage[]) {
  return String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');
}

function proposeScript(phrase: string, operations: unknown[], summary: string) {
  return (messages: ModelMessage[]) => {
    if (messages.some((message) => message.role === 'tool')) return { text: '已处理。' };
    if (!latestUser(messages).includes(phrase)) return { text: '好的。' };
    return { text: '我准备修改。', toolCalls: [{ id: `call-${phrase}`, name: 'propose_changes', arguments: { summary, operations } }] };
  };
}

function approvalFrom(events: Array<{ type: string }>) {
  const event = events.find((item) => item.type === 'approval_required') as ReviewEvent | undefined;
  expect(event?.approvalId, JSON.stringify(events)).toBeTruthy();
  return event!;
}

function toolResult(events: Array<{ type: string; toolName?: string; result?: unknown }>, name: string) {
  return events.find((event) => event.type === 'tool_result' && event.toolName === name);
}

describe('assistant identities', () => {
  afterEach(async () => {
    await prisma.learningActivity.deleteMany();
    await prisma.learningNode.deleteMany();
    await prisma.learningMap.deleteMany();
  });

  it('scopes tools, prompts and write families by identity', () => {
    const workTools = toolsForGroups(['tasks', 'library', 'memory', 'orchestration', 'media', 'workspace_write', 'library_write', 'memory_write', 'skill_write'], false, 'work').map((tool) => tool.function.name);
    expect(workTools).toContain('query_tasks');
    expect(workTools).toContain('library_read');
    expect(workTools).not.toContain('learning_read');

    const studyTools = toolsForGroups(['tasks', 'library', 'learning', 'learning_write', 'media', 'workspace_write'], false, 'study').map((tool) => tool.function.name);
    expect(studyTools).toContain('learning_read');
    expect(studyTools).toContain('propose_changes');
    expect(studyTools).not.toContain('query_tasks');
    expect(studyTools).not.toContain('library_read');
    expect(studyTools).not.toContain('search_workspace');

    expect(isGroupAllowedFor('study', 'tasks')).toBe(false);
    expect(isGroupAllowedFor('study', 'learning_write')).toBe(true);
    expect(isGroupAllowedFor('work', 'learning')).toBe(false);
    expect(initialToolGroups('帮我把 Rust 整理成学习地图', 'learning', 'study')).toEqual(expect.arrayContaining(['learning', 'learning_write']));

    const studyPrompt = systemPromptFor('study');
    expect(studyPrompt).toContain('你是 Dovun 的学习助手');
    expect(studyPrompt).toContain('learning_read');
    expect(studyPrompt).not.toContain('query_tasks');
    expect(builtinSystemPrompt()).toContain('你是 Dovun 的内置工作助手');
    expect(builtinSystemPrompt()).not.toContain('你是 Dovun 的学习助手');

    const propose = toolsForGroups(['learning_write'], false, 'study').find((tool) => tool.function.name === 'propose_changes')!;
    const parameters = propose.function.parameters as ProposeParameters;
    const families = parameters.properties.operations.items.oneOf.map((variant) => variant.properties.family.const);
    expect(families).toEqual(['learning']);
  });

  it('loads media for interactive learning simulations and keeps simulation guidance study-only', () => {
    expect(initialToolGroups('做一个光的折射模拟器，用参数实验和互动自测讲解', 'learning', 'study')).toContain('media');
    const studyPrompt = systemPromptFor('study');
    expect(studyPrompt).toContain('【可视化模拟与知识互动】');
    expect(studyPrompt).toContain('“××模拟器”');
    expect(studyPrompt).toContain('简化模型要注明“简化模拟”及关键假设');
    expect(studyPrompt).toContain('保存学习进度、掌握度或学习动态仍须另行通过 propose_changes 生成待确认方案');
    expect(builtinSystemPrompt()).not.toContain('【可视化模拟与知识互动】');
  });

  it('isolates conversation search and original message reads in both directions', async () => {
    const phrase = stamp();
    const conversations: Array<{ id: string; identityId: string; messageId: string }> = [];
    try {
      for (const identityId of ['work', 'study']) {
        const conversation = await prisma.conversation.create({ data: { identityId, createdAt: '2026-10-26', updatedAt: '2026-10-26' } });
        const message = await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: `${phrase}-${identityId}`, status: 'completed', createdAt: '2026-10-26' } });
        conversations.push({ ...conversation, messageId: message.id });
      }
      for (const own of conversations) {
        const other = conversations.find((row) => row.id !== own.id)!;
        const found = await runAgentMemoryTool({ name: 'conversation_search', arguments: { q: phrase } }, { identityId: own.identityId });
        expect(found.success).toBe(true);
        expect(JSON.stringify(found.data)).toContain(own.messageId);
        expect(JSON.stringify(found.data)).not.toContain(other.messageId);
        const denied = await runAgentMemoryTool({ name: 'conversation_search', arguments: { messageId: other.messageId } }, { identityId: own.identityId });
        expect(denied).toMatchObject({ success: false, code: 'NOT_FOUND' });
        const context = { ...contextFromRequest({}), identityId: own.identityId as 'work' | 'study' };
        const call = (messageId: string) => executeBuiltinTool({ name: 'conversation_search', args: { messageId }, context, run: { id: '', leaseToken: '', conversationId: own.id, assistantMessageId: '', sourceUserMessageId: '' }, toolCallId: 'identity-original' });
        expect(await call(other.messageId)).toMatchObject({ success: false, code: 'NOT_FOUND' });
        expect(await call(own.messageId)).toMatchObject({ success: true });
      }
    } finally {
      await prisma.message.deleteMany({ where: { conversationId: { in: conversations.map((row) => row.id) } } });
      await prisma.conversation.deleteMany({ where: { id: { in: conversations.map((row) => row.id) } } });
    }
  });

  it('routes learning map reads to the shared workspace without allowing adjacent namespaces', () => {
    expect(relayPathAllowed('/api/v1/learning/maps')).toBe(true);
    expect(relayPathAllowed('/api/v1/learning/maps/map-id')).toBe(true);
    expect(relayPathAllowed('/api/v1/learning-other/maps')).toBe(false);
  });

  it('offers activity kinds accepted by learning proposals', () => {
    const tool = toolsForGroups(['learning_write'], false, 'study').find((entry) => entry.function.name === 'propose_changes')!;
    const schema = tool.function.parameters as any;
    const learning = schema.properties.operations.items.oneOf.find((entry: any) => entry.properties.family.const === 'learning');
    expect(learning.properties.args.properties.kind.enum).toEqual(expect.arrayContaining(['topic', 'item', 'session', 'status', 'note']));
  });

  it('keeps a study conversation in the learning domain and hides work context', async () => {
    const observed: Array<{ system: string; tools: string[] }> = [];
    let asked = false;
    const agent = agentFor((messages, tools) => {
      if (!asked) {
        asked = true;
        observed.push({ system: String(messages.find((message) => message.role === 'system')?.content ?? ''), tools: (tools ?? []).map((tool) => tool.function.name) });
        return { toolCalls: [{ id: 'read-map', name: 'learning_read', arguments: { action: 'list' } }] };
      }
      return { text: '还没有学习地图。' };
    });
    const chat = await agent.chat({ message: '我们开始学 Rust，先看看学习地图', identityId: 'study', requestKey: `study-read-${stamp()}` });
    const conversationId = chat.conversationId!;
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.identityId).toBe('study');
    expect(observed[0].system).toContain('【学习域概况】');
    expect(observed[0].system).not.toContain('【附近任务】');
    expect(observed[0].system).not.toContain('【固定说明】');
    expect(observed[0].tools).toContain('learning_read');
    expect(observed[0].tools).not.toContain('query_tasks');
    const read = toolResult(chat.events, 'learning_read');
    expect(read?.result).toMatchObject({ success: true });

    await expect(agent.chat({ conversationId, message: '继续', identityId: 'work', requestKey: `mismatch-${stamp()}` })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  });

  it('runs learning proposals through approval and revision checks', async () => {
    const title = stamp();
    const phrase = `整理学习地图-${title}`;
    const agent = agentFor(proposeScript(phrase, [{ family: 'learning', args: { action: 'map_create', title, goal: '学会 Rust 基础' } }], '创建 Rust 学习地图'));
    const chat = await agent.chat({ message: phrase, identityId: 'study', requestKey: `study-map-${title}` });
    const event = approvalFrom(chat.events);
    expect(event.review?.entities).toEqual([expect.objectContaining({ entityType: 'learning_map', operation: 'create' })]);
    expect(await prisma.learningMap.count({ where: { title } })).toBe(0);
    const decision = await agent.approve(event.approvalId, { expectedProposalRevision: event.proposalRevision, previewHash: event.previewHash }) as Decision;
    expect(decision.outcome?.status).toBe('executed');
    const map = await prisma.learningMap.findFirstOrThrow({ where: { title, deletedAt: null } });
    expect(map).toMatchObject({ goal: '学会 Rust 基础', revision: 1 });

    const nodePhrase = `补充清单-${title}`;
    const agent2 = agentFor(proposeScript(nodePhrase, [
      { family: 'learning', args: { action: 'node_create', mapId: map.id, parentId: null, kind: 'topic', title: '所有权' } },
      { family: 'learning', args: { action: 'node_create', mapId: map.id, parentId: null, kind: 'item', title: '读《Rust 程序设计语言》第 4 章' } },
    ], '补充学习清单'));
    const chat2 = await agent2.chat({ message: nodePhrase, identityId: 'study', requestKey: `study-node-${title}` });
    const event2 = approvalFrom(chat2.events);
    const decision2 = await agent2.approve(event2.approvalId, { expectedProposalRevision: event2.proposalRevision, previewHash: event2.previewHash }) as Decision;
    expect(decision2.outcome?.status).toBe('executed');
    expect(await prisma.learningNode.count({ where: { mapId: map.id, deletedAt: null } })).toBe(2);
    // 多条修改在执行后合并为一条 proposal 批量变更记录，节点快照收在 afterSnapshot 里。
    const batches = await prisma.changeRecord.findMany({ where: { entityType: 'proposal' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 3 });
    expect(batches.some((row) => (row.afterSnapshot ?? '').includes('learning_node'))).toBe(true);

    const conflictPhrase = `更新地图-${title}`;
    const agent3 = agentFor(proposeScript(conflictPhrase, [{ family: 'learning', args: { action: 'map_update', mapId: map.id, expectedRevision: 99, title: '改名' } }], '更新地图'));
    const chat3 = await agent3.chat({ message: conflictPhrase, identityId: 'study', requestKey: `study-conflict-${title}` });
    expect(chat3.events.some((item) => item.type === 'approval_required')).toBe(false);
    const failed = toolResult(chat3.events, 'propose_changes');
    expect(failed?.result).toMatchObject({ success: false });
  });

  it('rejects work-family proposals from the study identity', async () => {
    const phrase = `把学习整理成任务-${stamp()}`;
    const agent = agentFor(proposeScript(phrase, [{ family: 'workspace', command: { kind: 'task.create', input: { title: '学习任务' } } }], '把学习变成任务'));
    const chat = await agent.chat({ message: phrase, identityId: 'study', requestKey: `study-cross-${stamp()}` });
    expect(chat.events.some((item) => item.type === 'approval_required')).toBe(false);
    const failed = toolResult(chat.events, 'propose_changes');
    expect(failed?.result).toMatchObject({ success: false, code: 'FAMILY_NOT_ALLOWED' });
  });

  it('applies per-identity model overrides from app settings', async () => {
    const settings = new SettingsService();
    const row = await prisma.appSetting.findUnique({ where: { id: 'default' } });
    const original = row?.assistantIdentityJson ?? null;
    const existed = Boolean(row);
    const timestamp = new Date().toISOString();
    if (!existed) await prisma.appSetting.create({ data: { id: 'default', createdAt: timestamp, updatedAt: timestamp } });
    await prisma.appSetting.update({ where: { id: 'default' }, data: { assistantIdentityJson: JSON.stringify({ study: { model: 'study-model' } }) } });
    try {
      const study = await settings.credentials('study');
      const work = await settings.credentials();
      // 测试库可能没有全局模型配置；配置了才比较基准字段。
      if (work) {
        expect(work.model).not.toBe('study-model');
        expect(study?.model).toBe('study-model');
        expect(study?.baseUrl).toBe(work.baseUrl);
      }
      expect(await settings.credentials('work')).toEqual(work);
    } finally {
      if (existed) await prisma.appSetting.update({ where: { id: 'default' }, data: { assistantIdentityJson: original ?? '{}' } });
      else await prisma.appSetting.delete({ where: { id: 'default' } });
    }
  });
});
