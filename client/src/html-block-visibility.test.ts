// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HTML_BLOCK_PRELOAD_MARGIN, lazyObserverOptions } from './components/chat/html-block-visibility.js';

function fakeElement(ancestor: object | null, seen: string[]) {
  return {
    closest(selector: string) {
      seen.push(selector);
      return ancestor;
    },
  } as unknown as Element;
}

describe('lazyObserverOptions', () => {
  it('uses the chat scroller ancestor as root', () => {
    const scroller = { id: 'scroller' };
    const seen: string[] = [];
    const options = lazyObserverOptions(fakeElement(scroller, seen));
    expect(options.root).toBe(scroller);
    expect(seen).toEqual(['[data-chat-scroll]']);
    expect(options.rootMargin).toBe('300px 0px');
    expect(options.rootMargin).toBe(HTML_BLOCK_PRELOAD_MARGIN);
  });

  it('falls back to a null root when the scroller is absent', () => {
    const seen: string[] = [];
    const options = lazyObserverOptions(fakeElement(null, seen));
    expect(options.root).toBeNull();
    expect(seen).toEqual(['[data-chat-scroll]']);
    expect(options.rootMargin).toBe(HTML_BLOCK_PRELOAD_MARGIN);
  });
});
