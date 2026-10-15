import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextBatcher } from './text-batcher.js';

afterEach(() => vi.useRealTimers());

describe('stream text batching', () => {
  it('combines tiny chunks and drains the final tail without losing Unicode', async () => {
    const writes: string[] = [];
    const batcher = new TextBatcher(async (delta) => { writes.push(delta); }, () => undefined);
    const chunks = Array.from({ length: 1000 }, (_, i) => `${i}青🐦`);
    for (const chunk of chunks) await batcher.add(chunk);
    await batcher.finish();
    expect(writes.join('')).toBe(chunks.join(''));
    expect(writes.length).toBeLessThan(10);
  });

  it('publishes during an upstream pause and serializes a slow write with finish', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let max = 0;
    const batcher = new TextBatcher(async (delta) => {
      active += 1; max = Math.max(max, active); writes.push(delta);
      await gate; active -= 1;
    }, () => undefined);
    await batcher.add('第一段');
    await vi.advanceTimersByTimeAsync(100);
    expect(writes).toEqual(['第一段']);
    await batcher.add('尾段');
    const finishing = batcher.finish();
    release();
    await finishing;
    expect(writes).toEqual(['第一段', '尾段']);
    expect(max).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a database failure and aborts upstream without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error('busy'), { code: 'P1008' });
    const abort = vi.fn();
    const write = vi.fn(async () => { throw error; });
    const batcher = new TextBatcher(write, abort);
    await batcher.add('已收到的文字');
    await vi.advanceTimersByTimeAsync(100);
    expect(abort).toHaveBeenCalledOnce();
    await expect(batcher.finish()).rejects.toBe(error);
    expect(write).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
