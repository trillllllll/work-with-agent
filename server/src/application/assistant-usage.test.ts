import { describe, expect, it } from 'vitest';
import { aggregateAssistantUsage, type AssistantUsageRun } from './assistant-usage.js';

const FROM_MS = Date.parse('2099-06-02T00:00:00.000Z');
const TO_MS = Date.parse('2099-06-09T00:00:00.000Z');

const run = (extra: Partial<AssistantUsageRun> & Pick<AssistantUsageRun, 'id' | 'updatedAt'>): AssistantUsageRun => ({
  conversationId: 'conv-1',
  identityId: 'work',
  model: 'm1',
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  createdAt: extra.updatedAt,
  completedAt: extra.updatedAt,
  ...extra,
});

const aggregate = (runs: AssistantUsageRun[], tz?: string | null) => aggregateAssistantUsage(runs, { fromMs: FROM_MS, toMs: TO_MS, tz });

describe('assistant usage aggregation', () => {
  it('counts every run in the half-open window and keeps missing usage as zero tokens', () => {
    const usage = aggregate([
      run({ id: 'a', updatedAt: '2099-06-02T00:00:00.000Z', inputTokens: 300, cachedInputTokens: 120, outputTokens: 50 }),
      run({ id: 'b', updatedAt: '2099-06-03T12:00:00.000Z' }),
      run({ id: 'out-before', updatedAt: '2099-06-01T23:59:59.000Z' }),
      run({ id: 'out-after', updatedAt: '2099-06-09T00:00:00.000Z' }),
    ]);
    expect(usage.totals).toEqual({ runs: 2, runsWithUsage: 1, durationMs: 0, inputTokens: 300, cachedInputTokens: 120, outputTokens: 50 });
    expect(usage.byIdentity).toEqual([{ key: 'work', runs: 2, durationMs: 0, inputTokens: 300, cachedInputTokens: 120, outputTokens: 50 }]);
  });

  it('falls back to the work identity and sorts groups by runs then key', () => {
    const usage = aggregate([
      run({ id: 'a', updatedAt: '2099-06-02T00:00:00.000Z', identityId: '', inputTokens: 10, outputTokens: 1 }),
      run({ id: 'b', conversationId: 'conv-2', updatedAt: '2099-06-02T01:00:00.000Z', identityId: 'study', inputTokens: 20, outputTokens: 2 }),
      run({ id: 'c', conversationId: 'conv-3', updatedAt: '2099-06-02T02:00:00.000Z', identityId: 'study', inputTokens: 30, outputTokens: 3 }),
    ]);
    expect(usage.byIdentity.map((group) => [group.key, group.runs])).toEqual([['study', 2], ['work', 1]]);
    expect(usage.byIdentity[0]).toMatchObject({ inputTokens: 50, outputTokens: 5 });
  });

  it('keeps a usage-less model-less run out of byModel but in the identity group', () => {
    const usage = aggregate([
      run({ id: 'reported', conversationId: 'conv-2', updatedAt: '2099-06-02T00:00:00.000Z', model: null, inputTokens: 10, outputTokens: 1 }),
      run({ id: 'silent', conversationId: 'conv-3', updatedAt: '2099-06-02T01:00:00.000Z', model: null }),
    ]);
    expect(usage.byModel.map((group) => group.key)).toEqual(['unknown']);
    expect(usage.byModel[0]).toMatchObject({ runs: 1, inputTokens: 10, outputTokens: 1 });
    expect(usage.byIdentity[0]).toMatchObject({ key: 'work', runs: 2 });
  });

  it('buckets days in the requested zone and defaults to UTC', () => {
    const runs = [
      run({ id: 'early', conversationId: 'conv-1', updatedAt: '2099-06-02T15:59:00.000Z', inputTokens: 100, outputTokens: 10 }),
      run({ id: 'late', conversationId: 'conv-1', updatedAt: '2099-06-02T16:30:00.000Z', inputTokens: 200, outputTokens: 20 }),
    ];
    const utc = aggregate(runs);
    expect(utc.byDay).toEqual([
      { date: '2099-06-02', runs: 2, inputTokens: 300, outputTokens: 30 },
    ]);
    const shanghai = aggregate(runs, 'Asia/Shanghai');
    expect(shanghai.byDay).toEqual([
      { date: '2099-06-02', runs: 1, inputTokens: 100, outputTokens: 10 },
      { date: '2099-06-03', runs: 1, inputTokens: 200, outputTokens: 20 },
    ]);
  });

  it('rejects an unknown zone', () => {
    expect(() => aggregate([], 'Not/AZone')).toThrow();
  });
});
