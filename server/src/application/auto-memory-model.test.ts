import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryModelAdapter, readMemoryUsage } from './auto-memory-model.js';
import { SettingsService, type ModelConfig } from './settings.js';
class Settings extends SettingsService {
  config: ModelConfig = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'private-test-key' };
  async credentials() { return { ...this.config }; }
}
afterEach(() => vi.restoreAllMocks());
describe('memory completion usage', () => {
  it('preserves zero, missing and partial counts and derives only a missing total', () => {
    expect(readMemoryUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, usageStatus: 'reported' });
    expect(readMemoryUsage({ prompt_tokens: 7, completion_tokens: 3 })).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10, usageStatus: 'computed' });
    expect(readMemoryUsage({ prompt_tokens: 7 })).toEqual({ inputTokens: 7, outputTokens: null, totalTokens: null, usageStatus: 'partial' });
    expect(readMemoryUsage({ prompt_tokens: -1, completion_tokens: '3', total_tokens: Infinity })).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, usageStatus: 'unavailable' });
  });
  it('freezes model credentials and requests non-streaming JSON only for the supported provider', async () => {
    const settings = new Settings();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ model: 'actual-model', choices: [{ message: { content: '{"summary":"","candidates":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })));
    const prepared = await new MemoryModelAdapter(settings).prepare();
    settings.config = { baseUrl: 'https://another.example/v1', model: 'changed', apiKey: 'changed-key' };
    const result = await prepared.complete([{ role: 'user', content: 'json' }]);
    expect(prepared).toMatchObject({ requestedModel: 'deepseek-flash', provider: 'api.deepseek.com' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model: 'deepseek-flash', stream: false, response_format: { type: 'json_object' } });
    expect(result).toMatchObject({ responseModel: 'actual-model', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
    await new MemoryModelAdapter(settings).complete([]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).not.toHaveProperty('response_format');
  });
  it('retains usage when the model content is invalid and makes no hidden HTTP retries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }))).mockResolvedValueOnce(new Response('secret upstream body', { status: 401 }));
    const adapter = new MemoryModelAdapter(new Settings());
    expect(await adapter.complete([])).toMatchObject({ text: 'not-json', usage: { totalTokens: 5 } });
    await expect(adapter.complete([])).rejects.toThrow('模型服务 HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('preserves aborts while reading the response body', async () => {
    const controller = new AbortController();
    const reason = new DOMException('timeout', 'TimeoutError');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => { controller.abort(reason); throw reason; } } as unknown as Response);
    await expect(new MemoryModelAdapter(new Settings()).complete([], controller.signal)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
