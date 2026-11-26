// Public context_stats payload. Estimates describe text composition; provider
// usage is separate because it cannot be attributed to individual blocks.
export type ContextUsageFieldTotal = {
  actualTokens: number | null;
  estimatedGapTokens: number;
  preferredTokens: number | null;
  measuredAttempts: number;
  estimatedAttempts: number;
};
export type ContextUsage = {
  schemaVersion: 1 | 2; runId: string; round: number; recordedAt: string; estimator: string;
  attemptId?: string;
  phase?: 'estimate' | 'final';
  estimatedInputTokens: number; contextWindow: number | null; historyOverBudget: boolean;
  /** 'preview' = pre-send estimate of the next request; absent on stats recorded before this field existed. */
  kind?: 'run' | 'preview';
  categories: Array<{ id: 'messages' | 'toolResults' | 'tools' | 'system' | 'skills' | 'manual' | 'work' | 'summary'; tokens: number }>;
  tools: Array<{ name: string; tokens: number }>; loadedGroups: string[];
  toolResults?: Array<{ sourceId: string | null; toolCallId: string | null; tokens: number; inclusion: 'first' | 'repeat' | 'unknown' }>;
  baseline: { estimatedInputTokens: number; toolTokens: number; note: string };
  actual: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningOutputTokens?: number } | null;
  summaryCalls: Array<{ estimatedInputTokens: number; estimatedOutputTokens: number; actual: unknown; durationMs: number; fallback: boolean }>;
  totals: {
    requests: number; usageReceipts?: number; estimatedInputTokens: number; estimatedOutputTokens: number;
    actualInputTokens: number | null; actualOutputTokens: number | null; cachedInputTokens: number | null;
    reasoningOutputTokens?: number | null; cachedInputReports?: number; reasoningOutputReports?: number;
    usageComplete: boolean; durationMs: number;
    input?: ContextUsageFieldTotal; output?: ContextUsageFieldTotal;
    toolActions?: number; toolResultTokens?: number; firstToolResultTokens?: number; repeatToolResultTokens?: number; unknownToolResultTokens?: number;
  };
};
export function compactTokens(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value); }
export function tokenPercent(value: number, total: number) { return total > 0 ? (value / total * 100).toFixed(1) : '0.0'; }
/** Share of the model window, or null when the window is unknown. */
export function windowPercent(stats: Pick<ContextUsage, 'estimatedInputTokens' | 'contextWindow'>) {
  return typeof stats.contextWindow === 'number' && stats.contextWindow > 0 ? stats.estimatedInputTokens / stats.contextWindow * 100 : null;
}
export function usageLevel(percent: number | null): 'normal' | 'high' | 'full' {
  if (percent === null) return 'normal';
  return percent >= 100 ? 'full' : percent >= 80 ? 'high' : 'normal';
}
export function shownContextUsage(stats: ContextUsage | null, preview?: ContextUsage | null, busy = false) {
  return busy ? stats ?? preview ?? null : preview ?? stats;
}
