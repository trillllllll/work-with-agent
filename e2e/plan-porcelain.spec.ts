import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    localStorage.setItem('dovun.theme', 'light');
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
  });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('production planning and task pages share the porcelain preview skin', async ({ page }) => {
  await page.goto('/#/plan');
  await expect(page.getByRole('button', { name: /^选择日期/ })).toBeVisible();
  await expect(page.locator('main.dovun-main[data-page="plan"]')).toHaveCSS('background-image', /linear-gradient/);
  await expect(page.locator('.plan-date-title')).toHaveCSS('font-family', /Bodoni 72/);
  expect(await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--preview-face').trim())).toBe('#fffdf8');

  await page.goto('/#/inbox');
  await expect(page.locator('.dovun-page-header h1')).toHaveCSS('font-family', /Songti SC/);
  await expect(page.locator('main.dovun-main[data-page="inbox"]')).toHaveCSS('background-image', /linear-gradient/);
  await expect(page.locator('.dovun-task-content .list-surface')).toHaveCSS('background-image', /linear-gradient/);

  await page.evaluate(() => document.documentElement.classList.add('dark'));
  expect(await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--preview-face').trim())).toBe('');
});
