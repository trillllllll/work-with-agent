/** Vertical preload only, so side gutters do not mount extra frames. */
export const HTML_BLOCK_PRELOAD_MARGIN = '300px 0px';

/**
 * Root is the chat scroller when the block lives inside one.
 * A null root falls back to the viewport, for html blocks used outside the chat.
 */
export function lazyObserverOptions(target: Element): IntersectionObserverInit {
  return {
    root: (target.closest('[data-chat-scroll]') as HTMLElement | null) ?? null,
    rootMargin: HTML_BLOCK_PRELOAD_MARGIN,
  };
}
