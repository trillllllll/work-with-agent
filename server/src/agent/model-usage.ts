export type ModelUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  model?: string;
};

export type ModelUsageFrame = ModelUsage & { semantics?: 'cumulative' | 'delta' };

const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const;

function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** OpenAI-compatible usage frames are cumulative request snapshots. */
export function readOpenAIUsage(chunk: any, model: string): ModelUsageFrame | undefined {
  const usage = chunk?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const cached = usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_output_tokens;
  const frame: ModelUsageFrame = {
    ...(validTokenCount(input) ? { inputTokens: input } : {}),
    ...(validTokenCount(output) ? { outputTokens: output } : {}),
    ...(validTokenCount(cached) ? { cachedInputTokens: cached } : {}),
    ...(validTokenCount(reasoning) ? { reasoningOutputTokens: reasoning } : {}),
    model,
    semantics: 'cumulative',
  };
  return fields.some(field => typeof frame[field] === 'number') ? frame : undefined;
}

export function hasModelUsage(usage: ModelUsage | null | undefined) {
  return fields.some(field => validTokenCount(usage?.[field]));
}

/** Cumulative snapshots replace a field; only an explicitly incremental mock/adapter frame adds it. */
export function mergeModelUsage(current: ModelUsage | null | undefined, frame: ModelUsageFrame): ModelUsage {
  const merged: ModelUsage = { ...(current ?? {}) };
  for (const field of fields) {
    const value = frame[field];
    if (!validTokenCount(value)) continue;
    const next = frame.semantics === 'delta' ? (merged[field] ?? 0) + value : value;
    if (Number.isSafeInteger(next)) merged[field] = next;
  }
  if (frame.model) merged.model = frame.model;
  return merged;
}
