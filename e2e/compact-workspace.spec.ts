import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    localStorage.setItem('dovun.theme', 'dark');
    (window as any).__REACT_GRAB_DISABLED__ = true;
  });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('桌面移除全局横栏，左侧入口在原页面打开助手并释放内容空间', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/plan');
  await expect(page.getByRole('heading', { name: '规划', exact: true })).toBeVisible();
  await expect(page.locator('.dovun-appbar')).toHaveCount(0);
  await expect(page.getByText('个人工作台', { exact: true })).toHaveCount(0);

  const frame = await page.locator('.dovun-workspace').boundingBox();
  const main = await page.locator('.dovun-main').boundingBox();
  expect(Math.abs(main!.y - frame!.y)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page).toHaveURL(/#\/plan$/);
  await expect(page.getByTestId('ai-assistant')).toBeVisible();
  await expect(page.locator('.assistant-compact-nav')).toHaveCount(0);
  await expect(page.locator('.app-sidebar').getByRole('button', { name: '打开 AI 助手', exact: true })).toHaveAttribute('aria-expanded', 'true');
  const rail = await page.locator('.dovun-work-rail').boundingBox();
  expect(rail!.y).toBe(main!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('desktop-compact.png') });
});

test('手机不保留横栏，轻量入口在原页面打开全屏助手', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/plan');
  await expect(page.getByRole('heading', { name: '规划', exact: true })).toBeVisible();
  await expect(page.locator('.dovun-appbar')).toHaveCount(0);
  const trigger = page.getByRole('button', { name: '打开 AI 助手', exact: true });
  await expect(trigger).toBeVisible();
  const main = await page.locator('.dovun-main').boundingBox();
  expect(main!.y).toBe(0);
  const headerAction = await page.locator('.plan-header').getByRole('button').boundingBox();
  const assistantAction = await trigger.boundingBox();
  expect(assistantAction!.y).toBeGreaterThan(headerAction!.y + headerAction!.height);
  await page.screenshot({ path: testInfo.outputPath('mobile-compact.png') });
  await trigger.click();
  await expect(page).toHaveURL(/#\/plan$/);
  await expect(page.getByTestId('ai-assistant')).toBeVisible();
  await expect(trigger).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
