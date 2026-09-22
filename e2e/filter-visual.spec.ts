import { test, expect } from './fixtures.js';
import { resetE2eDatabase } from './database.js';

test.beforeEach(resetE2eDatabase);

test('筛选区在桌面和窄屏可折叠且不横向溢出', async ({ page }) => {
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/inbox');
  await expect(page.getByRole('combobox', { name: '筛选完成状态', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '筛选完成状态', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '任务排序', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开聊天', exact: true }).click();
  expect(await fits()).toBe(false);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/#/search');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '筛选清单', exact: true })).toBeVisible();
  await expect(page.getByLabel('截止日期从', { exact: true })).toBeVisible();
  expect(await fits()).toBe(false);
  await page.goto('/#/today');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '筛选完成状态', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('截止日期从', { exact: true })).toHaveCount(0);
  await page.goto('/#/tags');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '筛选标签', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '筛选清单', exact: true })).toBeVisible();
  expect(await fits()).toBe(false);
});
