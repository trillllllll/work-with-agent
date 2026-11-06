import { it, expect, vi } from 'vitest';
import { SnapshotBatcher } from './snapshot-batcher.js';
it('bounds rapid previews and flushes the newest final value in order', async () => {
  vi.useFakeTimers();
  try {
    const writes: number[] = []; const batch = new SnapshotBatcher(async value => { writes.push(value as number); }, vi.fn());
    for (let i = 0; i < 1000; i++) batch.add(i);
    await vi.advanceTimersByTimeAsync(100);
    batch.add(1000); await batch.finish();
    expect(writes).toEqual([999, 1000]);
    await vi.advanceTimersByTimeAsync(1000); expect(writes).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});
it('aborts on persistence failure and rejects finalization', async () => {
  const abort = vi.fn(); const batch = new SnapshotBatcher(async () => { throw new Error('lease lost'); }, abort);
  batch.add(1); await expect(batch.finish()).rejects.toThrow('lease lost'); expect(abort).toHaveBeenCalledOnce();
});
it('coalesces previews behind a slow transaction instead of queuing stale snapshots', async () => {
  vi.useFakeTimers();
  try {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const writes: number[] = [];
    const batch = new SnapshotBatcher<number>(async value => { writes.push(value); if (value === 1) await held; }, vi.fn());
    batch.add(1); await vi.advanceTimersByTimeAsync(100);
    for (let i = 2; i <= 8; i++) { batch.add(i); await vi.advanceTimersByTimeAsync(100); }
    release(); await batch.finish(); expect(writes).toEqual([1, 8]);
  } finally { vi.useRealTimers(); }
});
