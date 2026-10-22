// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sidebarScrollChrome } from './sidebar-scroll.js';

describe('sidebar scroll chrome', () => {
  it('hides the thumb and the fades when the list fits', () => {
    expect(sidebarScrollChrome(0, 400, 400)).toEqual({ fade: '', empty: true, height: 0, offset: 0 });
  });

  it('fades only the edge that still has content', () => {
    expect(sidebarScrollChrome(0, 900, 400).fade).toBe('b');
    expect(sidebarScrollChrome(500, 900, 400).fade).toBe('t');
    expect(sidebarScrollChrome(200, 900, 400).fade).toBe('tb');
  });

  it('keeps the thumb inside the visible rail', () => {
    const top = sidebarScrollChrome(0, 900, 400);
    const bottom = sidebarScrollChrome(500, 900, 400);
    expect(top.empty).toBe(false);
    expect(top.offset).toBe(0);
    expect(bottom.offset + bottom.height).toBeCloseTo(400);
    expect(top.height).toBeGreaterThanOrEqual(36);
  });
});
