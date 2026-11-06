/** Gaps are repaired from a transactionally watermarked snapshot, never guessed. */
export function runEventOrder(runId: string, seq: number, watermark: number, seen: ReadonlyMap<string, unknown>): 'duplicate' | 'gap' | 'next' {
  if (seq <= watermark || seen.has(`${runId}:${seq}`)) return 'duplicate';
  let next = watermark + 1;
  while (seen.has(`${runId}:${next}`)) next++;
  return Number.isInteger(seq) && seq === next ? 'next' : 'gap';
}

/** Replaying a delayed snapshot can encounter another gap. Release only contiguous prefixes. */
export function replayAfterSnapshot<T extends { runId?: string; seq?: number }>(events: T[], watermarks: Readonly<Record<string, number>>) {
  const through = { ...watermarks }, gaps = new Set<string>(), accepted: T[] = [];
  for (const event of [...events].sort((a, b) => (a.runId ?? '').localeCompare(b.runId ?? '') || (a.seq ?? 0) - (b.seq ?? 0))) {
    if (!event.runId || typeof event.seq !== 'number' || event.seq <= (through[event.runId] ?? 0)) continue;
    if (gaps.has(event.runId)) continue;
    if (!Number.isInteger(event.seq) || event.seq !== (through[event.runId] ?? 0) + 1) { gaps.add(event.runId); continue; }
    through[event.runId] = event.seq; accepted.push(event);
  }
  return { events: accepted, gaps };
}
