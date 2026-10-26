import { toolsForGroups } from './agent/tool-loading.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentService, type ModelMessage, type ModelToolDefinition } from './agent.js';
import { contextFromRequest } from './agent/chat-context.js';
import { executeBuiltinTool } from './agent/builtin-tools.js';
import { builtinToolDefinitions } from './agent/capabilities.js';
import { createSkill, deleteSkill } from './application/skills.js';
import { prisma } from './infrastructure/prisma.js';

const allTools = ['present_reply', 'image_search', 'read_app_knowledge', 'read_page_state', 'get_time', 'list_plan_time_bands', 'get_work_context', 'query_tasks', 'query_topics', 'get_task_activity', 'search_workspace', 'library_read', 'memory_read', 'learning_read', 'conversation_search', 'get_change_schema', 'propose_changes', 'prepare_external_prompt', 'orchestration_read', 'orchestration_stats', 'propose_worktree_cleanup'];
const baseTools = toolsForGroups(['tasks']).map(tool => tool.function.name);
const context = contextFromRequest({ pageContext: { page: 'inbox' } });
const run = { id: 'skill-run', leaseToken: 'skill-token', conversationId: 'skill-conversation', assistantMessageId: 'skill-assistant', sourceUserMessageId: 'skill-user' };
let seq = 0;
const stamp = () => `加载技能-${Date.now()}-${seq += 1}`;

function agentFor(script: (messages: ModelMessage[], tools: ModelToolDefinition[] | undefined) => Promise<{ text?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>) {
  return new AgentService({
    stream: async function* (messages: ModelMessage[], _signal?: AbortSignal, _includeTools?: boolean, tools?: ModelToolDefinition[]) {
      const delta = await script(messages, tools);
      if (delta.text) yield { text: delta.text };
      if (delta.toolCalls?.length) yield { toolCalls: delta.toolCalls };
    },
  } as never);
}

describe('on-demand skill loading', () => {
  afterEach(async () => {
    await prisma.skillVersion.deleteMany();
    await prisma.skill.deleteMany();
  });

  it('keeps the zero-skill tool list and omits the catalog, even if a skill is enabled mid-run', async () => {
    const calls: Array<{ system: string; tools: string[] }> = [];
    let armed = false;
    const agent = agentFor(async (messages, tools) => {
      calls.push({ system: String(messages.find((message) => message.role === 'system')?.content ?? ''), tools: (tools ?? []).map((tool) => tool.function.name) });
      if (!armed) {
        armed = true;
        await createSkill({ name: stamp(), description: '中途启用', instructions: '不应进入本次目录', enabled: true });
        return { toolCalls: [{ id: 'time', name: 'get_time', arguments: {} }] };
      }
      return { text: '完成' };
    });
    const result = await agent.chat({ message: '现在没有启用的技能', pageContext: { page: 'inbox' } });
    expect(result.events.some((event) => event.type === 'error')).toBe(false);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.system).not.toContain('【可用技能】');
      expect(call.system).not.toContain('不应进入本次目录');
      expect(call.tools).toEqual(baseTools);
    }
    expect(builtinToolDefinitions().map((tool) => tool.function.name)).toEqual(allTools);
  });

  it('lists only enabled skill names and descriptions, and registers load_skill for that run', async () => {
    const alpha = await createSkill({ name: `乙${stamp()}`, description: '乙的描述', instructions: '乙的机密正文', enabled: true });
    const beta = await createSkill({ name: `甲${stamp()}`, description: '甲的描述', instructions: '甲的机密正文', enabled: true });
    const disabled = await createSkill({ name: `丙${stamp()}`, description: '丙的描述', instructions: '丙的机密正文' });
    const removed = await createSkill({ name: `丁${stamp()}`, description: '丁的描述', instructions: '丁的机密正文', enabled: true });
    await deleteSkill(removed.id, removed.revision);
    const calls: Array<{ system: string; tools: string[] }> = [];
    const agent = agentFor(async (messages, tools) => {
      calls.push({ system: String(messages.find((message) => message.role === 'system')?.content ?? ''), tools: (tools ?? []).map((tool) => tool.function.name) });
      if (messages.some((message) => message.role === 'tool')) return { text: '已读取' };
      return { toolCalls: [{ id: 'load', name: 'load_skill', arguments: { name: beta.name } }] };
    });
    const result = await agent.chat({ message: '按技能处理', pageContext: { page: 'inbox' } });
    expect(result.events.some((event) => event.type === 'error')).toBe(false);
    expect(calls[0]?.tools).toEqual(toolsForGroups(['tasks'], true).map(tool => tool.function.name));
    const system = calls[0]?.system ?? '';
    expect(system).toContain('【可用技能】');
    expect(system).toContain('以下只是目录。用户请求与某项匹配时，先调用 load_skill 读取正文，再按正文执行。');
    expect(system).toContain(`- ${alpha.name}：乙的描述`);
    expect(system).toContain(`- ${beta.name}：甲的描述`);
    expect(system).not.toContain('乙的机密正文');
    expect(system).not.toContain('甲的机密正文');
    expect(system).not.toContain(disabled.name);
    expect(system).not.toContain(removed.name);
    expect(system.indexOf(`- ${alpha.name}：`)).toBeLessThan(system.indexOf(`- ${beta.name}：`));
    const tool = result.events.find((event) => event.type === 'tool_result' && event.toolName === 'load_skill');
    expect(tool).toMatchObject({ result: { success: true, data: { skillId: beta.id, name: beta.name, revision: 1, description: '甲的描述', instructions: '甲的机密正文' } } });
    const row = await prisma.message.findFirst({ where: { role: 'tool', content: { contains: beta.id } } });
    expect(JSON.parse(row?.content ?? '{}').data).toEqual({ skillId: beta.id, name: beta.name, revision: 1, description: '甲的描述', instructions: '甲的机密正文' });
    expect(calls[1]?.tools).toEqual(toolsForGroups(['tasks'], true).map(tool => tool.function.name));
    expect(calls[1]?.system).toBe(system);
  });

  it('returns the current snapshot only for a registered enabled skill', async () => {
    const enabled = await createSkill({ name: stamp(), description: '在用', instructions: '当前正文', enabled: true });
    const disabled = await createSkill({ name: stamp(), description: '停用', instructions: '停用正文' });
    const removed = await createSkill({ name: stamp(), description: '已删', instructions: '删除正文', enabled: true });
    await deleteSkill(removed.id, removed.revision);
    expect(await executeBuiltinTool({ name: 'load_skill', args: { name: enabled.name }, context, run, toolCallId: 'load-1', loadSkill: true })).toEqual({ success: true, data: { skillId: enabled.id, name: enabled.name, revision: 1, description: '在用', instructions: '当前正文' } });
    expect(await executeBuiltinTool({ name: 'load_skill', args: { name: enabled.name }, context, run, toolCallId: 'load-2' })).toMatchObject({ success: false, code: 'CAPABILITY_UNAVAILABLE' });
    expect(await executeBuiltinTool({ name: 'load_skill', args: { name: disabled.name }, context, run, toolCallId: 'load-3', loadSkill: true })).toEqual({ success: false, code: 'NOT_FOUND' });
    expect(await executeBuiltinTool({ name: 'load_skill', args: { name: removed.name }, context, run, toolCallId: 'load-4', loadSkill: true })).toEqual({ success: false, code: 'NOT_FOUND' });
    expect(await executeBuiltinTool({ name: 'load_skill', args: { name: '没有这个技能' }, context, run, toolCallId: 'load-5', loadSkill: true })).toEqual({ success: false, code: 'NOT_FOUND' });
  });
});
