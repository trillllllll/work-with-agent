import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('设置里切换到英文后界面变为英文，刷新后保持，切回中文也保持', async ({ page }) => {
  await page.goto('/#/settings/ui');
  const section = page.getByTestId('language-settings');
  await expect(section.getByRole('heading', { name: '语言' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

  await section.getByRole('button', { name: 'English' }).click();
  await expect(section.getByRole('heading', { name: 'Language' })).toBeVisible();
  await expect(section.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.evaluate(() => window.localStorage.getItem('wwa.language'))).toBe('en');

  await page.goto('/#/more');
  const apiRequest = page.waitForRequest((request) => request.url().includes('/api/'));
  await page.reload();
  // Every API call carries the chosen language so server messages come back in English.
  expect((await apiRequest).headers()['x-wwa-language']).toBe('en');
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  await expect(nav.getByRole('button', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.goto('/#/settings/ui');
  await page.getByTestId('language-settings').getByRole('button', { name: '简体中文' }).click();
  await expect(page.getByTestId('language-settings').getByRole('heading', { name: '语言' })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('language-settings').getByRole('heading', { name: '语言' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});

test('服务端按请求语言返回错误信息', async ({ request }) => {
  const apiUrl = 'http://127.0.0.1:3015';
  const english = await request.get(`${apiUrl}/api/tasks/missing-task`, { headers: { 'X-WWA-Language': 'en' } });
  expect(english.status()).toBe(404);
  expect((await english.json()).error).toBe('Task does not exist');
  const chinese = await request.get(`${apiUrl}/api/tasks/missing-task`);
  expect((await chinese.json()).error).toBe('任务不存在');
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
