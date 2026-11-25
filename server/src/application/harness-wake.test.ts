import { expect, it, vi } from 'vitest';
import { harnessWakeCursor, notifyHarnessNode, waitForHarnessWork } from './harness-wake.js';

it('wakes only the waiting recipient and catches a command committed before the next lease', async () => {
  const abort = new AbortController();
  const cursor = harnessWakeCursor();
  const first = vi.fn(), second = vi.fn();
  const waiting = waitForHarnessWork('first', cursor, 3_000, abort.signal).then(first);
  const other = waitForHarnessWork('second', cursor, 3_000, abort.signal).then(second);
  try {
    notifyHarnessNode('first');
    await Promise.resolve();
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    const relaunch = vi.fn();
    void waitForHarnessWork('first', cursor, 3_000, abort.signal).then(relaunch);
    await Promise.resolve();
    expect(relaunch).toHaveBeenCalledOnce();
  } finally {
    abort.abort();
    await Promise.all([waiting, other]);
  }
});
