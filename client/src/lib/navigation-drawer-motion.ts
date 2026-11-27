/** Follow-the-finger motion for the mobile navigation drawer.
 *  The page underneath never moves: the drawer slides in and a progressive blur
 *  (deepest against the drawer's edge) fades in behind it. Positions are written
 *  straight to the DOM so a drag never re-renders React. */

export const DRAWER_FLING_VELOCITY = 0.35; // px/ms
export const DRAWER_MIN_FLING_OPEN = 48; // px a flick must travel before it can open the drawer
const STALE_RELEASE_MS = 80;
const SAMPLE_WINDOW_MS = 90;
const OVERDRAG = 16;

/** Where a released drawer settles: a quick flick wins, otherwise the nearer side. */
export function drawerSettlesOpen(x: number, width: number, velocity: number, cancelled = false) {
  if (!cancelled && velocity > DRAWER_FLING_VELOCITY && x >= DRAWER_MIN_FLING_OPEN) return true;
  if (!cancelled && velocity < -DRAWER_FLING_VELOCITY) return false;
  return x > width / 2;
}

/** Remaining travel finishes faster after a fast flick. */
export function drawerSettleDuration(distance: number, velocity: number, reducedMotion: boolean) {
  if (reducedMotion) return 0;
  return Math.round(Math.min(340, Math.max(170, distance / Math.max(Math.abs(velocity), 0.9) * 1.6)));
}

/** Release velocity from recent samples; a finger that stopped before lifting did not flick. */
export class VelocityTracker {
  private samples: [number, number][] = [];
  reset() { this.samples = []; }
  push(time: number, x: number) {
    this.samples.push([time, x]);
    while (this.samples.length > 2 && time - this.samples[0][0] > SAMPLE_WINDOW_MS) this.samples.shift();
  }
  velocity(releasedAt: number) {
    const first = this.samples[0], last = this.samples[this.samples.length - 1];
    if (!first || !last || releasedAt - last[0] > STALE_RELEASE_MS || last[0] <= first[0]) return 0;
    return (last[1] - first[1]) / (last[0] - first[0]);
  }
}

const ownedByContent = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [data-mobile-nav-ignore]';

export class NavigationDrawerMotion {
  /** Called once a close has finished animating; the owner unmounts the drawer. */
  onClosed: () => void = () => {};
  private sheet: HTMLElement | null = null;
  private veil: HTMLElement | null = null;
  private x = 0;
  private width = 0;
  private isOpen = false;
  private pending: 'animate' | 'drag' | null = null;
  /** A finger lifted before the drawer finished mounting; applied once it attaches. */
  private pendingRelease: { velocity: number; cancelled: boolean } | null = null;
  private timer = 0;
  private suppressClick = false;
  private detachListeners: (() => void) | null = null;
  private readonly reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  /** A button or menu asked for the drawer: it slides in once mounted. */
  prepareOpen() { this.pending = 'animate'; this.x = 0; }
  /** A page swipe crossed the threshold: the drawer mounts under the finger. */
  beginDrag() { this.pending = 'drag'; this.pendingRelease = null; this.x = 0; }

  setSheet = (node: HTMLElement | null) => { this.sheet = node; this.sync(); };
  setVeil = (node: HTMLElement | null) => { this.veil = node; this.sync(); };

  drag(x: number) {
    this.x = x;
    if (!this.sheet) return;
    this.sheet.dataset.dragging = '';
    this.transition(0);
    this.paint(x);
  }

  release(velocity: number, cancelled: boolean) {
    if (!this.sheet || !this.veil) { if (this.pending === 'drag') this.pendingRelease = { velocity, cancelled }; return; }
    delete this.sheet.dataset.dragging;
    const x = Math.min(this.x, this.width);
    this.settle(drawerSettlesOpen(x, this.width, velocity, cancelled), x, velocity);
  }

  close() {
    if (!this.sheet || this.width === 0) { this.finishClosed(); return; }
    this.settle(false, Math.min(this.x, this.width), 0);
  }

  private sync() {
    window.clearTimeout(this.timer);
    this.detachListeners?.();
    this.detachListeners = null;
    if (!this.sheet || !this.veil) { this.isOpen = false; return; }
    this.width = this.sheet.offsetWidth;
    this.detachListeners = this.listen(this.sheet, this.veil.parentElement ?? this.veil);
    if (this.pending === 'drag') {
      this.transition(0);
      this.paint(this.x);
      this.isOpen = false;
      this.pending = null;
      const release = this.pendingRelease;
      this.pendingRelease = null;
      if (release) this.release(release.velocity, release.cancelled);
      return;
    }
    else {
      // Opened from a button: start off-screen, then slide in.
      this.transition(0);
      this.paint(0);
      this.sheet.getBoundingClientRect();
      this.settle(true, 0, 0);
    }
    this.pending = null;
  }

  private paint(x: number) {
    const { sheet, veil, width } = this;
    if (!sheet || !veil) return;
    const progress = width ? Math.min(1, x / width) : 0;
    const shown = Math.min(width + OVERDRAG, Math.max(0, x));
    sheet.style.setProperty('--nav-drawer-x', `${shown - width}px`);
    // The blur starts at the drawer's edge (1px under it so no seam shows) and fills the rest.
    veil.style.left = `${Math.max(0, Math.min(shown, width) - 1)}px`;
    for (const layer of veil.children) (layer as HTMLElement).style.opacity = String(progress);
  }

  private transition(ms: number) {
    const { sheet, veil } = this;
    if (!sheet || !veil) return;
    const ease = 'var(--nav-drawer-ease)';
    sheet.style.transition = ms ? `transform ${ms}ms ${ease}` : 'none';
    veil.style.transition = ms ? `left ${ms}ms ${ease}` : 'none';
    for (const layer of veil.children) (layer as HTMLElement).style.transition = ms ? `opacity ${ms}ms ${ease}` : 'none';
  }

  private settle(open: boolean, from: number, velocity: number) {
    window.clearTimeout(this.timer);
    const target = open ? this.width : 0;
    const ms = drawerSettleDuration(Math.abs(target - from), velocity, this.reducedMotion?.matches ?? false);
    this.x = target;
    this.isOpen = open;
    if (!open && ms === 0) { this.paint(0); this.finishClosed(); return; }
    this.transition(ms);
    requestAnimationFrame(() => this.paint(target));
    if (!open) this.timer = window.setTimeout(() => this.finishClosed(), ms + 30);
  }

  private finishClosed() {
    window.clearTimeout(this.timer);
    this.isOpen = false;
    this.pending = null;
    this.pendingRelease = null;
    this.onClosed();
  }

  /** While open, dragging the drawer or the blur leftward follows the finger closed; a tap on the blur closes. */
  private listen(sheet: HTMLElement, backdrop: HTMLElement) {
    const tracker = new VelocityTracker();
    let gesture: { id: number; x: number; y: number; dragging: boolean; base: number } | null = null;
    const start = (event: TouchEvent) => {
      gesture = null;
      if (!this.isOpen || event.touches.length !== 1) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(ownedByContent)) return;
      const touch = event.touches[0];
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, dragging: false, base: this.width };
      tracker.reset();
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = [...event.touches].find(item => item.identifier === gesture!.id);
      if (!touch || event.touches.length !== 1) { end(event, true); return; }
      const dx = touch.clientX - gesture.x, dy = Math.abs(touch.clientY - gesture.y);
      if (!gesture.dragging) {
        // Vertical movement belongs to the sidebar's own scrolling.
        if (dy >= 10 && dy >= Math.abs(dx)) { gesture = null; return; }
        if (dx > -10 || -dx < dy * 2) return;
        gesture.dragging = true;
        gesture.x = touch.clientX;
      }
      const x = Math.max(0, gesture.base + touch.clientX - gesture.x);
      tracker.push(event.timeStamp, x);
      this.drag(x);
    };
    const end = (event: TouchEvent, cancelled = event.type === 'touchcancel') => {
      if (!gesture) return;
      const dragged = gesture.dragging;
      gesture = null;
      if (!dragged) return;
      this.suppressClick = true;
      window.setTimeout(() => { this.suppressClick = false; }, 350);
      this.release(tracker.velocity(event.timeStamp), cancelled);
    };
    const tap = (event: MouseEvent) => {
      if (event.target !== backdrop && !(event.target instanceof Node && this.veil?.contains(event.target))) return;
      if (this.suppressClick) return;
      this.close();
    };
    const blockClickAfterDrag = (event: MouseEvent) => { if (this.suppressClick) { event.preventDefault(); event.stopPropagation(); } };
    const options = { passive: true } as const;
    for (const node of [sheet, backdrop]) {
      node.addEventListener('touchstart', start, options);
      node.addEventListener('touchmove', move, options);
      node.addEventListener('touchend', end, options);
      node.addEventListener('touchcancel', end, options);
    }
    backdrop.addEventListener('click', tap);
    sheet.addEventListener('click', blockClickAfterDrag, true);
    return () => {
      for (const node of [sheet, backdrop]) {
        node.removeEventListener('touchstart', start);
        node.removeEventListener('touchmove', move);
        node.removeEventListener('touchend', end);
        node.removeEventListener('touchcancel', end);
      }
      backdrop.removeEventListener('click', tap);
      sheet.removeEventListener('click', blockClickAfterDrag, true);
    };
  }
}
