import type { AutoScrollOptions, Modifier } from '@dnd-kit/core';

const weekdayIds = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const overlayInset = 8;

export function weekdayIdOf(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  return weekdayIds[new Date(year, month - 1, day).getDay()];
}

export function formatPlanDay(iso: string, locale: string) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(new Date(year, month - 1, day));
}

function blocksScroll(testId: string) {
  return (element: Element) => element.getAttribute('data-testid') !== testId;
}

/** Narrow month and week drags opt out of the horizontal scroller. Everything else stays Boolean(dragging), including a null drag while resizing. */
export function planAutoScroll(mode: 'day' | 'week' | 'month', narrow: boolean, dragging: unknown): boolean | AutoScrollOptions {
  if (!narrow || !dragging) return Boolean(dragging);
  if (mode === 'month') {
    return {
      threshold: { x: 0.2, y: 0.1 },
      acceleration: 1,
      interval: 16,
      canScroll: blocksScroll('month-horizontal-scroll'),
    };
  }
  if (mode === 'week') return { canScroll: blocksScroll('calendar-horizontal-scroll') };
  return Boolean(dragging);
}

/** Keeps the drag overlay 8px inside the viewport. Rects are pre-transform, matching dnd-kit modifiers. */
export const clampPlanDragOverlay: Modifier = ({ transform, overlayNodeRect, windowRect }) => {
  if (!overlayNodeRect || !windowRect) return transform;
  let x = transform.x;
  let y = transform.y;
  const minLeft = windowRect.left + overlayInset;
  const maxRight = windowRect.right - overlayInset;
  const minTop = windowRect.top + overlayInset;
  const maxBottom = windowRect.bottom - overlayInset;
  const left = overlayNodeRect.left + x;
  const right = overlayNodeRect.right + x;
  const top = overlayNodeRect.top + y;
  const bottom = overlayNodeRect.bottom + y;
  if (left < minLeft) x += minLeft - left;
  else if (right > maxRight) x -= right - maxRight;
  if (top < minTop) y += minTop - top;
  else if (bottom > maxBottom) y -= bottom - maxBottom;
  if (x === transform.x && y === transform.y) return transform;
  return { ...transform, x, y };
};
