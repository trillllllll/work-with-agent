// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createBottomPin } from './components/chat/bottom-pin.js';

const at = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({ scrollTop, scrollHeight, clientHeight });

describe('createBottomPin', () => {
  it('starts pinned', () => {
    expect(createBottomPin().isPinned()).toBe(true);
  });

  it('unpins when the user scrolls up', () => {
    const pin = createBottomPin();
    pin.onScroll(at(1000, 1400, 400));
    expect(pin.isPinned()).toBe(true);
    pin.onScroll(at(600, 1400, 400));
    expect(pin.isPinned()).toBe(false);
  });

  it('unpins on a small upward scroll that is still inside the threshold', () => {
    const pin = createBottomPin();
    pin.onScroll(at(1000, 1400, 400));
    pin.onScroll(at(980, 1400, 400));
    expect(pin.isPinned()).toBe(false);
  });

  it('re-pins only after scrolling back down within the threshold', () => {
    const pin = createBottomPin();
    pin.onScroll(at(1400, 1800, 400));
    pin.onScroll(at(400, 1800, 400));
    expect(pin.isPinned()).toBe(false);
    pin.onScroll(at(900, 1800, 400));
    expect(pin.isPinned()).toBe(false);
    pin.onScroll(at(1340, 1800, 400));
    expect(pin.isPinned()).toBe(true);
  });

  it('stays pinned when content shrink clamps scrollTop but the view is still within 1px of the bottom', () => {
    const pin = createBottomPin();
    pin.onScroll(at(1000, 1400, 400));
    pin.onScroll(at(640, 1041, 400));
    expect(pin.isPinned()).toBe(true);
    pin.onScroll(at(400, 800, 400));
    expect(pin.isPinned()).toBe(true);
  });

  it('ignores metrics while the scroller has no height', () => {
    const pin = createBottomPin();
    pin.onScroll(at(1400, 1800, 400));
    pin.onScroll(at(0, 0, 0));
    expect(pin.isPinned()).toBe(true);
    expect(pin.onResize(at(0, 0, 0))).toBeNull();
    pin.onScroll(at(1000, 1800, 400));
    expect(pin.isPinned()).toBe(false);
    expect(pin.onResize(at(0, 0, 0))).toBeNull();
    expect(pin.isPinned()).toBe(false);
  });

  it('keeps the pin when placeholder layout clamps the previous programmatic scroll', () => {
    const pin = createBottomPin();
    expect(pin.onResize(at(0, 612, 553))).toBe(59);
    pin.onScroll(at(9, 815, 553));
    expect(pin.isPinned()).toBe(true);
    expect(pin.onResize(at(9, 2230, 553))).toBe(1677);
    pin.onScroll(at(1677, 2230, 553));
    pin.onScroll(at(1527, 2230, 553));
    expect(pin.isPinned()).toBe(false);
    expect(pin.onResize(at(1527, 3000, 553))).toBeNull();
  });

  it('respects an actual user upward scroll during simultaneous content growth', () => {
    const pin = createBottomPin();
    pin.onScroll(at(1400, 1800, 400));
    pin.onScroll(at(1250, 2000, 400), true);
    expect(pin.isPinned()).toBe(false);
    expect(pin.onResize(at(1250, 2000, 400))).toBeNull();
  });

  it('returns the bottom offset from onResize only while pinned', () => {
    const pin = createBottomPin();
    expect(pin.onResize(at(0, 1800, 400))).toBe(1400);
    pin.onScroll(at(1000, 1800, 400));
    expect(pin.isPinned()).toBe(false);
    expect(pin.onResize(at(1000, 2200, 400))).toBeNull();
  });

  it('pin() forces the pinned state', () => {
    const pin = createBottomPin();
    pin.onScroll(at(1400, 1800, 400));
    pin.onScroll(at(400, 1800, 400));
    expect(pin.isPinned()).toBe(false);
    pin.pin();
    expect(pin.isPinned()).toBe(true);
    expect(pin.onResize(at(400, 1800, 400))).toBe(1400);
  });
});
