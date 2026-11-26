import { describe, expect, it } from 'vitest';
import { mergeModelUsage, readOpenAIUsage, type ModelUsage, type ModelUsageFrame } from './model-usage.js';

function collect(frames: ModelUsageFrame[]) {
  let usage: ModelUsage = {};
  for (const frame of frames) usage = mergeModelUsage(usage, frame);
  return usage;
}

describe('OpenAI-compatible attempt usage', () => {
  it('keeps final valid fields from repeated cumulative snapshots, including real zero', () => {
    const frames = [
      { usage: { prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 2 } } },
      { usage: { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 6 } } },
      { usage: { prompt_tokens: 250, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } },
    ].map(chunk => readOpenAIUsage(chunk, 'fixture')!);
    expect(collect(frames)).toEqual({ inputTokens: 250, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 6, model: 'fixture' });
  });

  it('adds only explicitly incremental mock frames', () => {
    expect(collect([
      { inputTokens: 10, outputTokens: 1, semantics: 'delta' },
      { inputTokens: 20, outputTokens: 2, cachedInputTokens: 0, semantics: 'delta' },
    ])).toEqual({ inputTokens: 30, outputTokens: 3, cachedInputTokens: 0 });
  });

  it('does not invent values for missing or invalid usage, cache, or hidden reasoning', () => {
    expect(readOpenAIUsage({ usage: { prompt_tokens: -1, completion_tokens: '3' } }, 'fixture')).toBeUndefined();
    expect(readOpenAIUsage({}, 'fixture')).toBeUndefined();
    expect(collect([
      readOpenAIUsage({ usage: { prompt_tokens: 10, completion_tokens: 2 } }, 'fixture')!,
      readOpenAIUsage({ usage: { completion_tokens: 3 } }, 'fixture')!,
    ])).toEqual({ inputTokens: 10, outputTokens: 3, model: 'fixture' });
  });
});
