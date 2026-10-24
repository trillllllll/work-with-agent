import type { ModelMessage, ModelToolDefinition, ModelUsage } from '../agent.js';
import type { SummaryMetric } from '../application/conversation.js';
import { ESTIMATOR, HISTORY_TOKEN_BUDGET, isBackground, messageTokens, messagesTokens, textTokens } from './context-budget.js';

export type ContextCategory = 'messages' | 'tools' | 'system' | 'skills' | 'manual' | 'work' | 'summary';
export type ContextStats = {
  schemaVersion: 1; runId: string; round: number; recordedAt: string; estimator: string;
  estimatedInputTokens: number; estimatedOutputTokens: number; contextWindow: null; historyBudget: number; historyOverBudget: boolean;
  categories: Array<{ id: ContextCategory; tokens: number }>;
  tools: Array<{ name: string; tokens: number }>; loadedGroups: string[];
  baseline: { estimatedInputTokens: number; toolTokens: number; note: 'same-messages-full-tools' };
  actual: ModelUsage | null;
  summaryCalls: SummaryMetric[];
  totals: { requests: number; estimatedInputTokens: number; estimatedOutputTokens: number; actualInputTokens: number | null; actualOutputTokens: number | null; cachedInputTokens: number | null; usageComplete: boolean; durationMs: number };
  durationMs: number;
};

export function buildContextStats(input: { runId: string; round: number; messages: ModelMessage[]; tools: ModelToolDefinition[]; fullTools: ModelToolDefinition[]; loadedGroups: string[]; summaryCalls?: SummaryMetric[] }): ContextStats {
  const counts: Record<ContextCategory, number> = { messages: 0, tools: 0, system: 0, skills: 0, manual: 0, work: 0, summary: 0 };
  for (const message of input.messages) {
    if (message.role !== 'system') { counts[isBackground(message) ? 'summary' : 'messages'] += messageTokens(message); continue; }
    const content = String(message.content ?? '');
    // Only assembly boundary headings change category. Nested headings in rules,
    // user notes or rich-media policies do not change trust or execution behavior.
    const boundaries = /(?=【(?:回复风格|可用技能|应用功能知识 v[^】]*|回复语言[^】]*|页面筛选与选中任务|页面快照|用户主动带入的引用文本|本次请求的上下文|规划时间段|固定说明|当前简报|选中对象|已确认记忆|附近任务|本请求待确认方案|按需富媒体规则)】)/g;
    for (const part of content.split(boundaries)) {
      const id = part.startsWith('【可用技能】') ? 'skills' : part.startsWith('【应用功能知识') ? 'manual'
        : /^【(页面筛选|页面快照|用户主动|本次请求|规划时间段|固定说明|当前简报|选中对象|已确认记忆|附近任务|本请求待确认)/.test(part) ? 'work' : 'system';
      counts[id] += textTokens(part);
    }
    counts.system += 4;
  }
  const tools = input.tools.map(tool => ({ name: tool.function.name, tokens: textTokens(JSON.stringify(tool)) }));
  counts.tools = textTokens(JSON.stringify(input.tools));
  const estimatedInputTokens = Object.values(counts).reduce((a, b) => a + b, 0);
  const full = textTokens(JSON.stringify(input.fullTools));
  return {
    schemaVersion: 1, runId: input.runId, round: input.round, recordedAt: new Date().toISOString(), estimator: ESTIMATOR,
    estimatedInputTokens, estimatedOutputTokens: 0, contextWindow: null, historyBudget: HISTORY_TOKEN_BUDGET,
    historyOverBudget: messagesTokens(input.messages.filter(m => m.role !== 'system')) > HISTORY_TOKEN_BUDGET,
    categories: Object.entries(counts).map(([id, tokens]) => ({ id: id as ContextCategory, tokens })), tools, loadedGroups: input.loadedGroups,
    baseline: { estimatedInputTokens: estimatedInputTokens - counts.tools + full, toolTokens: full, note: 'same-messages-full-tools' },
    actual: null, summaryCalls: input.summaryCalls ?? [], durationMs: 0,
    totals: { requests: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, actualInputTokens: null, actualOutputTokens: null, cachedInputTokens: null, usageComplete: false, durationMs: 0 },
  };
}

/** One entry per model round: before/after events must never double count. */
export function contextTotals(rounds: ContextStats[], summaries: SummaryMetric[] = []): ContextStats['totals'] {
  const latest = new Map(rounds.map(row => [row.round, row]));
  const values = [...latest.values()];
  const usages = [...values.map(row => row.actual), ...summaries.map(row => row.actual)];
  const sum = (key: keyof ModelUsage) => {
    const known = usages.flatMap(usage => typeof usage?.[key] === 'number' ? [usage[key] as number] : []);
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  return {
    requests: values.length + summaries.length,
    estimatedInputTokens: values.reduce((sum, row) => sum + row.estimatedInputTokens, 0) + summaries.reduce((sum, row) => sum + row.estimatedInputTokens, 0),
    estimatedOutputTokens: values.reduce((sum, row) => sum + row.estimatedOutputTokens, 0) + summaries.reduce((sum, row) => sum + row.estimatedOutputTokens, 0),
    actualInputTokens: sum('inputTokens'), actualOutputTokens: sum('outputTokens'), cachedInputTokens: usages.every(usage => typeof usage?.cachedInputTokens === 'number') ? sum('cachedInputTokens') : null,
    usageComplete: usages.length > 0 && usages.every(usage => typeof usage?.inputTokens === 'number' && typeof usage.outputTokens === 'number'),
    durationMs: values.reduce((sum, row) => sum + row.durationMs, 0) + summaries.reduce((sum, row) => sum + row.durationMs, 0),
  };
}
