import { isNearHtmlViewport } from './components/chat/html-block-visibility.js';
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

it('keeps the WebKit layout fallback inside the same vertical preload range', () => {
  const element = (left: number, top: number, width: number, height: number) => ({ getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }) }) as Element;
  const root = element(100, 100, 400, 500), viewport = { width: 1000, height: 800 };
  expect(isNearHtmlViewport(element(100, 899, 400, 200), root, viewport)).toBe(true);
  expect(isNearHtmlViewport(element(100, 901, 400, 200), root, viewport)).toBe(false);
  expect(isNearHtmlViewport(element(100, 100, 0, 0), root, viewport)).toBe(false);
  expect(isNearHtmlViewport(element(600, 100, 100, 100), root, viewport)).toBe(false);
  expect(isNearHtmlViewport(element(100, 100, 100, 100), element(1000, 100, 400, 500), viewport)).toBe(false);
});
