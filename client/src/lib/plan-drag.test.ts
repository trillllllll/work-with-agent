import { describe, expect, it } from 'vitest';
import type { CollisionDetection, DragOverEvent, Modifier } from '@dnd-kit/core';
import { clampPlanDragOverlay, createPlanCollisionDetection, formatPlanDay, horizontalPlanDrag, planAutoScroll, planLaneDrop, weekdayIdOf } from './plan-drag.js';

function scrollElement(testId: string | null): Element {
  return { getAttribute: (name: string) => (name === 'data-testid' ? testId : null) } as unknown as Element;
}

function modifierArgs(patch: Partial<Parameters<Modifier>[0]>): Parameters<Modifier>[0] {
  return {
    activatorEvent: null,
    active: null,
    activeNodeRect: null,
    draggingNodeRect: null,
    containerNodeRect: null,
    over: null,
    overlayNodeRect: null,
    scrollableAncestors: [],
    scrollableAncestorRects: [],
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
    windowRect: null,
    ...patch,
  };
}

describe('plan drag labels', () => {
  it('maps local weekdays onto the plan weekday ids', () => {
    expect(weekdayIdOf('2026-10-12')).toBe('mon');
    expect(weekdayIdOf('2026-10-14')).toBe('wed');
    expect(weekdayIdOf('2026-10-16')).toBe('fri');
    expect(weekdayIdOf('2026-10-18')).toBe('sun');
  });

  it('formats the move-preview day without a year', () => {
    expect(formatPlanDay('2026-10-16', 'zh-CN')).toBe('10月16日');
    expect(formatPlanDay('2026-10-16', 'en-US')).toBe('October 16');
  });
});

describe('plan autoscroll', () => {
  const dragging = { id: 'task' };

  it('slows vertical scroll and skips the month scroller on a narrow month drag', () => {
    const options = planAutoScroll('month', true, dragging);
    expect(options).toMatchObject({ threshold: { x: 0.2, y: 0.1 }, acceleration: 1, interval: 16 });
    if (typeof options === 'boolean' || !options.canScroll) throw new Error('expected month canScroll');
    expect(options.canScroll(scrollElement('month-horizontal-scroll'))).toBe(false);
    expect(options.canScroll(scrollElement('calendar-horizontal-scroll'))).toBe(true);
    expect(options.canScroll(scrollElement('timeline-scroll'))).toBe(true);
    expect(options.canScroll(scrollElement(null))).toBe(true);
  });

  it('keeps default speed and skips only the week scroller on a narrow week drag', () => {
    const options = planAutoScroll('week', true, dragging);
    expect(options).toEqual({ canScroll: expect.any(Function) });
    if (typeof options === 'boolean' || !options.canScroll) throw new Error('expected week canScroll');
    expect(options.threshold).toBeUndefined();
    expect(options.acceleration).toBeUndefined();
    expect(options.interval).toBeUndefined();
    expect(options.canScroll(scrollElement('calendar-horizontal-scroll'))).toBe(false);
    expect(options.canScroll(scrollElement('month-horizontal-scroll'))).toBe(true);
    expect(options.canScroll(scrollElement('timeline-scroll'))).toBe(true);
    expect(options.canScroll(scrollElement(null))).toBe(true);
  });

  it('stays a boolean everywhere else, including a resize with no dragging task', () => {
    expect(planAutoScroll('month', false, dragging)).toBe(true);
    expect(planAutoScroll('week', false, dragging)).toBe(true);
    expect(planAutoScroll('day', true, dragging)).toBe(true);
    expect(planAutoScroll('day', false, dragging)).toBe(true);
    expect(planAutoScroll('month', true, null)).toBe(false);
    expect(planAutoScroll('week', true, null)).toBe(false);
    expect(planAutoScroll('day', true, null)).toBe(false);
    expect(planAutoScroll('month', false, null)).toBe(false);
  });
});

describe('plan overlay clamp', () => {
  const windowRect = { top: 0, left: 0, right: 412, bottom: 839, width: 412, height: 839 };

  it('pulls the overlay back inside an 8px inset when the right edge passes 412', () => {
    const overlayNodeRect = { top: 40, left: 250, right: 450, bottom: 96, width: 200, height: 56 };
    const next = clampPlanDragOverlay(modifierArgs({ transform: { x: 0, y: 0, scaleX: 1, scaleY: 1 }, overlayNodeRect, windowRect }));
    expect(overlayNodeRect.right + next.x).toBe(412 - 8);
    expect(next.y).toBe(0);
    expect(next.scaleX).toBe(1);
    expect(next.scaleY).toBe(1);
  });

  it('leaves the transform unchanged when the overlay sits inside the viewport', () => {
    const transform = { x: 6, y: -2, scaleX: 1, scaleY: 1 };
    const overlayNodeRect = { top: 32, left: 24, right: 180, bottom: 88, width: 156, height: 56 };
    const next = clampPlanDragOverlay(modifierArgs({ transform, overlayNodeRect, windowRect }));
    expect(next).toBe(transform);
  });
});


describe('plan lane drag', () => {
  const rect = { left: 0, top: 0, right: 100, bottom: 56, width: 100, height: 56 };
  const container = (id: string, laneDrop?: unknown) => ({
    id, key: id, disabled: false,
    data: { current: laneDrop ? { laneDrop } : {} },
    node: { current: null }, rect: { current: rect },
  });
  const lane = { groupKey: 'group', dateKey: '2026-10-16', taskId: 'b', groupTaskIds: ['a', 'b'] };
  const collisionArgs = (target = lane): Parameters<CollisionDetection>[0] => {
    const containers = [container('slot:2026-10-16:10:00'), container('lane:2026-10-16:b', target)] as unknown as Parameters<CollisionDetection>[0]['droppableContainers'];
    return {
      active: { data: { current: { task: { id: 'a' }, laneGroup: { groupKey: 'group', dateKey: '2026-10-16' } } } },
      collisionRect: rect,
      droppableRects: new Map(containers.map((item) => [item.id, rect])),
      droppableContainers: containers,
      pointerCoordinates: { x: 25, y: 20 },
    } as unknown as Parameters<CollisionDetection>[0];
  };
  const dragEvent = (delta: { x: number; y: number }, target = lane): DragOverEvent => ({
    delta,
    active: { data: { current: { task: { id: 'a' }, laneGroup: { groupKey: 'group', dateKey: '2026-10-16' } } } },
    over: { id: 'lane:2026-10-16:b', data: { current: { laneDrop: target } } },
    collisions: [{ id: 'lane:2026-10-16:b', data: { laneSide: 'before' } }],
  }) as unknown as DragOverEvent;

  it('requires a clear horizontal intent', () => {
    expect(horizontalPlanDrag({ x: 20, y: 2 })).toBe(true);
    expect(horizontalPlanDrag({ x: 8, y: 0 })).toBe(false);
    expect(horizontalPlanDrag({ x: 20, y: 20 })).toBe(false);
  });

  it('prefers a same-group lane only during horizontal dragging', () => {
    expect(createPlanCollisionDetection(() => false)(collisionArgs()).map((item) => item.id)).toEqual(['slot:2026-10-16:10:00', 'lane:2026-10-16:b']);
    const collisions = createPlanCollisionDetection(() => true)(collisionArgs());
    expect(collisions.map((item) => item.id)).toEqual(['lane:2026-10-16:b', 'slot:2026-10-16:10:00']);
    expect(collisions[0].data?.laneSide).toBe('before');
    expect(createPlanCollisionDetection(() => true)(collisionArgs({ ...lane, dateKey: '2026-10-17' }))[0].id).toBe('slot:2026-10-16:10:00');
  });

  it('creates a reorder-only drop for a valid same-group target', () => {
    expect(planLaneDrop(dragEvent({ x: 30, y: 2 }))).toEqual({ groupKey: 'group', sourceTaskId: 'a', targetTaskId: 'b', taskIds: ['a', 'b'], side: 'before' });
    expect(planLaneDrop(dragEvent({ x: 2, y: 30 }))).toBeNull();
    expect(planLaneDrop(dragEvent({ x: 30, y: 2 }, { ...lane, groupKey: 'other' }))).toBeNull();
    expect(planLaneDrop(dragEvent({ x: 30, y: 2 }, { ...lane, dateKey: '2026-10-17' }))).toBeNull();
  });
});
