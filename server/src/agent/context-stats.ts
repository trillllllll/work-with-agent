import type { ModelMessage, ModelToolDefinition, ModelUsage } from '../agent.js';
import type { SummaryMetric } from '../application/conversation.js';
import { ESTIMATOR, HISTORY_TOKEN_BUDGET, isBackground, messageTokens, messagesTokens, textTokens } from './context-budget.js';
import { hasModelUsage } from './model-usage.js';

export type ContextCategory = 'messages' | 'toolResults' | 'tools' | 'system' | 'skills' | 'manual' | 'work' | 'summary';
export type ContextToolResult = {
  sourceId: string | null;
  toolCallId: string | null;
  tokens: number;
  inclusion: 'first' | 'repeat' | 'unknown';
};
export type ContextFieldTotal = {
  actualTokens: number | null;
  estimatedGapTokens: number;
  preferredTokens: number | null;
  measuredAttempts: number;
  estimatedAttempts: number;
};
export type ContextTotals = {
  requests: number;
  usageReceipts: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
  cachedInputReports: number;
  reasoningOutputReports: number;
  usageComplete: boolean;
  durationMs: number;
  input: ContextFieldTotal;
  output: ContextFieldTotal;
  toolActions: number;
  toolResultTokens: number;
  firstToolResultTokens: number;
  repeatToolResultTokens: number;
  unknownToolResultTokens: number;
};
export type ContextStats = {
  schemaVersion: 1 | 2; runId: string; round: number; recordedAt: string; estimator: string;
  attemptId?: string;
  phase?: 'estimate' | 'final';
  estimatedInputTokens: number; estimatedOutputTokens: number; contextWindow: number | null; historyBudget: number; historyOverBudget: boolean;
  /** 'run' = recorded before a real model call; 'preview' = pre-send estimate, nothing persisted. */
  kind?: 'run' | 'preview';
  categories: Array<{ id: ContextCategory; tokens: number }>;
  tools: Array<{ name: string; tokens: number }>; loadedGroups: string[];
  toolResults?: ContextToolResult[];
  baseline: { estimatedInputTokens: number; toolTokens: number; note: 'same-messages-full-tools' };
  actual: ModelUsage | null;
  summaryCalls: SummaryMetric[];
  totals: ContextTotals;
  durationMs: number;
};

function toolResult(runId: string, message: ModelMessage, seen: ReadonlySet<string>): ContextToolResult {
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(message.content ?? ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
  } catch { /* Legacy or non-JSON tool content still contributes its exact projected size. */ }
  const sourceMessageId = typeof body.sourceMessageId === 'string' ? body.sourceMessageId : null;
  const assistantMessageId = typeof body.assistantMessageId === 'string' ? body.assistantMessageId : null;
  const toolCallId = message.tool_call_id ?? (typeof body.toolCallId === 'string' ? body.toolCallId : null);
  const sourceId = sourceMessageId ? `message:${sourceMessageId}` : assistantMessageId && toolCallId ? `call:${runId}:${assistantMessageId}:${toolCallId}` : null;
  return {
    sourceId,
    toolCallId,
    tokens: messageTokens(message),
    inclusion: sourceId ? seen.has(sourceId) ? 'repeat' : 'first' : 'unknown',
  };
}

export function buildContextStats(input: { runId: string; round: number; attemptId?: string; messages: ModelMessage[]; tools: ModelToolDefinition[]; fullTools: ModelToolDefinition[]; loadedGroups: string[]; summaryCalls?: SummaryMetric[]; contextWindow?: number | null; kind?: 'run' | 'preview'; previousAttempts?: ContextStats[] }): ContextStats {
  const counts: Record<ContextCategory, number> = { messages: 0, toolResults: 0, tools: 0, system: 0, skills: 0, manual: 0, work: 0, summary: 0 };
  const seen = new Set((input.previousAttempts ?? []).flatMap(attempt => attempt.toolResults ?? []).flatMap(result => result.sourceId ? [result.sourceId] : []));
  const toolResults: ContextToolResult[] = [];
  for (const message of input.messages) {
    if (message.role === 'tool') {
      const result = toolResult(input.runId, message, seen);
      toolResults.push(result);
      counts.toolResults += result.tokens;
      continue;
    }
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
    schemaVersion: 2, runId: input.runId, round: input.round, ...(input.attemptId ? { attemptId: input.attemptId } : {}), ...(input.kind === 'preview' ? {} : { phase: 'estimate' as const }), recordedAt: new Date().toISOString(), estimator: ESTIMATOR,
    estimatedInputTokens, estimatedOutputTokens: 0, contextWindow: input.contextWindow ?? null, kind: input.kind ?? 'run', historyBudget: HISTORY_TOKEN_BUDGET,
    historyOverBudget: messagesTokens(input.messages.filter(m => m.role !== 'system')) > HISTORY_TOKEN_BUDGET,
    categories: Object.entries(counts).map(([id, tokens]) => ({ id: id as ContextCategory, tokens })), tools, toolResults, loadedGroups: input.loadedGroups,
    baseline: { estimatedInputTokens: estimatedInputTokens - counts.tools + full, toolTokens: full, note: 'same-messages-full-tools' },
    actual: null, summaryCalls: input.summaryCalls ?? [], durationMs: 0,
    totals: contextTotals([]),
  };
}

function attemptKey(row: ContextStats) {
  return row.attemptId ? `attempt:${row.attemptId}` : `legacy:${row.round}`;
}

/** Before/after events merge by attempt; legacy rows retain their one-entry-per-round read semantics. */
export function uniqueContextAttempts(rounds: ContextStats[]) {
  const latest = new Map<string, ContextStats>();
  for (const row of rounds) {
    const key = attemptKey(row);
    const previous = latest.get(key);
    if (!previous || ((previous.phase !== 'final' && !(previous.actual && !row.actual)) || row.phase === 'final')) latest.set(key, row);
  }
  return [...latest.values()];
}

function sumKnown(usages: Array<ModelUsage | null>, key: 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningOutputTokens') {
  const known = usages.flatMap(usage => typeof usage?.[key] === 'number' ? [usage[key] as number] : []);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

function fieldTotal(rows: ContextStats[], summaries: SummaryMetric[], key: 'inputTokens' | 'outputTokens'): ContextFieldTotal {
  const usages = [...rows.map(row => ({ actual: row.actual, estimate: key === 'inputTokens' ? row.estimatedInputTokens : row.estimatedOutputTokens })), ...summaries.map(row => ({ actual: row.actual, estimate: key === 'inputTokens' ? row.estimatedInputTokens : row.estimatedOutputTokens }))];
  const actualTokens = sumKnown(usages.map(row => row.actual), key);
  const estimatedGapTokens = usages.reduce((sum, row) => sum + (typeof row.actual?.[key] === 'number' ? 0 : row.estimate), 0);
  return {
    actualTokens,
    estimatedGapTokens,
    preferredTokens: usages.length ? (actualTokens ?? 0) + estimatedGapTokens : null,
    measuredAttempts: usages.filter(row => typeof row.actual?.[key] === 'number').length,
    estimatedAttempts: usages.filter(row => typeof row.actual?.[key] !== 'number').length,
  };
}

export function contextTotals(rounds: ContextStats[], summaries: SummaryMetric[] = []): ContextTotals {
  const values = uniqueContextAttempts(rounds);
  const usages = [...values.map(row => row.actual), ...summaries.map(row => row.actual)];
  const requests = values.length + summaries.length;
  const toolResults = values.flatMap(row => row.toolResults ?? []);
  const input = fieldTotal(values, summaries, 'inputTokens');
  const output = fieldTotal(values, summaries, 'outputTokens');
  return {
    requests,
    usageReceipts: usages.filter(hasModelUsage).length,
    estimatedInputTokens: values.reduce((sum, row) => sum + row.estimatedInputTokens, 0) + summaries.reduce((sum, row) => sum + row.estimatedInputTokens, 0),
    estimatedOutputTokens: values.reduce((sum, row) => sum + row.estimatedOutputTokens, 0) + summaries.reduce((sum, row) => sum + row.estimatedOutputTokens, 0),
    actualInputTokens: input.actualTokens, actualOutputTokens: output.actualTokens,
    cachedInputTokens: sumKnown(usages, 'cachedInputTokens'), reasoningOutputTokens: sumKnown(usages, 'reasoningOutputTokens'),
    cachedInputReports: usages.filter(usage => typeof usage?.cachedInputTokens === 'number').length,
    reasoningOutputReports: usages.filter(usage => typeof usage?.reasoningOutputTokens === 'number').length,
    usageComplete: requests > 0 && usages.every(usage => typeof usage?.inputTokens === 'number' && typeof usage.outputTokens === 'number'),
    durationMs: values.reduce((sum, row) => sum + row.durationMs, 0) + summaries.reduce((sum, row) => sum + row.durationMs, 0),
    input, output,
    toolActions: new Set(toolResults.flatMap(result => result.sourceId ? [result.sourceId] : [])).size,
    toolResultTokens: toolResults.reduce((sum, result) => sum + result.tokens, 0),
    firstToolResultTokens: toolResults.filter(result => result.inclusion === 'first').reduce((sum, result) => sum + result.tokens, 0),
    repeatToolResultTokens: toolResults.filter(result => result.inclusion === 'repeat').reduce((sum, result) => sum + result.tokens, 0),
    unknownToolResultTokens: toolResults.filter(result => result.inclusion === 'unknown').reduce((sum, result) => sum + result.tokens, 0),
  };
}
