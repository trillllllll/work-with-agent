import { describe, expect, it } from 'vitest';
import {
  COARSE_LONG_PRESS_MS,
  hasTooltipContent,
  isCoarsePointer,
  markCoarseLongPress,
  nextCoarseTooltipOpen,
  reduceCoarsePress,
  tooltipFallbackText,
  type CoarsePressSession,
} from './tooltip.js';

describe('coarse tooltip open state', () => {
  it('toggles on tap, opens on long-press, and closes on outside or escape', () => {
    expect(COARSE_LONG_PRESS_MS).toBe(400);
    expect(nextCoarseTooltipOpen(false, 'tap')).toBe(true);
    expect(nextCoarseTooltipOpen(true, 'tap')).toBe(false);
    expect(nextCoarseTooltipOpen(false, 'long-press')).toBe(true);
    expect(nextCoarseTooltipOpen(true, 'long-press')).toBe(true);
    expect(nextCoarseTooltipOpen(true, 'outside')).toBe(false);
    expect(nextCoarseTooltipOpen(true, 'escape')).toBe(false);
    expect(nextCoarseTooltipOpen(false, 'outside')).toBe(false);
  });

  it('treats a short press as a tap and ignores movement or a finished long-press', () => {
    const down = reduceCoarsePress(null, { x: 0, y: 0, phase: 'down' });
    expect(down.armTimer).toBe(true);
    expect(down.session).toEqual({ x: 0, y: 0, moved: false, longPressed: false });

    const held = markCoarseLongPress(down.session!);
    expect(held.gesture).toBe('long-press');
    const afterHold = reduceCoarsePress(held.session, { x: 1, y: 1, phase: 'up' });
    expect(afterHold.gesture).toBeNull();
    expect(afterHold.disarmTimer).toBe(true);

    const moved = reduceCoarsePress(down.session, { x: 20, y: 0, phase: 'move' });
    expect(moved.disarmTimer).toBe(true);
    expect(moved.session?.moved).toBe(true);
    expect(reduceCoarsePress(moved.session, { x: 20, y: 0, phase: 'up' }).gesture).toBeNull();

    const still = reduceCoarsePress(down.session, { x: 4, y: 4, phase: 'move' });
    expect(still.disarmTimer).toBe(false);
    expect(reduceCoarsePress(still.session, { x: 4, y: 4, phase: 'up' }).gesture).toBe('tap');

    const cancelled = reduceCoarsePress(down.session, { x: 0, y: 0, phase: 'cancel' });
    expect(cancelled.session).toBeNull();
    expect(cancelled.gesture).toBeNull();
    expect(cancelled.disarmTimer).toBe(true);
  });

  it('ignores samples that arrive without a press', () => {
    const idle = { x: 0, y: 0, moved: false, longPressed: false } satisfies CoarsePressSession;
    expect(reduceCoarsePress(null, { x: 1, y: 1, phase: 'up' })).toEqual({ session: null, gesture: null, armTimer: false, disarmTimer: false });
    expect(reduceCoarsePress(idle, { x: 1, y: 1, phase: 'down' }).armTimer).toBe(true);
  });
});

describe('tooltip content guards', () => {
  it('skips falsy content and keeps a string fallback for the closed state', () => {
    expect(hasTooltipContent(null)).toBe(false);
    expect(hasTooltipContent(undefined)).toBe(false);
    expect(hasTooltipContent(false)).toBe(false);
    expect(hasTooltipContent('')).toBe(false);
    expect(hasTooltipContent(0)).toBe(false);
    expect(hasTooltipContent('原因')).toBe(true);
    expect(tooltipFallbackText('  已撤销  ')).toBe('已撤销');
    expect(tooltipFallbackText('   ')).toBeNull();
    expect(tooltipFallbackText(3)).toBe('3');
    expect(tooltipFallbackText(null)).toBeNull();
  });

  it('reads the coarse pointer media query from the matcher it is given', () => {
    expect(isCoarsePointer(() => true)).toBe(true);
    expect(isCoarsePointer(() => false)).toBe(false);
    expect(isCoarsePointer()).toBe(false);
  });
});
