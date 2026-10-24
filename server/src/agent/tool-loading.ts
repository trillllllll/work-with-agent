import { z } from 'zod';
import { builtinToolDefinitions, BUILTIN_BEHAVIOR_PROMPT, proposeChangesParameters } from './capabilities.js';
import type { ModelToolDefinition } from '../agent.js';

// These are availability groups, never permissions. Every write still uses the
// original proposal compiler, revision checks and approval executor.
export const toolGroupNames = ['tasks', 'library', 'memory', 'orchestration', 'external', 'workspace_write', 'library_write', 'memory_write', 'skill_write', 'media'] as const;
export const toolGroupSchema = z.enum(toolGroupNames);
export type ToolGroup = z.infer<typeof toolGroupSchema>;
const groups: Record<ToolGroup, { description: string; tools: string[] }> = {
  tasks: { description: '任务、清单、标签、动态和规划时间段查询', tools: ['query_tasks', 'query_topics', 'get_task_activity', 'list_plan_time_bands'] },
  library: { description: '资料原文、历史版本、关联任务、文件夹和标签查询', tools: ['library_read'] },
  memory: { description: '已确认记忆和当前工作简报查询', tools: ['memory_read', 'get_work_context'] },
  orchestration: { description: '编排、执行端、worktree、用量统计及删除确认卡片', tools: ['orchestration_read', 'orchestration_stats', 'propose_worktree_cleanup'] },
  external: { description: '把超出能力的需求整理为外部提示词', tools: ['prepare_external_prompt'] },
  workspace_write: { description: '任务、清单、标签修改提议（须确认）', tools: ['propose_changes'] },
  library_write: { description: '资料及其组织、关联修改提议（须确认）', tools: ['propose_changes'] },
  memory_write: { description: '记忆修改提议（须确认）', tools: ['propose_changes'] },
  skill_write: { description: '技能创建、修改提议（须确认）', tools: ['propose_changes'] },
  media: { description: '图表、SVG、HTML、Mermaid 和真实图片展示', tools: ['present_reply', 'image_search'] },
};
const base = new Set(['get_time', 'read_page_state', 'read_app_knowledge', 'search_workspace', 'conversation_search', 'get_change_schema']);
const loadTool: ModelToolDefinition = { type: 'function', function: {
  name: 'load_tools', description: '按能力组加载工具；不执行业务操作。加载后下一轮可用，可一次加载多组。',
  parameters: { type: 'object', additionalProperties: false, required: ['groups'], properties: { groups: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: [...toolGroupNames] } } } },
} };
const readSourceTool: ModelToolDefinition = { type: 'function', function: {
  name: 'read_context_source', description: '分页回读当前会话被压缩的消息或工具结果原文。offset/limit 按 UTF-16 字符计，不修改内容。',
  parameters: { type: 'object', additionalProperties: false, required: ['messageId'], properties: { messageId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } } },
} };
export const loadToolsInput = z.object({ groups: z.array(toolGroupSchema).min(1).max(toolGroupNames.length) }).strict();
export const readSourceInput = z.object({ messageId: z.string().min(1), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(2000).default(1600) }).strict();

export function initialToolGroups(text: string, page: string): ToolGroup[] {
  const selected = new Set<ToolGroup>(['tasks']);
  if (/library|material|资料|材料|文档|附件/i.test(`${page} ${text}`)) selected.add('library');
  if (/memory|knowledge|记忆|上下文|简报/i.test(`${page} ${text}`)) selected.add('memory');
  if (/orchestrat|worktree|编排|执行端|派发/i.test(`${page} ${text}`)) selected.add('orchestration');
  if (/外部|联网|网页搜索|external/i.test(text)) selected.add('external');
  if (/svg|html|mermaid|富媒体|图表|可视化|画图|绘图|图片|流程图|结构图|时序图|柱状图|饼图|折线图|widget|diagram|chart/i.test(text)) selected.add('media');
  if (/创建|新建|修改|更新|删除|安排|设为|标记|完成任务|归档|记住|待确认|提议|create|update|delete|schedule|rename|remember/i.test(text)) {
    selected.add('workspace_write');
    if (selected.has('library')) selected.add('library_write');
    if (selected.has('memory') || /记住|remember/i.test(text)) selected.add('memory_write');
    if (/技能|skill/i.test(text)) selected.add('skill_write');
  }
  return [...selected];
}

export function loadedFamilies(selected: readonly ToolGroup[]) {
  return selected.filter((g) => g.endsWith('_write')).map((g) => g.slice(0, -6));
}

export function toolsForGroups(selected: readonly ToolGroup[], loadSkill = false): ModelToolDefinition[] {
  const names = new Set([...base, ...selected.flatMap((g) => groups[g].tools)]);
  if (loadSkill) names.add('load_skill');
  const families = loadedFamilies(selected);
  const tools = builtinToolDefinitions({ loadSkill }).filter((t) => names.has(t.function.name)).map((tool) => {
    if (tool.function.name !== 'propose_changes') return tool;
    const variants = proposeChangesParameters.properties.operations.items.oneOf.filter((variant) => families.includes(variant.properties.family.const));
    return { ...tool, function: { ...tool.function, parameters: { ...proposeChangesParameters, properties: { ...proposeChangesParameters.properties, operations: { ...proposeChangesParameters.properties.operations, items: { oneOf: variants } } } } } };
  });
  return [...tools, loadTool, readSourceTool];
}

export const toolCatalog = Object.entries(groups).map(([name, group]) => `- ${name}：${group.description}`).join('\n');
export const mediaInstructions = BUILTIN_BEHAVIOR_PROMPT.split('【富媒体表达】')[1].split('【能力边界】')[0];
export function lazySystemPrompt() {
  return BUILTIN_BEHAVIOR_PROMPT.replace('{{CAPABILITY_MANIFEST}}', `常驻：get_time、read_page_state、read_app_knowledge、search_workspace、conversation_search、get_change_schema、read_context_source，以及已启用时的 load_skill。\n其他能力按需加载：\n${toolCatalog}\n先检查本轮 tools；缺少工具时调用 load_tools，下一轮再调用目标工具。get_change_schema 也会加载对应修改类型。加载只改变可用工具，不扩大数据权限。`)
    .replace(/【富媒体表达】[\s\S]*?【能力边界】/, '【富媒体表达】\n普通文字直接回复。需要富内容时先加载 media，完整规则随加载提供。\n\n【能力边界】');
}
