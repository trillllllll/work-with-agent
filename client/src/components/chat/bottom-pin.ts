type Metrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

function distanceFromBottom(metrics: Metrics) {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

/**
 * Follows the bottom of a chat scroller only while the user is already there.
 * An upward scroll of more than 1px that leaves the bottom unpins.
 * Content shrinking clamps scrollTop but stays within 1px of the bottom, so it does not unpin.
 * A hidden scroller (clientHeight 0) is ignored so a parked host cannot clear the pin.
 */
export function createBottomPin(threshold = 80) {
  let pinned = true;
  let lastTop = 0;
  return {
    onScroll(metrics: Metrics) {
      if (metrics.clientHeight === 0) return;
      const distance = distanceFromBottom(metrics);
      if (metrics.scrollTop < lastTop - 1 && distance > 1) pinned = false;
      else if (distance < threshold) pinned = true;
      lastTop = metrics.scrollTop;
    },
    onResize(metrics: Metrics): number | null {
      if (metrics.clientHeight === 0 || !pinned) return null;
      const top = metrics.scrollHeight - metrics.clientHeight;
      lastTop = top;
      return top;
    },
    pin() { pinned = true; },
    isPinned() { return pinned; },
  };
}
