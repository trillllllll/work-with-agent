import { useEffect, useRef } from 'react';

const ownedGesture = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], canvas, video, audio, iframe, [draggable="true"], [data-mobile-nav-ignore], [data-slot="popover-content"], [data-slot="dialog-overlay"], [role="menu"], [role="listbox"]';

function ownsHorizontalGesture(target: Element) {
  if (target.closest(ownedGesture)) return true;
  const dialog = target.closest('[role="dialog"], [role="alertdialog"]');
  if (dialog && dialog.getAttribute('aria-modal') !== 'false' && !dialog.hasAttribute('data-mobile-nav-page')) return true;
  // Reserve the whole scrollable surface, including its left/right boundary.
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1 && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

/** Observe touch input without taking scrolling, selection or dragging away from the page. */
export function useMobileNavigationGesture(enabled: boolean, onOpen: () => void) {
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    if (!enabled) return;
    let gesture: { id: number; x: number; y: number; target: Element } | null = null;
    const reset = () => { gesture = null; };
    const occupied = () => Boolean(document.querySelector('[data-dragging="true"]')) || window.getSelection()?.isCollapsed === false;
    const start = (event: TouchEvent) => {
      reset();
      if (event.touches.length !== 1 || occupied()) return;
      const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
      if (!target || ownsHorizontalGesture(target)) return;
      const touch = event.touches[0];
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, target };
    };
    const travel = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1 || occupied() || !gesture.target.isConnected) { reset(); return; }
      const touch = event.touches[0];
      if (touch.identifier !== gesture.id) { reset(); return; }
      const dx = touch.clientX - gesture.x, dy = Math.abs(touch.clientY - gesture.y);
      // Once scrolling or a leftward gesture wins, a curved path cannot become navigation.
      if (dx < -12 || (dy >= 16 && dy >= Math.abs(dx))) { reset(); return; }
      if (dx >= 56 && dx >= dy * 2) { reset(); open.current(); }
    };
    // Touch events keep reporting after browser panning cancels pointer events.
    // Passive observation preserves native horizontal scrollers and pinch zoom.
    const options = { capture: true, passive: true };
    window.addEventListener('touchstart', start, options);
    window.addEventListener('touchmove', travel, options);
    window.addEventListener('touchend', reset, options);
    window.addEventListener('touchcancel', reset, options);
    window.addEventListener('blur', reset);
    window.addEventListener('hashchange', reset);
    return () => {
      window.removeEventListener('touchstart', start, true);
      window.removeEventListener('touchmove', travel, true);
      window.removeEventListener('touchend', reset, true);
      window.removeEventListener('touchcancel', reset, true);
      window.removeEventListener('blur', reset);
      window.removeEventListener('hashchange', reset);
    };
  }, [enabled]);
}
