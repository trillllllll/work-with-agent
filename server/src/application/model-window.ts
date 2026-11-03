/** Fields providers use to publish a model window in `GET /models`; the first plausible integer wins. */
const WINDOW_FIELDS = ['context_window', 'context_length', 'max_context_length', 'max_model_len', 'max_context_window', 'contextWindow', 'inputTokenLimit'] as const;
/** Same plausible range the settings form accepts, so a probe can never store something the form rejects. */
export const MODEL_WINDOW_MIN = 1024;
export const MODEL_WINDOW_MAX = 10_000_000;

export type ModelWindowTarget = { baseUrl: string; apiKey: string; model: string };
export type ModelWindowProbe = {
  contextWindow: number | null;
  /** The model id the probe looked for, echoed so the UI can name the entry it read. */
  model: string;
  /** Why a probe came back empty. `ok` carries the window. */
  reason: 'ok' | 'unreachable' | 'http_error' | 'not_provided';
  /** Upstream status for `http_error`, never the upstream body. */
  status?: number;
};

const readWindow = (entry: Record<string, unknown>) => {
  for (const field of WINDOW_FIELDS) {
    const value = entry[field];
    if (typeof value === 'number' && Number.isInteger(value) && value >= MODEL_WINDOW_MIN && value <= MODEL_WINDOW_MAX) return value;
  }
  return null;
};

/** Picks the window of one model out of an OpenAI-style `/models` payload. */
export function windowFromModelsPayload(payload: unknown, model: string): number | null {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const wanted = model.trim().toLowerCase();
  if (!wanted) return null;
  const entry = data.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item) && typeof (item as { id?: unknown }).id === 'string' && (item as { id: string }).id.toLowerCase() === wanted);
  return entry ? readWindow(entry) : null;
}

/**
 * Asks the provider what window the configured model has. Never throws: a missing
 * answer is normal for proxies and for providers that only publish ids, and the
 * settings form keeps a manual field for exactly that case.
 */
export async function probeModelWindow(target: ModelWindowTarget, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<ModelWindowProbe> {
  const model = target.model.trim();
  const url = `${target.baseUrl.replace(/\/+$/, '')}/models`;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${target.apiKey}`, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { contextWindow: null, model, reason: 'unreachable' };
  }
  if (!response.ok) return { contextWindow: null, model, reason: 'http_error', status: response.status };
  const payload = await response.json().catch(() => null);
  const contextWindow = windowFromModelsPayload(payload, model);
  return contextWindow ? { contextWindow, model, reason: 'ok' } : { contextWindow: null, model, reason: 'not_provided' };
}
