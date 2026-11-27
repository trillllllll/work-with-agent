// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { drawerSettleDuration, drawerSettlesOpen, VelocityTracker } from './navigation-drawer-motion.js';

describe('drawerSettlesOpen', () => {
  it('opens on a rightward flick that travelled far enough', () => {
    expect(drawerSettlesOpen(80, 320, 1.2)).toBe(true);
  });
  it('keeps short flicks closed', () => {
    expect(drawerSettlesOpen(30, 320, 1.2)).toBe(false);
  });
  it('closes on a leftward flick even past halfway', () => {
    expect(drawerSettlesOpen(250, 320, -0.8)).toBe(false);
  });
  it('settles on the nearer side when released slowly', () => {
    expect(drawerSettlesOpen(120, 320, 0)).toBe(false);
    expect(drawerSettlesOpen(200, 320, 0)).toBe(true);
  });
  it('ignores velocity when the browser cancelled the touch', () => {
    expect(drawerSettlesOpen(80, 320, 2, true)).toBe(false);
    expect(drawerSettlesOpen(240, 320, -2, true)).toBe(true);
  });
});

describe('drawerSettleDuration', () => {
  it('finishes faster after a fast flick and stays within bounds', () => {
    expect(drawerSettleDuration(240, 3, false)).toBe(170);
    expect(drawerSettleDuration(240, 0, false)).toBe(340);
    expect(drawerSettleDuration(100, 0.9, false)).toBeGreaterThan(170);
  });
  it('skips the animation for reduced motion', () => {
    expect(drawerSettleDuration(240, 0, true)).toBe(0);
  });
});

describe('VelocityTracker', () => {
  it('measures recent movement', () => {
    const tracker = new VelocityTracker();
    for (let t = 0; t <= 50; t += 10) tracker.push(t, t * 2);
    expect(tracker.velocity(55)).toBeCloseTo(2);
  });
  it('treats a finger that paused before lifting as stopped', () => {
    const tracker = new VelocityTracker();
    tracker.push(0, 0);
    tracker.push(16, 40);
    expect(tracker.velocity(200)).toBe(0);
  });
  it('only keeps the last ~90ms of samples', () => {
    const tracker = new VelocityTracker();
    tracker.push(0, 0);
    tracker.push(100, 300);
    tracker.push(150, 310);
    tracker.push(200, 320);
    expect(tracker.velocity(205)).toBeCloseTo(0.2);
  });
});
