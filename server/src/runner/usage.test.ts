import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseStream, parseUsage } from './adapters.js';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const result = { outcome: 'ready_for_review', summary: 'Updated the workspace.', questions: [], artifacts: [], checks: [{ name: 'unit', passed: true, detail: 'ok' }], unfinished: [], proposedCommands: [] };

describe('CLI usage parsing', () => {
  it('reads the doc-shaped Codex and Claude fixtures', () => {
    const codex = parseStream('codex', fixture('codex-exec.jsonl'));
    expect(codex.sessionId).toBe('thread_doc_sample');
    expect(codex.result).toMatchObject(result);
    expect(codex.events.map((event) => event.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
    expect(codex.usage).toMatchObject({ model: null, inputTokens: 24789, cachedInputTokens: 5120, outputTokens: 890, costUsd: null, numTurns: null, cliDurationMs: null });
    expect(codex.usage?.inputTokens).toBe(24789);
    expect(codex.usage?.raw).toMatchObject({ cache_write_input_tokens: 640, reasoning_output_tokens: 210 });

    const claude = parseStream('claude', fixture('claude-stream.jsonl'));
    expect(claude.sessionId).toBe('sess_doc');
    expect(claude.result).toMatchObject(result);
    expect(claude.events.map((event) => event.type)).toEqual(['system', 'assistant', 'result']);
    // modelUsage sums both models (subagents included). cache creation counts as input, not as cached.
    expect(claude.usage).toMatchObject({ model: 'claude-sonnet-4-5', inputTokens: 1665, cachedInputTokens: 410, outputTokens: 170, costUsd: 0.25, numTurns: 3, cliDurationMs: 3456 });
  });

  it('keeps the last Codex turn.completed total and does not add cached or reasoning tokens', () => {
    const text = [
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 5, cache_write_input_tokens: 7 } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 250, cached_input_tokens: 80, output_tokens: 30, reasoning_output_tokens: 12, cache_write_input_tokens: 9 } }),
    ].join('\n');
    expect(parseUsage('codex', text)).toMatchObject({ inputTokens: 250, cachedInputTokens: 80, outputTokens: 30, costUsd: null, model: null });
    expect(parseUsage('codex', JSON.stringify({ type: 'turn.failed', error: { message: 'no' } }))).toBeNull();
    expect(parseUsage('codex', JSON.stringify({ type: 'turn.completed' }))).toBeNull();
    const lastWithoutUsage = `${text}\n${JSON.stringify({ type: 'turn.completed' })}`;
    expect(parseUsage('codex', lastWithoutUsage)).toBeNull();
  });

  it('falls back to Claude usage when modelUsage is absent and ignores non-numbers', () => {
    const fallback = JSON.stringify({
      type: 'result', subtype: 'success', total_cost_usd: 0.5, num_turns: 2, duration_ms: 40,
      usage: { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 400, output_tokens: 150 },
    });
    expect(parseUsage('claude', fallback)).toMatchObject({ model: null, inputTokens: 1600, cachedInputTokens: 400, outputTokens: 150, costUsd: 0.5, numTurns: 2, cliDurationMs: 40 });
    const named = [
      JSON.stringify({ type: 'result', modelUsage: { 'claude-opus-4-1': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } }, total_cost_usd: 0.25, num_turns: 1, duration_ms: 9 }),
    ].join('\n');
    expect(parseUsage('claude', named)?.model).toBe('claude-opus-4-1');
    expect(parseUsage('claude', named)).toMatchObject({ inputTokens: 17, cachedInputTokens: 3, outputTokens: 2 });
    const initWins = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5' }),
      named,
    ].join('\n');
    expect(parseUsage('claude', initWins)?.model).toBe('claude-sonnet-4-5');
    expect(parseUsage('claude', JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5' }))).toMatchObject({ model: 'claude-sonnet-4-5', inputTokens: null, costUsd: null, numTurns: null });
    expect(parseUsage('claude', '{"type":"assistant"}')).toBeNull();
    const garbage = [
      'not json',
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5' }),
      JSON.stringify({ type: 'result', total_cost_usd: 'nope', num_turns: 1.5, duration_ms: -4, usage: { input_tokens: '10', cache_read_input_tokens: 2, output_tokens: 3 } }),
      '{"trunc',
    ].join('\n');
    const parsed = parseStream('claude', garbage);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.usage).toMatchObject({ model: 'claude-sonnet-4-5', inputTokens: 2, cachedInputTokens: 2, outputTokens: 3, costUsd: null, numTurns: null, cliDurationMs: null });
    const codexGarbage = '{"type":"thread.started","thread_id":"t"}\nNOT JSON\n{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":1,"output_tokens":2,"reasoning_output_tokens":9}}\n{"trunc';
    const codex = parseStream('codex', codexGarbage);
    expect(codex.events.map((event) => event.type)).toEqual(['thread.started', 'turn.completed']);
    expect(codex.usage).toMatchObject({ inputTokens: 5, cachedInputTokens: 1, outputTokens: 2 });
    expect(codex.running).toBe(false);
  });
});
