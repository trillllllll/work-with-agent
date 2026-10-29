import { z } from 'zod';
import { builtinToolDefinitions, behaviorPromptFor, capabilityManifest, proposeChangesParameters } from './capabilities.js';
import { getAssistantIdentity, type AssistantIdentityId } from './identities.js';
import type { ModelToolDefinition } from '../agent.js';

// These are availability groups, never permissions. Every write still uses the
// original proposal compiler, revision checks and approval executor.
// 身份（identities.ts）决定哪些组对当前助手可见；这里只做加载与拼装。
export const toolGroupNames = ['tasks', 'library', 'memory', 'learning', 'orchestration', 'external', 'web', 'workspace_write', 'library_write', 'memory_write', 'learning_write', 'skill_write', 'media'] as const;
export const toolGroupSchema = z.enum(toolGroupNames);
export type ToolGroup = z.infer<typeof toolGroupSchema>;
const groups: Record<ToolGroup, { description: string; tools: string[] }> = {
  tasks: { description: '任务、清单、标签、动态和规划时间段查询', tools: ['query_tasks', 'query_topics', 'get_task_activity', 'list_plan_time_bands'] },
  library: { description: '资料原文、历史版本、关联任务、文件夹和标签查询', tools: ['library_read'] },
  memory: { description: '已确认记忆和当前工作简报查询', tools: ['memory_read', 'get_work_context'] },
  learning: { description: '学习地图、知识笔记、练习记录、复习队列和学习动态查询', tools: ['learning_read'] },
  orchestration: { description: '编排、执行端、worktree、用量统计及删除确认卡片', tools: ['orchestration_read', 'orchestration_stats', 'propose_worktree_cleanup'] },
  external: { description: '把超出能力的需求整理为外部提示词', tools: ['prepare_external_prompt'] },
  web: { description: '联网搜索与网页阅读（需要已配置 DeepSeek 联网搜索服务）', tools: ['web_search', 'read_webpage'] },
  workspace_write: { description: '任务、清单、标签修改提议（须确认）', tools: ['propose_changes'] },
  library_write: { description: '资料及其组织、关联修改提议（须确认）', tools: ['propose_changes'] },
  memory_write: { description: '记忆修改提议（须确认）', tools: ['propose_changes'] },
  learning_write: { description: '学习地图、知识笔记、练习创建和收尾记录提议（须确认）', tools: ['propose_changes'] },
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

function allowedGroupsFor(identityId: string | null | undefined): ToolGroup[] {
  const allowed = new Set(getAssistantIdentity(identityId).allowedGroups);
  return toolGroupNames.filter((group) => allowed.has(group));
}

function baseToolsFor(identityId: string | null | undefined): string[] {
  const identity = getAssistantIdentity(identityId);
  // work 沿用既有常驻集合；其他身份以注册表为准。
  return identity.id === 'work' ? [...base] : [...identity.baseTools];
}

export function isGroupAllowedFor(identityId: string | null | undefined, group: ToolGroup) {
  return allowedGroupsFor(identityId).includes(group);
}

export function initialToolGroups(text: string, page: string, identityId: AssistantIdentityId | string = 'work'): ToolGroup[] {
  if (identityId === 'study') {
    const selected = new Set<ToolGroup>(['learning']);
    if (/外部|联网|网页搜索|external/i.test(text)) selected.add('external');
    if (/联网|搜索|网页|官网|官方文档|文档|最新|latest|查一?下|web|search/i.test(text)) selected.add('web');
    if (/svg|html|mermaid|富媒体|图表|可视化|画图|绘图|图片|流程图|结构图|时序图|模拟器|仿真|互动|交互|演示|实验|widget|diagram|chart/i.test(text)) selected.add('media');
    if (/创建|新建|修改|更新|补充|添加|标记|掌握|归档|记录|整理|规划|待确认|提议|出题|做题|刷题|复习|考考|create|update|remember|practice|quiz|exercise|review/i.test(text)) selected.add('learning_write');
    return [...selected];
  }
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

/** 按身份收敛已加载的组：身份不允许的组在这里被剔除，历史游标里残留也不生效。
 *  webEnabled 为用户在会话上显式开启的联网开关：仅此一个组可以越过身份白名单。 */
export function scopeGroupsFor(identityId: string | null | undefined, selected: readonly ToolGroup[], webEnabled = false): ToolGroup[] {
  const allowed = new Set(allowedGroupsFor(identityId));
  return selected.filter((group) => allowed.has(group) || (webEnabled && group === 'web'));
}

export function toolsForGroups(selected: readonly ToolGroup[], loadSkill = false, identityId: AssistantIdentityId | string = 'work', webEnabled = false): ModelToolDefinition[] {
  const effective = scopeGroupsFor(identityId, selected, webEnabled);
  const names = new Set([...baseToolsFor(identityId), ...effective.flatMap((g) => groups[g].tools)]);
  if (loadSkill) names.add('load_skill');
  const families = loadedFamilies(effective);
  const tools = builtinToolDefinitions({ loadSkill }).filter((t) => names.has(t.function.name)).map((tool) => {
    if (tool.function.name !== 'propose_changes') return tool;
    const variants = proposeChangesParameters.properties.operations.items.oneOf.filter((variant) => families.includes(variant.properties.family.const));
    return { ...tool, function: { ...tool.function, parameters: { ...proposeChangesParameters, properties: { ...proposeChangesParameters.properties, operations: { ...proposeChangesParameters.properties.operations, items: { oneOf: variants } } } } } };
  });
  return [...tools, loadTool, readSourceTool];
}

export function toolCatalog(identityId: AssistantIdentityId | string = 'work') {
  return allowedGroupsFor(identityId).map((name) => `- ${name}：${groups[name].description}`).join('\n');
}

/** 全量提示词：能力清单按身份工具面生成。study 的组装入口。 */
export function systemPromptFor(identityId: AssistantIdentityId | string = 'work', opts?: { loadSkill?: boolean }) {
  const identity = getAssistantIdentity(identityId);
  const names = new Set([...baseToolsFor(identityId), ...allowedGroupsFor(identityId).flatMap((g) => groups[g].tools)]);
  return behaviorPromptFor(identityId).replace('{{CAPABILITY_MANIFEST}}', capabilityManifest({ loadSkill: opts?.loadSkill, names: [...names] }));
}

export function mediaInstructionsFor(identityId: AssistantIdentityId | string = 'work') {
  return behaviorPromptFor(identityId).split('【富媒体表达】')[1].split('【能力边界】')[0];
}

export const mediaInstructions = mediaInstructionsFor('work');

export function lazySystemPrompt(identityId: AssistantIdentityId | string = 'work') {
  return behaviorPromptFor(identityId)
    .replace('{{CAPABILITY_MANIFEST}}', `常驻：${baseToolsFor(identityId).join('、')}、read_context_source，以及已启用时的 load_skill。\n其他能力按需加载：\n${toolCatalog(identityId)}\n先检查本轮 tools；缺少工具时调用 load_tools，下一轮再调用目标工具。get_change_schema 也会加载对应修改类型。加载只改变可用工具，不扩大数据权限。`)
    .replace(/【富媒体表达】[\s\S]*?【能力边界】/, '【富媒体表达】\n普通文字直接回复。需要富内容时先加载 media，完整规则随加载提供。\n\n【能力边界】');
}
