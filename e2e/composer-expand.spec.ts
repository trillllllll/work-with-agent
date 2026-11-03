import { type Locator } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { resetE2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';

// 行为基准：单行 ≈ 28px（20px 行高 + 8px 上下内边距），展开 3 行 ≈ 68px，8 行封顶 ≈ 168px。
const COLLAPSED_MAX = 34;
const EXPANDED_MIN = 58;
const EXPANDED_MAX = 174;

test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  expect((await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } })).ok()).toBe(true);
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
});

const heightOf = (loc: Locator) => loc.evaluate((el) => el.getBoundingClientRect().height);

test('输入框默认单行，聚焦展开、随内容长高、失焦与清空收回', async ({ page }) => {
  await page.goto('/#/chat');
  const panel = page.getByTestId('ai-assistant');
  const input = panel.getByLabel('向 AI 提问');
  await expect(input).toBeVisible();
  const collapsed = await heightOf(input);
  expect(collapsed).toBeLessThanOrEqual(COLLAPSED_MAX);

  await input.focus();
  await expect.poll(() => heightOf(input)).toBeGreaterThanOrEqual(EXPANDED_MIN);
  const expanded = await heightOf(input);

  // 展开后底边不得超出可视区（键盘遮挡防护，与 global-assistant 同一底线）。
  const bottom = await input.evaluate((el) => el.getBoundingClientRect().bottom);
  expect(bottom).toBeLessThanOrEqual((await page.evaluate(() => visualViewport.height)) + 1);

  // 多行内容继续长高，封顶后改为框内滚动。
  await input.fill(Array.from({ length: 12 }, (_, index) => `第${index}行内容`).join('\n'));
  await expect.poll(() => heightOf(input)).toBeLessThanOrEqual(EXPANDED_MAX);
  expect(await heightOf(input)).toBeGreaterThan(expanded);
  expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  // 有内容时失焦保持展开。
  await page.locator('[data-chat-scroll]').click({ position: { x: 10, y: 10 } });
  expect(await heightOf(input)).toBeGreaterThanOrEqual(EXPANDED_MIN);

  // 清空并失焦收回单行。
  await input.fill('');
  await page.locator('[data-chat-scroll]').click({ position: { x: 10, y: 10 } });
  await expect.poll(() => heightOf(input)).toBeLessThanOrEqual(COLLAPSED_MAX);
});

test('Enter 发送后即使保持焦点也收回单行，再输入重新展开', async ({ page }) => {
  await page.goto('/#/chat');
  const panel = page.getByTestId('ai-assistant');
  const input = panel.getByLabel('向 AI 提问');
  await input.fill('对话思考验收：开始');
  await page.keyboard.press('Enter');
  await expect.poll(() => heightOf(input), { timeout: 5_000 }).toBeLessThanOrEqual(COLLAPSED_MAX);
  await expect(panel.getByText('先完成计数器练习。', { exact: true })).toBeVisible({ timeout: 15_000 });
  await input.pressSequentially('再');
  await expect.poll(() => heightOf(input)).toBeGreaterThanOrEqual(EXPANDED_MIN);
});
