import { beforeEach, describe, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api.js', () => ({ api: request }));
import { readExtractedText } from './extracted-text.js';

describe('version-bound extracted text', () => {
  beforeEach(() => request.mockReset());

  it('rejects an older response that finishes after the reader has switched versions', async () => {
    let finishOld!: (page: { items: Array<{ text: string }>; nextCursor: null }) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce({ items: [{ text: 'new version' }], nextCursor: null });
    const oldController = new AbortController();
    const oldResult = readExtractedText('document', 1, oldController.signal, 'excerpt');
    const rejected = expect(oldResult).rejects.toMatchObject({ name: 'AbortError' });
    oldController.abort();
    const current = await readExtractedText('document', 2, new AbortController().signal, 'excerpt');
    finishOld({ items: [{ text: 'old version' }], nextCursor: null });
    await rejected;
    expect(current).toBe('new version');
    expect(request.mock.calls[0][0]).toContain('revision=1');
    expect(request.mock.calls[1][0]).toContain('revision=2');
  });

  it('shows excerpt notice only when the exact requested version has another page', async () => {
    request.mockResolvedValue({ items: [{ text: 'first' }, { text: 'second' }], nextCursor: 100 });
    const controller = new AbortController();
    expect(await readExtractedText('document', 3, controller.signal, 'more remains')).toBe('first\n\nsecond\n\nmore remains');
    expect(request.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
