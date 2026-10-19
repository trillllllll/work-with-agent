import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('设置里切换到英文后界面变为英文，刷新后保持，切回中文也保持', async ({ page }) => {
  await page.goto('/#/settings');
  const section = page.getByTestId('language-settings');
  await expect(section.getByRole('heading', { name: '语言' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

  await section.getByRole('button', { name: 'English' }).click();
  await expect(section.getByRole('heading', { name: 'Language' })).toBeVisible();
  await expect(section.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.evaluate(() => window.localStorage.getItem('wwa.language'))).toBe('en');

  await page.goto('/#/more');
  await page.reload();
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  await expect(nav.getByRole('button', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.goto('/#/settings');
  await page.getByTestId('language-settings').getByRole('button', { name: '简体中文' }).click();
  await expect(page.getByTestId('language-settings').getByRole('heading', { name: '语言' })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('language-settings').getByRole('heading', { name: '语言' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});

test.describe('英文浏览器', () => {
  test.use({ locale: 'en-US' });
  test('浏览器语言为英文时默认显示英文界面', async ({ page }) => {
    await page.goto('/#/more');
    const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
    await expect(nav.getByRole('button', { name: 'Inbox', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
