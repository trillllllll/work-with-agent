/** Pure helpers for the runner settings forms. The server remains the source of truth. */

export type ConcurrencyReport = { maxConcurrent: number | null; name?: string };

export type ParallelLimit = { limit: number; limiterName: string | null };

/**
 * Cap for a project's saved default parallelism: the smallest concurrency a location's
 * computer has reported. Computers that have not reported a number do not tighten the cap below 4.
 */
export function defaultParallelLimit(reports: readonly ConcurrencyReport[]): ParallelLimit {
  let limit = 4;
  let limiterName: string | null = null;
  for (const report of reports) {
    const max = report.maxConcurrent;
    if (typeof max !== 'number' || !Number.isFinite(max) || max >= limit) continue;
    limit = max;
    limiterName = report.name ?? null;
  }
  return { limit, limiterName };
}

/** Start-time cap. A selected computer with no reported concurrency counts as 0, matching the server. */
export function runParallelCap(reported: readonly (number | null | undefined)[]): number {
  if (!reported.length) return 4;
  let limit = Number.POSITIVE_INFINITY;
  for (const value of reported) {
    const max = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    if (max < limit) limit = max;
  }
  if (!Number.isFinite(limit)) return 4;
  return Math.min(4, Math.max(0, limit));
}

export function parallelCapForNodes(
  nodeIds: readonly string[],
  nodes: readonly { id: string; capabilities?: { maxConcurrent?: number | null } | null }[] | undefined,
): number {
  if (!nodeIds.length || !nodes) return 4;
  return runParallelCap(nodeIds.map((id) => {
    const node = nodes.find((item) => item.id === id);
    if (!node) return 0;
    const max = node.capabilities?.maxConcurrent;
    return typeof max === 'number' && Number.isFinite(max) ? max : 0;
  }));
}

export type TopicBindingRef = { scopeId: string; projectArchived?: boolean };

/** Topics that have no usable project. A binding whose project is archived does not count. */
export function topicsWithoutProject<T extends { id: string }>(topics: readonly T[], bindings: readonly TopicBindingRef[]): T[] {
  const assigned = new Set(bindings.filter((binding) => !binding.projectArchived).map((binding) => binding.scopeId));
  return topics.filter((topic) => !assigned.has(topic.id));
}

const branchName = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<!\/)(?<!\.lock)$/;

export function isBranchName(value: string): boolean {
  const name = value.trim();
  return name.length >= 1 && name.length <= 200 && branchName.test(name);
}

export type ProviderReport = { provider?: string; available?: boolean };

/** Name of the first selected computer that has not reported this engine as available. */
export function unavailableEngine(computers: readonly { name: string; providers?: readonly ProviderReport[] | null }[], provider: string): string | null {
  for (const computer of computers) {
    const ready = (computer.providers ?? []).some((item) => item.provider === provider && item.available === true);
    if (!ready) return computer.name;
  }
  return null;
}

export function engineLabel(provider: string): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude') return 'Claude';
  return provider;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export const LOW_DISK_BYTES = 2 * 1024 ** 3;

export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
