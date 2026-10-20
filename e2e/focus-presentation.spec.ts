import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('专注可在独立页和侧栏之间放大缩小，收起后离开页面', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium');
  await page.goto('/#/plan');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '专注', exact: true }).click();
  const focus = page.getByTestId('focus-page');
  await expect(page).toHaveURL(/#\/focus$/);
  await expect(focus).toHaveAttribute('data-presentation', 'expanded');
  await focus.getByRole('button', { name: '缩小回原页面' }).click();
  await expect(page).toHaveURL(/#\/plan$/);
  const side = page.locator('.accessory-pane').getByTestId('focus-page');
  await expect(side).toBeVisible();
  await expect(side).toHaveAttribute('data-presentation', 'side');
  await side.getByRole('button', { name: '放大到独立页' }).click();
  await expect(page).toHaveURL(/#\/focus$/);
  await expect(page.getByTestId('focus-page')).toHaveAttribute('data-presentation', 'expanded');
  await page.getByRole('button', { name: '缩小回原页面' }).click();
  await expect(page).toHaveURL(/#\/plan$/);
  await expect(page.locator('.accessory-pane').getByTestId('focus-page')).toHaveAttribute('data-presentation', 'side');
  await page.getByRole('button', { name: '收起专注' }).click();
  await expect(page.getByTestId('focus-page')).toBeHidden();
});

test('直接进入专注页没有尺寸控件', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium');
  await page.goto('/#/focus');
  const focus = page.getByTestId('focus-page');
  await expect(focus).toHaveAttribute('data-presentation', 'direct');
  await expect(focus.getByRole('button', { name: /放大|缩小|收起专注/ })).toHaveCount(0);
});

test('打开 AI 助手会关掉专注侧栏', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium');
  await page.goto('/#/plan');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '专注', exact: true }).click();
  await page.getByRole('button', { name: '缩小回原页面' }).click();
  await expect(page.locator('.accessory-pane').getByTestId('focus-page')).toHaveAttribute('data-presentation', 'side');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.getByTestId('focus-page')).toBeHidden();
  await expect(page.getByTestId('ai-assistant')).toHaveAttribute('data-presentation', 'side');
});
