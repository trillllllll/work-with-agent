import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.beforeEach(() => resetE2eDatabase());
test.afterAll(() => e2eDatabase.$disconnect());

// UI state rendering only. Real restart/offline/HTTP delivery is covered in sync-http.test.ts.
test('sync failure retains a pending count and retry waits for confirmation', async ({ page }) => {
  let retried = false;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/sync/status', route => route.fulfill({ json: { data: {
    mode: 'local', bound: true, url: 'https://sync.example.test', baselineReady: true, appliedHubSeq: 10,
    pending: retried ? 0 : 2, lastSuccessAt: retried ? '2026-10-25T11:00:00Z' : null,
    lastError: retried ? null : 'SYNC_UNAVAILABLE', syncing: false,
  }, error: null } }));
  await page.route('**/api/v1/sync/conflicts', route => route.fulfill({ json: { data: [], error: null } }));
  await page.route('**/api/v1/sync/run', async route => {
    expect(route.request().method()).toBe('POST');
    retried = true;
    await route.fulfill({ json: { data: { appliedHubSeq: 11 }, error: null } });
  });
  await page.goto('/#/settings/data');
  await expect(page.getByText('暂时无法同步。本机修改已保留，会自动重试。')).toBeVisible();
  await expect(page.getByText('2 条修改待同步', { exact: true })).toBeVisible();
  await expect(page.getByLabel('同步凭据', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '立即重试', exact: true }).click();
  await expect(page.getByText(/最近一次同步成功：/)).toBeVisible();
  await expect(page.getByText('2 条修改待同步', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('sync-confirmed.png'), fullPage: true });
  expect(errors).toEqual([]);
});
