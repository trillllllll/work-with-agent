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

/** WebKit may miss an initial intersection after a chat layout/scroll change. */
export function isNearHtmlViewport(target: Element, root: Element | null, viewport: { width: number; height: number }) {
  const box = target.getBoundingClientRect();
  const area = root?.getBoundingClientRect() ?? { top: 0, left: 0, right: viewport.width, bottom: viewport.height, width: viewport.width, height: viewport.height };
  return box.width > 0 && box.height > 0 && area.width > 0 && area.height > 0
    && area.right > 0 && area.left < viewport.width && area.bottom > 0 && area.top < viewport.height
    && box.right > area.left && box.left < area.right && box.bottom >= area.top - 300 && box.top <= area.bottom + 300;
}
