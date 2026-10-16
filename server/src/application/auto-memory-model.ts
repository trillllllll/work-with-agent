import { SettingsService } from './settings.js';

export type MemoryMessages = Array<{ role: 'system' | 'user'; content: string }>;
export type MemoryUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; usageStatus: 'reported' | 'computed' | 'partial' | 'unavailable' };
export type MemoryCompletion = { text: string; usage?: MemoryUsage; responseModel?: string | null; finishReason?: string | null };
export interface MemoryModel {
  complete(messages: MemoryMessages, signal?: AbortSignal): Promise<MemoryCompletion>;
  prepare?(): Promise<MemoryModel & { requestedModel: string; provider: string }>;
}
const tokenCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
export function readMemoryUsage(value: unknown): MemoryUsage {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const inputTokens = tokenCount(usage.prompt_tokens);
  const outputTokens = tokenCount(usage.completion_tokens);
  const reported = tokenCount(usage.total_tokens);
  const computed = reported === null && inputTokens !== null && outputTokens !== null ? tokenCount(inputTokens + outputTokens) : null;
  const totalTokens = reported ?? computed;
  const usageStatus = inputTokens !== null && outputTokens !== null && totalTokens !== null ? (reported !== null ? 'reported' : 'computed') : inputTokens !== null || outputTokens !== null || totalTokens !== null ? 'partial' : 'unavailable';
  return { inputTokens, outputTokens, totalTokens, usageStatus };
}

/** Freeze credentials once for this request; expose only the model and hostname. */
export class MemoryModelAdapter implements MemoryModel {
  constructor(private readonly settings = new SettingsService()) {}
  async prepare() {
    const config = await this.settings.credentials();
    if (!config) throw new Error('未配置模型服务');
    const endpoint = config.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const provider = new URL(endpoint).hostname;
    return {
      requestedModel: config.model,
      provider,
      async complete(messages: MemoryMessages, signal?: AbortSignal): Promise<MemoryCompletion> {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: 'POST', signal,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
            body: JSON.stringify({ model: config.model, messages, stream: false, ...(provider === 'api.deepseek.com' ? { response_format: { type: 'json_object' } } : {}) }),
          });
        } catch {
          if (signal?.aborted) throw signal.reason;
          throw new Error('模型网络请求失败');
        }
        if (!response.ok) throw new Error('模型服务 HTTP ' + response.status);
        let payload: any;
        try { payload = await response.json(); }
        catch { if (signal?.aborted) throw signal.reason; throw new Error('模型服务返回了无效响应 JSON'); }
        return {
          text: typeof payload?.choices?.[0]?.message?.content === 'string' ? payload.choices[0].message.content : '',
          responseModel: typeof payload?.model === 'string' ? payload.model.slice(0, 200) : null,
          finishReason: typeof payload?.choices?.[0]?.finish_reason === 'string' ? payload.choices[0].finish_reason : null,
          usage: readMemoryUsage(payload?.usage),
        };
      },
    };
  }
  async complete(messages: MemoryMessages, signal?: AbortSignal) { return (await this.prepare()).complete(messages, signal); }
}
