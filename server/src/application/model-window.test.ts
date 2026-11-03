import { describe, expect, it, vi } from 'vitest';
import { probeModelWindow, windowFromModelsPayload } from './model-window.js';
import { SettingsService, type CredentialStore } from './settings.js';

const target = { baseUrl: 'https://api.deepseek.com/', apiKey: 'private-test-key', model: 'deepseek-flash' };
const modelsResponse = (data: unknown[]) => new Response(JSON.stringify({ object: 'list', data }));

describe('context window probe', () => {
  it('reads the window the provider publishes for the configured model only', () => {
    const payload = { data: [{ id: 'deepseek-flash', context_window: 1048576 }, { id: 'other', context_window: 128000 }] };
    expect(windowFromModelsPayload(payload, 'deepseek-flash')).toBe(1048576);
    expect(windowFromModelsPayload(payload, 'DEEPSEEK-FLASH')).toBe(1048576);
    // An unknown model must not borrow a neighbour's window.
    expect(windowFromModelsPayload(payload, 'unknown')).toBeNull();
    expect(windowFromModelsPayload(payload, '')).toBeNull();
    expect(windowFromModelsPayload({ data: 'not-an-array' }, 'deepseek-flash')).toBeNull();
    expect(windowFromModelsPayload(null, 'deepseek-flash')).toBeNull();
  });

  it('accepts the field names other providers use and ignores implausible values', () => {
    expect(windowFromModelsPayload({ data: [{ id: 'm', context_length: 200000 }] }, 'm')).toBe(200000);
    expect(windowFromModelsPayload({ data: [{ id: 'm', max_model_len: 32768 }] }, 'm')).toBe(32768);
    expect(windowFromModelsPayload({ data: [{ id: 'm', inputTokenLimit: 2097152 }] }, 'm')).toBe(2097152);
    expect(windowFromModelsPayload({ data: [{ id: 'm', context_window: '1048576' }] }, 'm')).toBeNull();
    expect(windowFromModelsPayload({ data: [{ id: 'm', context_window: 0 }] }, 'm')).toBeNull();
    expect(windowFromModelsPayload({ data: [{ id: 'm' }] }, 'm')).toBeNull();
  });

  it('asks `{baseUrl}/models` with the stored key and reports the upstream status without its body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse([{ id: 'deepseek-flash', context_window: 1048576 }]));
    await expect(probeModelWindow(target)).resolves.toEqual({ contextWindow: 1048576, model: 'deepseek-flash', reason: 'ok' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/models');
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer private-test-key');

    fetchMock.mockResolvedValueOnce(new Response('secret upstream body', { status: 401 }));
    await expect(probeModelWindow(target)).resolves.toEqual({ contextWindow: null, model: 'deepseek-flash', reason: 'http_error', status: 401 });
    vi.restoreAllMocks();
  });

  it('falls back to a manual field when the service is unreachable or publishes only ids', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(probeModelWindow(target)).resolves.toEqual({ contextWindow: null, model: 'deepseek-flash', reason: 'unreachable' });

    fetchMock.mockResolvedValueOnce(modelsResponse([{ id: 'deepseek-flash' }]));
    await expect(probeModelWindow(target)).resolves.toEqual({ contextWindow: null, model: 'deepseek-flash', reason: 'not_provided' });
    vi.restoreAllMocks();
  });
});

const storedKey: CredentialStore = { read: async () => 'stored-key', write: async () => {}, clear: async () => {} };

/** Stored settings without touching the database; `probeContextWindow` only reads them. */
class DraftSettings extends SettingsService {
  stored: { openaiBaseUrl: string; openaiModel: string; openaiContextWindow: number } | null = { openaiBaseUrl: 'https://api.deepseek.com', openaiModel: 'deepseek-flash', openaiContextWindow: 0 };
  async getStored() { return this.stored as never; }
}

describe('settings draft probe', () => {
  it('lets unsaved form values win over stored ones and reuses the stored key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse([{ id: 'draft-model', context_window: 200000 }]));
    const settings = new DraftSettings(storedKey);
    await expect(settings.probeContextWindow({ baseUrl: 'https://draft.example/v1/', model: 'draft-model' })).resolves.toEqual({ contextWindow: 200000, model: 'draft-model', reason: 'ok' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://draft.example/v1/models');
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer stored-key');
    vi.restoreAllMocks();
  });

  it('rejects a draft without base url or model, and an invalid address, before any request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const settings = new DraftSettings(storedKey);
    settings.stored = null;
    await expect(settings.probeContextWindow({})).rejects.toThrow('请先填写接口地址和模型名称');
    settings.stored = { openaiBaseUrl: 'https://api.deepseek.com', openaiModel: 'deepseek-flash', openaiContextWindow: 0 };
    await expect(settings.probeContextWindow({ baseUrl: 'ftp://nope' })).rejects.toThrow('接口地址必须是有效的 HTTP(S) URL');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('asks for a key instead of guessing one', async () => {
    const settings = new DraftSettings({ read: async () => null, write: async () => {}, clear: async () => {} });
    await expect(settings.probeContextWindow({})).rejects.toThrow('请先填写 API Key');
  });
});
