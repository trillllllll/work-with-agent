import { test, expect } from './fixtures.js';
import { resetE2eDatabase } from './database.js';

test.beforeEach(resetE2eDatabase);

test('回收站读取失败显示错误与重试，不显示为空', async ({ page }) => {
  let failing = true;
  await page.route('**/api/trash/tasks', async (route) => { if (failing) await route.abort(); else await route.continue(); });
  await page.goto('/#/trash');
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('回收站为空')).toHaveCount(0);
  failing = false;
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('回收站为空')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
