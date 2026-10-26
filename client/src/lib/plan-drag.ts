import { pointerWithin, type AutoScrollOptions, type CollisionDetection, type DragEndEvent, type DragOverEvent, type Modifier, type Translate } from '@dnd-kit/core';

export type PlanLaneDrop = { groupKey: string; sourceTaskId: string; targetTaskId: string; taskIds: string[]; side: 'before' | 'after' };
type PlanDragEvent = DragOverEvent | DragEndEvent;

export function horizontalPlanDrag(delta: Translate) {
  return Math.abs(delta.x) >= 12 && Math.abs(delta.x) > Math.abs(delta.y) * 1.25;
}

/** Prefer same-group cards only for a horizontal drag; otherwise preserve time-slot drops. */
export function createPlanCollisionDetection(isHorizontal: () => boolean): CollisionDetection {
  return (args) => {
    const source = args.active.data.current?.laneGroup as { groupKey?: string; dateKey?: string } | undefined;
    const containers = new Map(args.droppableContainers.map((container) => [String(container.id), container]));
    const horizontal = isHorizontal();
    return pointerWithin(args).map((collision) => {
      const container = containers.get(String(collision.id));
      const target = container?.data.current?.laneDrop as { groupKey?: string; dateKey?: string } | undefined;
      const eligible = Boolean(horizontal && target && source && target.groupKey === source.groupKey && target.dateKey === source.dateKey);
      const isLane = Boolean(target);
      const rank = eligible ? 0 : horizontal ? isLane ? 2 : 1 : isLane ? 1 : 0;
      const rect = container?.rect.current;
      const laneSide = args.pointerCoordinates && rect ? args.pointerCoordinates.x < rect.left + rect.width / 2 ? 'before' : 'after' : undefined;
      return { collision, rank, laneSide };
    }).sort((a, b) => a.rank - b.rank).map(({ collision, laneSide }) => laneSide ? { ...collision, data: { ...collision.data, laneSide } } : collision);
  };
}

export function planLaneDrop(event: PlanDragEvent): PlanLaneDrop | null {
  if (!event.over || !horizontalPlanDrag(event.delta)) return null;
  const source = event.active.data.current?.laneGroup as { groupKey?: string; dateKey?: string } | undefined;
  const sourceTaskId = event.active.data.current?.task?.id as string | undefined;
  const target = event.over.data.current?.laneDrop as { groupKey?: string; dateKey?: string; taskId?: string; groupTaskIds?: string[] } | undefined;
  if (!source || !sourceTaskId || !target?.groupKey || !target.taskId || !target.groupTaskIds?.length) return null;
  if (source.groupKey !== target.groupKey || source.dateKey !== target.dateKey || sourceTaskId === target.taskId) return null;
  const collision = event.collisions?.find((item) => String(item.id) === String(event.over!.id));
  const side = collision?.data?.laneSide === 'before' ? 'before' : collision?.data?.laneSide === 'after' ? 'after' : event.delta.x >= 0 ? 'after' : 'before';
  return { groupKey: target.groupKey, sourceTaskId, targetTaskId: target.taskId, taskIds: [...target.groupTaskIds], side };
}

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
