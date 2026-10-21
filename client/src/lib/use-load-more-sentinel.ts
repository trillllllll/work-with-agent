import { useEffect, useRef, type RefObject } from 'react';

export const LOAD_MORE_ROOT_MARGIN = '0px 0px 240px 0px';
export const LOAD_MORE_ROOT_SELECTOR = '[data-page-scroll]';

/** The page scroller, or null when the sentinel is not inside one. A null root is not observed. */
export function loadMoreObserverOptions(target: Element): IntersectionObserverInit | null {
  const root = target.closest(LOAD_MORE_ROOT_SELECTOR);
  if (!root) return null;
  return { root, rootMargin: LOAD_MORE_ROOT_MARGIN };
}

/** Loading and the last page must not attach an observer. The button remains the fallback. */
export function shouldObserveLoadMore(input: { hasRoot: boolean; loading: boolean; hasMore: boolean }) {
  return input.hasRoot && !input.loading && input.hasMore;
}

export function useLoadMoreSentinel(sentinel: RefObject<Element | null>, input: { loading: boolean; hasMore: boolean; onLoadMore: () => void }) {
  const onLoadMore = useRef(input.onLoadMore);
  onLoadMore.current = input.onLoadMore;
  const { loading, hasMore } = input;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !shouldObserveLoadMore({ hasRoot: true, loading, hasMore })) return;
    const options = loadMoreObserverOptions(node);
    if (!options) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMore.current();
    }, options);
    observer.observe(node);
    return () => observer.disconnect();
  }, [sentinel, loading, hasMore]);
}
