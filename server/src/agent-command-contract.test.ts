import { testDiscovery, withoutDiscovery } from './agent/test-model-tools.js';
import type { ModelToolDefinition } from './agent.js';
import { describe, expect, it } from 'vitest';
import { prisma } from './infrastructure/prisma.js';
import { AgentService, type ModelMessage } from './agent.js';
import type { ToolCall } from './application/workspace.js';
import { builtinSystemPrompt, builtinTools, proposeChangesParameters } from './agent/capabilities.js';
import { executeBuiltinTool } from './agent/builtin-tools.js';
import { jsonSchemaAccepts, parseWorkspaceCommand, workspaceChangeDocument, workspaceCommandJsonSchema, type JsonSchema } from './agent/workspace-commands.js';
import { statusTransitionLine } from './agent/task-write-spec.js';
import { allowedTaskTransitions } from './domain/task.js';
import type { StoredChatContext } from './agent/chat-context.js';

const context: StoredChatContext = {
  schemaVersion: 2, page: 'inbox', scope: { kind: 'inbox' }, taskId: null, materialId: null, selectedTaskIds: [], taskFilter: null,
  timeZone: 'Asia/Shanghai', timeZoneSource: 'context', referencedApprovalId: null,
};
const schema = workspaceCommandJsonSchema();

function commandInput(kind: string) {
  const branches = (proposeChangesParameters.properties.operations.items as { oneOf: Array<{ properties: { command: JsonSchema } }> }).oneOf;
  const command = branches[0].properties.command;
  const match = command.oneOf?.find((item) => item.properties?.kind?.const === kind);
  return match?.properties?.input?.properties ?? {};
}

function acceptsRuntime(command: { kind: string; targetId?: string; expectedRevision?: number; clientRef?: string; input?: Record<string, unknown> }) {
  try { parseWorkspaceCommand(command); return true; }
  catch { return false; }
}

async function counts() {
  const [tasks, topics, tags] = await Promise.all([prisma.task.count(), prisma.topic.count(), prisma.tag.count()]);
  return { tasks, topics, tags };
}

function agentFor(operations: unknown[], summary: string) {
  return new AgentService({
    stream: async function* (messages: ModelMessage[], _signal?: AbortSignal, _includeTools?: boolean, tools?: ModelToolDefinition[]) {
      const discovery = testDiscovery(tools);
      if (discovery) { yield discovery; return; }
      messages = withoutDiscovery(messages);
      if (messages.some((message) => message.role === 'tool')) { yield { text: '预览步骤结束。' }; return; }
      const call: ToolCall = { id: `call-${summary}`, name: 'propose_changes', arguments: { summary, operations } };
      yield { toolCalls: [call] };
    },
  } as never);
}

describe('workspace command contract', () => {
  it('keeps the explicit built-in tools and agrees on every valid or illegal command', () => {
    expect(builtinTools.map((tool) => tool.name)).toEqual([
      'present_reply', 'image_search', 'web_search', 'read_webpage', 'read_app_knowledge', 'read_page_state', 'get_time', 'list_plan_time_bands', 'get_work_context', 'query_tasks', 'query_topics', 'get_task_activity', 'search_workspace',
      'library_read', 'memory_read', 'learning_read', 'conversation_search', 'get_change_schema', 'propose_changes', 'prepare_external_prompt', 'orchestration_read', 'orchestration_stats', 'propose_worktree_cleanup',
    ]);
    const valid = [
      { kind: 'topic.create', input: { name: '清单' } },
      { kind: 'tag.create', input: { name: '标签', color: 'blue' } },
      { kind: 'task.reorder', input: { topicId: null, parentId: null, orderedTaskIds: ['task-a'] } },
      { kind: 'task.create', clientRef: 'child', input: { title: '子任务', parentId: { $ref: 'parent' } } },
      { kind: 'task.update', targetId: 'task-1', expectedRevision: 1, input: { title: '新标题' } },
      { kind: 'topic.update', targetId: 'topic-1', expectedRevision: 2, input: { draftSummary: '草稿' } },
      { kind: 'tag.update', targetId: 'tag-1', expectedRevision: 1, input: { color: 'teal' } },
      { kind: 'task.delete', targetId: 'task-1', expectedRevision: 1, input: {} },
      { kind: 'topic.archive', targetId: 'topic-1', expectedRevision: 1, input: {} },
      { kind: 'topic.move_tasks_to_inbox', targetId: 'topic-1', expectedRevision: 1, input: {} },
    ];
    const invalid = [
      { kind: 'topic.create', input: { name: '清单', extra: true } },
      { kind: 'tag.create', input: { name: '标签', color: 'blue', extra: 1 } },
      { kind: 'task.reorder', input: { topicId: null, parentId: null, orderedTaskIds: ['task-a'], sortOrder: 1 } },
      { kind: 'task.update', targetId: 'task-1', expectedRevision: 1, input: {} },
      { kind: 'task.delete', targetId: 'task-1', expectedRevision: 1, input: { title: '不能放在这里' } },
      { kind: 'topic.create', targetId: 'topic-1', expectedRevision: 1, input: { name: '清单' } },
      { kind: 'not.a.command', input: {} },
    ];
    for (const command of valid) expect(jsonSchemaAccepts(schema, command), JSON.stringify(command)).toBe(acceptsRuntime(command));
    for (const command of valid) expect(acceptsRuntime(command), JSON.stringify(command)).toBe(true);
    for (const command of invalid) expect(jsonSchemaAccepts(schema, command), JSON.stringify(command)).toBe(false);
    for (const command of invalid) expect(acceptsRuntime(command), JSON.stringify(command)).toBe(false);
  });

  it('shows task write values and rules on the propose_changes schema and in the prompt', () => {
    const update = commandInput('task.update');
    const reorder = workspaceChangeDocument('task.reorder');
    expect(update.dueDate?.description).toContain('全天');
    expect(update.dueDate?.description).toContain('YYYY-MM-DD');
    expect(update.status?.description).toContain(statusTransitionLine());
    expect(statusTransitionLine()).toContain(`已完成 done 只能到 待办 ${allowedTaskTransitions('done')[0]}`);
    expect(update.completeChildren?.description).toContain('连同未完成子任务一起完成');
    expect(reorder.notes.join('\n')).toContain('同一父级下全部未删除任务');
    const prompt = builtinSystemPrompt();
    for (const shape of ['无安排', '全天', '时间点', '时间段']) expect(prompt).toContain(shape);
  });

  it('returns one kind from get_change_schema and rejects an unknown kind', async () => {
    const run = { id: 'schema-run', leaseToken: 'schema', conversationId: 'schema', assistantMessageId: 'schema', sourceUserMessageId: 'schema' };
    const topic = await executeBuiltinTool({ name: 'get_change_schema', args: { family: 'workspace', kind: 'topic.create' }, context, run, toolCallId: 'schema-topic' });
    expect(topic.success).toBe(true);
    expect(jsonSchemaAccepts((topic.data as { command: never }).command, { kind: 'topic.create', input: { name: '清单' } })).toBe(true);
    expect(workspaceChangeDocument('tag.create').kind).toBe('tag.create');
    const taskUpdate = await executeBuiltinTool({ name: 'get_change_schema', args: { family: 'workspace', kind: 'task.update' }, context, run, toolCallId: 'schema-task-update' });
    expect(taskUpdate.success).toBe(true);
    expect((taskUpdate.data as { notes: string[] }).notes.join('\n')).toContain('留下日期就是全天');
    const unknown = await executeBuiltinTool({ name: 'get_change_schema', args: { family: 'workspace', kind: 'task.nope' }, context, run, toolCallId: 'schema-unknown' });
    expect(unknown).toMatchObject({ success: false, code: 'INVALID_TOOL_ARGUMENTS' });
    expect(unknown.error).toContain('未知的修改类型');
  });

  it('previews topic, tag, and reorder commands and leaves business rows unchanged when a field is illegal', async () => {
    const stamp = Date.now();
    const topic = await prisma.topic.create({ data: { id: `repair-topic-${stamp}`, name: '排序清单', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    const first = await prisma.task.create({ data: { id: `repair-order-a-${stamp}`, topicId: topic.id, title: '甲', sortOrder: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    const second = await prisma.task.create({ data: { id: `repair-order-b-${stamp}`, topicId: topic.id, title: '乙', sortOrder: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    const before = await counts();
    const orders = await prisma.task.findMany({ where: { id: { in: [first.id, second.id] } }, select: { id: true, sortOrder: true } });
    const topicPreview = await agentFor([{ family: 'workspace', command: { kind: 'topic.create', input: { name: '清单' } } }], '新建清单').chat({ message: '新建清单', pageContext: { page: 'inbox' }, requestKey: `contract-topic-${stamp}` });
    const tagPreview = await agentFor([{ family: 'workspace', command: { kind: 'tag.create', input: { name: '标签', color: 'blue' } } }], '新建标签').chat({ message: '新建标签', pageContext: { page: 'inbox' }, requestKey: `contract-tag-${stamp}` });
    const reorderPreview = await agentFor([{ family: 'workspace', command: { kind: 'task.reorder', input: { topicId: topic.id, parentId: null, orderedTaskIds: [second.id, first.id] } } }], '调整顺序').chat({ message: '调整顺序', pageContext: { page: 'inbox' }, requestKey: `contract-reorder-${stamp}` });
    expect(topicPreview.events.some((event) => event.type === 'approval_required')).toBe(true);
    expect(tagPreview.events.some((event) => event.type === 'approval_required')).toBe(true);
    expect(reorderPreview.events.some((event) => event.type === 'approval_required')).toBe(true);
    expect(await prisma.topic.findFirst({ where: { name: '清单' } })).toBeNull();
    expect(await prisma.tag.findFirst({ where: { name: '标签' } })).toBeNull();
    expect(await prisma.task.findMany({ where: { id: { in: [first.id, second.id] } }, select: { id: true, sortOrder: true } })).toEqual(orders);
    const illegal = await agentFor([{ family: 'workspace', command: { kind: 'topic.create', input: { name: '清单', extra: true } } }], '非法字段').chat({ message: '非法字段', pageContext: { page: 'inbox' }, requestKey: `contract-illegal-${stamp}` });
    expect(illegal.events.find((event) => event.type === 'tool_result' && event.toolName === 'propose_changes')?.result).toMatchObject({ success: false });
    expect(illegal.events.some((event) => event.type === 'approval_required')).toBe(false);
    expect(await counts()).toEqual({ ...before, tasks: before.tasks });
    const after = await counts();
    expect(after.topics).toBe(before.topics);
    expect(after.tags).toBe(before.tags);
    await prisma.task.deleteMany({ where: { id: { in: [first.id, second.id] } } });
    await prisma.topic.delete({ where: { id: topic.id } });
  });
});
