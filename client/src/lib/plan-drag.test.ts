import { describe, expect, it } from 'vitest';
import type { Modifier } from '@dnd-kit/core';
import { clampPlanDragOverlay, formatPlanDay, planAutoScroll, weekdayIdOf } from './plan-drag.js';

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
