import { describe, expect, it } from 'vitest';
import { costMicroUsd, previousCumulative, storedRunUsage, usageDelta } from './run-usage.js';

const numbers = { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 40, costMicroUsd: 5000 };

describe('resume usage deltas', () => {
  it('subtracts the previous cumulative total and clamps at zero', () => {
    expect(usageDelta(numbers, { inputTokens: 1800, cachedInputTokens: 100, outputTokens: 90, costMicroUsd: 8000 })).toEqual({ inputTokens: 800, cachedInputTokens: 0, outputTokens: 50, costMicroUsd: 3000 });
    expect(usageDelta(numbers, { inputTokens: 10, cachedInputTokens: null, outputTokens: 90, costMicroUsd: null })).toEqual({ inputTokens: 0, cachedInputTokens: null, outputTokens: 50, costMicroUsd: null });
    expect(usageDelta({ inputTokens: null, cachedInputTokens: null, outputTokens: null, costMicroUsd: null }, { inputTokens: 5, cachedInputTokens: 1, outputTokens: null, costMicroUsd: 3 })).toEqual({ inputTokens: 5, cachedInputTokens: 1, outputTokens: null, costMicroUsd: 3 });
    expect(costMicroUsd(0.25)).toBe(250_000);
    expect(costMicroUsd(0)).toBe(0);
    expect(costMicroUsd(null)).toBeNull();
  });

  it('prefers usageJson.cumulative over columns, and keeps the current total when the run is not a resume', () => {
    const current = { inputTokens: 1800, cachedInputTokens: 300, outputTokens: 90, costMicroUsd: 8000 };
    const fromJson = storedRunUsage({ resume: true, previousUsageJson: JSON.stringify({ cumulative: { inputTokens: 999, cachedInputTokens: 10, outputTokens: 20, costMicroUsd: 1000 } }), previousColumns: numbers, current });
    expect(fromJson).toEqual({ inputTokens: 801, cachedInputTokens: 290, outputTokens: 70, costMicroUsd: 7000 });
    const fromColumns = storedRunUsage({ resume: true, previousUsageJson: null, previousColumns: numbers, current });
    expect(fromColumns.inputTokens).toBe(800);
    expect(storedRunUsage({ resume: false, previousUsageJson: JSON.stringify({ cumulative: numbers }), previousColumns: numbers, current })).toEqual(current);
    expect(previousCumulative('not-json', numbers)).toEqual(numbers);
  });
});
