import { it, expect } from 'vitest';
import { runEventOrder, replayAfterSnapshot } from './run-event-order.js';
it('repairs missing and reordered events and rejects snapshot/stream duplicates', () => {
  const seen = new Map<string, unknown>();
  expect(runEventOrder('r', 11, 10, seen)).toBe('next'); seen.set('r:11', {});
  expect(runEventOrder('r', 11, 10, seen)).toBe('duplicate');
  expect(runEventOrder('r', 13, 10, seen)).toBe('gap'); seen.set('r:13', {});
  expect(runEventOrder('r', 12, 10, seen)).toBe('next');
  expect(runEventOrder('r', 12, 13, seen)).toBe('duplicate');
  expect(runEventOrder('r', 14, 13, seen)).toBe('next');
  expect(runEventOrder('r', NaN, 13, seen)).toBe('gap');
});

it('keeps a second gap buffered when it arrives during snapshot recovery', () => {
  const events = [6, 4, 3].map(seq => ({ runId: 'r', seq }));
  const replay = replayAfterSnapshot(events, { r: 3 });
  expect(replay.events.map(event => event.seq)).toEqual([4]); expect([...replay.gaps]).toEqual(['r']);
  const recovered = replayAfterSnapshot(events, { r: 6 });
  expect(recovered.events).toEqual([]); expect(recovered.gaps.size).toBe(0);
});
it('accepts the reordered contiguous tail once a missing event arrives', () => {
  const replay = replayAfterSnapshot([6, 4, 5].map(seq => ({ runId: 'r', seq })), { r: 3 });
  expect(replay.events.map(event => event.seq)).toEqual([4, 5, 6]); expect(replay.gaps.size).toBe(0);
});
