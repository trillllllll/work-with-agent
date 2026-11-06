import { it, expect, vi } from 'vitest';
import { PreviewAcknowledgement } from './preview-acknowledgement.js';
it('uses one bounded retry budget across a changing graphic source', async () => {
  vi.useFakeTimers();
  try {
    const write = vi.fn(async () => { throw new Error('offline'); });
    const acknowledgement = new PreviewAcknowledgement(write);
    for (let i = 0; i < 100; i++) { acknowledgement.update(`source ${i}`); await vi.advanceTimersByTimeAsync(160); }
    expect(write).toHaveBeenCalledTimes(3);
    acknowledgement.dispose(); await vi.advanceTimersByTimeAsync(10_000); expect(write).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); }
});
it('acknowledges a mounted block once after success', async () => {
  const write = vi.fn(async () => {}); const acknowledgement = new PreviewAcknowledgement(write);
  acknowledgement.update('first'); await Promise.resolve(); acknowledgement.update('second');
  expect(write).toHaveBeenCalledOnce(); acknowledgement.dispose();
});
