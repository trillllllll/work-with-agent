import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';

test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('侧栏滚动条浮出且不占宽，边缘按剩余内容渐隐', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '桌面侧栏');
  await resetE2eDatabase();
  for (let index = 0; index < 18; index += 1) {
    expect((await request.post(`${apiUrl}/api/topics`, { data: { name: `滚动清单${index}` } })).ok()).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/plan');
  await expect(page.getByRole('heading', { name: '规划', exact: true })).toBeVisible();
  const scroller = page.locator('.app-sidebar .sidebar-scroll');
  const rail = page.locator('.app-sidebar .sidebar-rail');
  await expect(page.getByRole('button', { name: '滚动清单0', exact: true })).toBeVisible();
  await expect.poll(() => scroller.evaluate((node) => node.scrollHeight > node.clientHeight + 8)).toBe(true);

  const rested = await scroller.evaluate((node) => {
    const rail = node.parentElement as HTMLElement;
    return {
      gap: rail.clientWidth - node.clientWidth,
      scrollbarWidth: getComputedStyle(node).scrollbarWidth,
      className: rail.className,
    };
  });
  expect(rested.gap).toBe(0);
  expect(rested.scrollbarWidth).toBe('none');
  expect(rested.className).toContain('fade-b');
  expect(rested.className).not.toMatch(/fade-t|fade-tb|is-on/);
  await expect(page.locator('.sidebar-scroll .sidebar-header')).toHaveCount(0);
  await expect(page.locator('.sidebar-footer')).toBeVisible();

  const lightThumb = await rail.locator('.sidebar-scroll-thumb').evaluate((node) => getComputedStyle(node).backgroundColor);
  const darkThumb = await rail.locator('.sidebar-scroll-thumb').evaluate((node) => {
    document.documentElement.classList.add('dark');
    const color = getComputedStyle(node).backgroundColor;
    document.documentElement.classList.remove('dark');
    return color;
  });
  expect(darkThumb).not.toBe(lightThumb);

  await scroller.evaluate((node) => { node.scrollTop = 160; });
  await expect(rail).toHaveClass(/is-on/);
  await expect(rail).toHaveClass(/fade-tb/);
  await expect.poll(() => rail.locator('.sidebar-scroll-thumb').evaluate((node) => Number.parseFloat(node.style.height))).toBeGreaterThan(30);

  const before = await scroller.evaluate((node) => node.scrollTop);
  const thumb = rail.locator('.sidebar-scroll-thumb');
  const box = await thumb.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 8);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 90, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(before + 20);

  await page.mouse.move(900, 200);
  await expect(rail).not.toHaveClass(/is-on/, { timeout: 1500 });

  const mainScrollbar = await page.locator('.app-main').evaluate((node) => getComputedStyle(node).scrollbarWidth);
  expect(mainScrollbar).toBe('thin');

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const compact = page.locator('.assistant-compact-nav .sidebar-scroll');
  await expect(compact).toBeVisible();
  await expect.poll(() => compact.evaluate((node) => {
    const rail = node.parentElement as HTMLElement;
    return { gap: rail.clientWidth - node.clientWidth, fade: (rail.className.includes('fade-b') || rail.className.includes('fade-tb') || rail.className.includes('fade-t')) === (node.scrollHeight > node.clientHeight + 1) };
  })).toEqual({ gap: 0, fade: true });
});
