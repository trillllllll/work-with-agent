/** Pure helpers for storing CLI usage. Resume runs keep deltas in the columns and the CLI cumulative total in usageJson.cumulative. */

export type UsageNumbers = { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; costMicroUsd: number | null };

export function int32(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_147_483_647) return null;
  return value;
}
export function int32Any(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) return null;
  return value;
}
/** CLI dollars to integer micro-USD. Null stays null so "not reported" is distinct from zero. */
export function costMicroUsd(costUsd: number | null | undefined): number | null {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return null;
  return int32(Math.round(costUsd * 1_000_000));
}
function asInt(value: unknown): number | null {
  return typeof value === 'number' ? int32(value) : null;
}
export function previousCumulative(usageJson: string | null | undefined, columns: UsageNumbers): UsageNumbers {
  if (usageJson) {
    try {
      const parsed = JSON.parse(usageJson) as { cumulative?: unknown };
      if (parsed && typeof parsed === 'object' && parsed.cumulative && typeof parsed.cumulative === 'object') {
        const cumulative = parsed.cumulative as Record<string, unknown>;
        return { inputTokens: asInt(cumulative.inputTokens), cachedInputTokens: asInt(cumulative.cachedInputTokens), outputTokens: asInt(cumulative.outputTokens), costMicroUsd: asInt(cumulative.costMicroUsd) };
      }
    } catch { /* Fall through to the stored columns. */ }
  }
  return { inputTokens: int32(columns.inputTokens), cachedInputTokens: int32(columns.cachedInputTokens), outputTokens: int32(columns.outputTokens), costMicroUsd: int32(columns.costMicroUsd) };
}
/** Subtract the previous cumulative total. Missing previous counts as 0. Results are clamped at 0. A null current stays null. */
export function usageDelta(prev: UsageNumbers, current: UsageNumbers): UsageNumbers {
  const sub = (next: number | null, previous: number | null) => next == null ? null : Math.max(0, next - (previous ?? 0));
  return { inputTokens: sub(current.inputTokens, prev.inputTokens), cachedInputTokens: sub(current.cachedInputTokens, prev.cachedInputTokens), outputTokens: sub(current.outputTokens, prev.outputTokens), costMicroUsd: sub(current.costMicroUsd, prev.costMicroUsd) };
}
export function storedRunUsage(input: { resume: boolean; previousUsageJson: string | null; previousColumns: UsageNumbers; current: UsageNumbers }): UsageNumbers {
  if (!input.resume) return input.current;
  return usageDelta(previousCumulative(input.previousUsageJson, input.previousColumns), input.current);
}
export function usageJsonFor(input: { model: string | null; numTurns: number | null; cliDurationMs: number | null; raw: unknown; cumulative: UsageNumbers & { costUsd: number | null } }): string {
  return boundedJson({ cumulative: input.cumulative, model: input.model, numTurns: input.numTurns, cliDurationMs: input.cliDurationMs, raw: input.raw ?? null });
}

/** JSON capped at `max` characters without ever cutting it into invalid JSON: an oversized `raw` is dropped first. */
export function boundedJson(value: Record<string, unknown>, max = 8000): string {
  const full = JSON.stringify(value);
  if (full.length <= max) return full;
  const { raw: _raw, ...rest } = value;
  const trimmed = JSON.stringify({ ...rest, raw: null, rawTruncated: true });
  return trimmed.length <= max ? trimmed : JSON.stringify({ rawTruncated: true });
}
