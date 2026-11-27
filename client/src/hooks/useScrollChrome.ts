import { useEffect, type RefObject } from 'react';

const COLLAPSE_AT = 64;
const EXPAND_BELOW = 8;

/** Marks the page scroller for the floating glass page header:
 *  `data-scrolled` once content runs under it, `data-header-collapsed` once the title should shrink.
 *  The gap between the two thresholds is larger than the height the header loses when it
 *  collapses, so collapsing can never scroll the page back over the threshold and flicker. */
export function useScrollChrome(scroller: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    let collapsed = false;
    const sync = () => {
      const top = node.scrollTop;
      if (!collapsed && top > COLLAPSE_AT) collapsed = true;
      else if (collapsed && top < EXPAND_BELOW) collapsed = false;
      node.toggleAttribute('data-scrolled', top > 2);
      node.toggleAttribute('data-header-collapsed', collapsed);
    };
    sync();
    node.addEventListener('scroll', sync, { passive: true });
    return () => node.removeEventListener('scroll', sync);
  }, [scroller]);
}
