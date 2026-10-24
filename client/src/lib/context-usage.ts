// Public context_stats payload. Estimates describe text composition; provider
// usage is separate because it cannot be attributed to individual blocks.
export type ContextUsage = {
  schemaVersion: 1; runId: string; round: number; recordedAt: string; estimator: string;
  estimatedInputTokens: number; contextWindow: number | null; historyOverBudget: boolean;
  categories: Array<{ id: 'messages' | 'tools' | 'system' | 'skills' | 'manual' | 'work' | 'summary'; tokens: number }>;
  tools: Array<{ name: string; tokens: number }>; loadedGroups: string[];
  baseline: { estimatedInputTokens: number; toolTokens: number; note: string };
  actual: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | null;
  summaryCalls: Array<{ estimatedInputTokens: number; estimatedOutputTokens: number; actual: unknown; durationMs: number; fallback: boolean }>;
  totals: { requests: number; estimatedInputTokens: number; estimatedOutputTokens: number; actualInputTokens: number | null; actualOutputTokens: number | null; cachedInputTokens: number | null; usageComplete: boolean; durationMs: number };
};
export function compactTokens(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value); }
export function tokenPercent(value: number, total: number) { return total > 0 ? (value / total * 100).toFixed(1) : '0.0'; }
