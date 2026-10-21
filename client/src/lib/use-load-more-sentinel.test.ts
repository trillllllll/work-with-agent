// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LOAD_MORE_ROOT_MARGIN, LOAD_MORE_ROOT_SELECTOR, loadMoreObserverOptions, shouldObserveLoadMore } from './use-load-more-sentinel.js';

function fakeElement(ancestor: object | null, seen: string[]) {
  return {
    closest(selector: string) {
      seen.push(selector);
      return ancestor;
    },
  } as unknown as Element;
}

describe('load more sentinel', () => {
  it('uses the page scroller ancestor as root', () => {
    const scroller = { id: 'page' };
    const seen: string[] = [];
    const options = loadMoreObserverOptions(fakeElement(scroller, seen));
    expect(options?.root).toBe(scroller);
    expect(seen).toEqual([LOAD_MORE_ROOT_SELECTOR]);
    expect(options?.rootMargin).toBe('0px 0px 240px 0px');
    expect(options?.rootMargin).toBe(LOAD_MORE_ROOT_MARGIN);
  });

  it('does not observe when the scroller is absent, or while loading or finished', () => {
    const seen: string[] = [];
    expect(loadMoreObserverOptions(fakeElement(null, seen))).toBeNull();
    expect(seen).toEqual(['[data-page-scroll]']);
    expect(shouldObserveLoadMore({ hasRoot: true, loading: false, hasMore: true })).toBe(true);
    expect(shouldObserveLoadMore({ hasRoot: false, loading: false, hasMore: true })).toBe(false);
    expect(shouldObserveLoadMore({ hasRoot: true, loading: true, hasMore: true })).toBe(false);
    expect(shouldObserveLoadMore({ hasRoot: true, loading: false, hasMore: false })).toBe(false);
  });
});
