import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '../agent.js';
import { buildContextStats, contextTotals, uniqueContextAttempts, type ContextStats } from './context-stats.js';
import { messageTokens } from './context-budget.js';

const tools = [{ type: 'function' as const, function: { name: 'query_tasks', description: 'read', parameters: { type: 'object' } } }];
const source = (id: string, text = 'result') => JSON.stringify({ sourceMessageId: id, toolName: 'query_tasks', success: true, data: { text } });
const messages = (id?: string): ModelMessage[] => [
  { role: 'system', content: 'rules' },
  { role: 'user', content: 'question' },
  ...(id ? [{ role: 'assistant' as const, content: null, tool_calls: [{ id: 'call', type: 'function' as const, function: { name: 'query_tasks', arguments: '{}' } }] }, { role: 'tool' as const, tool_call_id: 'call', content: source(id) }] : []),
];
function stats(attemptId: string, round: number, id?: string, previousAttempts: ContextStats[] = []): ContextStats {
  return buildContextStats({ runId: 'run', attemptId, round, messages: messages(id), tools, fullTools: tools, loadedGroups: ['tasks'], previousAttempts });
}

describe('context attempts and projected tool results', () => {
  it('merges estimate/final replay by attempt but keeps a real resend in the same round', () => {
    const estimate = stats('a', 0);
    const final = { ...estimate, phase: 'final' as const, actual: { inputTokens: 20, outputTokens: 0 }, estimatedOutputTokens: 4 };
    const resend = { ...stats('b', 0), phase: 'final' as const, actual: { inputTokens: 30, outputTokens: 2 } };
    expect(uniqueContextAttempts([estimate, final, estimate, resend, final]).map(row => row.attemptId)).toEqual(['a', 'b']);
    expect(contextTotals([estimate, final, estimate, resend, final])).toMatchObject({ requests: 2, usageReceipts: 2, actualInputTokens: 50, actualOutputTokens: 2, estimatedInputTokens: estimate.estimatedInputTokens * 2 });
  });

  it('retains estimates without receipts and reads legacy before/after rows once per round', () => {
    const legacy = stats('legacy', 0);
    const old = { ...legacy, attemptId: undefined, phase: undefined, schemaVersion: 1 as const };
    const oldFinal = { ...old, actual: { inputTokens: 0, outputTokens: 0 } };
    const missing = { ...stats('missing', 1), phase: 'final' as const };
    const totals = contextTotals([old, oldFinal, old, missing]);
    expect(totals).toMatchObject({ requests: 2, usageReceipts: 1, actualInputTokens: 0, actualOutputTokens: 0, estimatedInputTokens: old.estimatedInputTokens + missing.estimatedInputTokens });
    expect(totals.input).toMatchObject({ actualTokens: 0, estimatedGapTokens: missing.estimatedInputTokens, measuredAttempts: 1, estimatedAttempts: 1 });
    expect(missing.actual).toBeNull();
    expect(contextTotals([{ ...missing, actual: {} }]).usageReceipts).toBe(0);
  });

  it('separates projected tool results and counts first inclusion plus every repeat', () => {
    const first = { ...stats('a', 0, 'message-1'), phase: 'final' as const };
    const repeated = { ...stats('b', 1, 'message-1', [first]), phase: 'final' as const };
    const third = { ...stats('c', 2, 'message-1', [first, repeated]), phase: 'final' as const };
    expect(repeated.toolResults?.[0].inclusion).toBe('repeat');
    expect(third.toolResults?.[0].inclusion).toBe('repeat');
    for (const row of [first, repeated, third]) expect(row.categories.reduce((sum, category) => sum + category.tokens, 0)).toBe(row.estimatedInputTokens);
    const once = first.toolResults![0].tokens;
    expect(contextTotals([first, repeated, first, third, repeated])).toMatchObject({
      requests: 3, toolActions: 1, toolResultTokens: once * 3, firstToolResultTokens: once, repeatToolResultTokens: once * 2, unknownToolResultTokens: 0,
    });
    expect(first.categories.find(category => category.id === 'messages')!.tokens).toBe(stats('plain', 0).categories.find(category => category.id === 'messages')!.tokens + messageTokens(messages('message-1')[2]));
    expect(first.categories.find(category => category.id === 'toolResults')!.tokens).toBe(once);
  });

  it('uses measured fields first and exposes partial cache/reasoning coverage without zero fill', () => {
    const measured = { ...stats('a', 0), phase: 'final' as const, actual: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 }, estimatedOutputTokens: 8 };
    const missing = { ...stats('b', 1), phase: 'final' as const, actual: { inputTokens: 50, outputTokens: 5 }, estimatedOutputTokens: 8 };
    const noUsage = { ...stats('c', 2), phase: 'final' as const, estimatedOutputTokens: 3 };
    const totals = contextTotals([measured, missing, noUsage]);
    expect(totals.input).toMatchObject({ actualTokens: 150, estimatedGapTokens: noUsage.estimatedInputTokens, preferredTokens: 150 + noUsage.estimatedInputTokens, measuredAttempts: 2, estimatedAttempts: 1 });
    expect(totals.output).toMatchObject({ actualTokens: 25, estimatedGapTokens: 3, preferredTokens: 28, measuredAttempts: 2, estimatedAttempts: 1 });
    expect(totals).toMatchObject({ usageReceipts: 2, requests: 3, cachedInputTokens: 0, cachedInputReports: 1, reasoningOutputTokens: null, reasoningOutputReports: 0, usageComplete: false });
  });
});
