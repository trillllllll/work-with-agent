import { useEffect, useRef } from 'react';
import { VelocityTracker } from '@/lib/navigation-drawer-motion.js';

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

export type NavigationDrag = {
  /** Checked when a touch begins; false while the drawer is already open. Kept out of `enabled` so mounting the drawer mid-swipe does not drop the gesture. */
  available: () => boolean;
  /** The swipe was recognised; mount the drawer under the finger. */
  start: () => void;
  /** Visible drawer width in px, measured from where the swipe was recognised. */
  move: (x: number) => void;
  /** Finger lifted (or the browser cancelled the touch); velocity is px/ms. */
  end: (velocity: number, cancelled: boolean) => void;
};

/** Observe touch input without taking scrolling, selection or dragging away from the page.
 *  Once a rightward swipe wins, the drawer follows the finger until it lifts. */
export function useMobileNavigationGesture(enabled: boolean, drag: NavigationDrag) {
  const handlers = useRef(drag);
  handlers.current = drag;
  useEffect(() => {
    if (!enabled) return;
    const tracker = new VelocityTracker();
    let gesture: { id: number; x: number; y: number; target: Element; origin: number | null } | null = null;
    const finish = (velocity: number, cancelled: boolean) => {
      const following = gesture?.origin != null;
      gesture = null;
      if (following) handlers.current.end(velocity, cancelled);
    };
    const reset = () => finish(0, true);
    const occupied = () => Boolean(document.querySelector('[data-dragging="true"]')) || window.getSelection()?.isCollapsed === false;
    const start = (event: TouchEvent) => {
      reset();
      if (event.touches.length !== 1 || occupied() || !handlers.current.available()) return;
      const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
      if (!target || ownsHorizontalGesture(target)) return;
      const touch = event.touches[0];
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, target, origin: null };
      tracker.reset();
    };
    const travel = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch.identifier !== gesture.id) { reset(); return; }
      if (gesture.origin === null) {
        if (occupied() || !gesture.target.isConnected) { reset(); return; }
        const dx = touch.clientX - gesture.x, dy = Math.abs(touch.clientY - gesture.y);
        // Once scrolling or a leftward gesture wins, a curved path cannot become navigation.
        if (dx < -12 || (dy >= 16 && dy >= Math.abs(dx))) { reset(); return; }
        if (dx < 10 || dx < dy * 2) return;
        // Count from the point the swipe was recognised so the drawer does not jump.
        gesture.origin = touch.clientX;
        handlers.current.start();
      }
      const x = Math.max(0, touch.clientX - gesture.origin);
      tracker.push(event.timeStamp, x);
      handlers.current.move(x);
    };
    const lift = (event: TouchEvent) => finish(tracker.velocity(event.timeStamp), false);
    const cancel = () => finish(0, true);
    // Touch events keep reporting after browser panning cancels pointer events.
    // Passive observation preserves native horizontal scrollers and pinch zoom.
    const options = { capture: true, passive: true };
    window.addEventListener('touchstart', start, options);
    window.addEventListener('touchmove', travel, options);
    window.addEventListener('touchend', lift, options);
    window.addEventListener('touchcancel', cancel, options);
    window.addEventListener('blur', cancel);
    window.addEventListener('hashchange', cancel);
    return () => {
      window.removeEventListener('touchstart', start, true);
      window.removeEventListener('touchmove', travel, true);
      window.removeEventListener('touchend', lift, true);
      window.removeEventListener('touchcancel', cancel, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('hashchange', cancel);
    };
  }, [enabled]);
}
