import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.use({ colorScheme: 'light' });

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
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

test('the narrow dark planning view keeps the porcelain date typography', async ({ page }) => {
  await page.setViewportSize({ width: 497, height: 868 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/#/plan');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.getByRole('button', { name: '日', exact: true }).click();
  const date = page.getByRole('button', { name: /^选择日期/ });
  await expect(date).toHaveCSS('font-family', /Bodoni 72/);
  await expect(date).toHaveCSS('font-style', 'italic');
  await expect(date).toHaveCSS('font-weight', '500');
  await expect(page.locator('.plan-date-cluster')).toHaveCSS('justify-content', 'space-between');
  expect(await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--preview-face').trim())).toBe('');
});

test('dark workspace pages share the demo heading typography', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const route of ['today', 'inbox', 'library', 'stats', 'focus']) {
    await page.goto('/#/' + route);
    const heading = page.locator('main[data-page="' + route + '"]').getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS('font-family', /Songti SC/);
  }
  await expect(page.getByTestId('focus-remaining')).toHaveCSS('font-family', /Bodoni 72/);
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  expect(await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--preview-face').trim())).toBe('');
});

test('narrow task and settings dialogs use the shared layout', async ({ page }) => {
  await page.setViewportSize({ width: 497, height: 868 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const now = new Date().toISOString();
  await e2eDatabase.task.create({ data: { id: 'porcelain-modal-task', title: '任务详情排版', createdAt: now, updatedAt: now } });
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '任务详情排版', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveCSS('font-size', '20px');
  await expect(detail.locator('.task-info-rows')).toHaveCSS('border-radius', '10px');

  await page.goto('/#/settings');
  await expect(page.locator('.workspace-modal-title')).toHaveCSS('font-family', /Songti SC/);
  await page.goto('/#/settings/model');
  await expect(page.locator('.workspace-modal-detail-title')).toHaveCSS('font-family', /Songti SC/);
});
