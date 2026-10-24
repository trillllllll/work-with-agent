import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
import { mkdir } from 'node:fs/promises';

const api = process.env.E2E_API_URL!;
const evidence = 'docs/design/dovun/context-optimization/evidence';
test.beforeEach(async ({ request, page }) => {
  await resetE2eDatabase();
  await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-context-no-usage', apiKey: 'test-key' } });
  await page.addInitScript(() => { if (!sessionStorage.getItem('context-test-init')) { localStorage.removeItem('dovun.conversationId'); sessionStorage.setItem('context-test-init', '1'); } (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('real requests record context composition; floating controls work in both themes, narrow screens and after reload', async ({ page, request }, info) => {
  test.setTimeout(100_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await request.post(`${api}/api/tasks`, { data: { title: '整理产品资料，核对任务安排' } });
  await page.goto('/#/chat');
  const trigger = page.getByTestId('context-usage-trigger');
  await trigger.click();
  await expect(page.getByTestId('context-usage-popover')).toContainText('发送消息后');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.getByRole('textbox', { name: '向 AI 提问' }).fill('上下文统计验收：查询我的任务，保持数据不变。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('已读取隔离工作台的任务。保持原有数据，未进行修改。', { exact: true })).toBeVisible();
  await expect(trigger).toContainText('≈');
  const conversationId = await page.evaluate(() => localStorage.getItem('dovun.conversationId'));
  const snapshot = (await (await request.get(`${api}/api/conversations/${conversationId}/snapshot`)).json()).data;
  expect(snapshot.contextStats.categories.reduce((sum: number, c: any) => sum + c.tokens, 0)).toBe(snapshot.contextStats.estimatedInputTokens);
  expect(snapshot.contextStats.totals.requests).toBe(2);
  expect(snapshot.contextStats.totals.actualInputTokens).toBeNull();
  expect(snapshot.contextStats.tools.some((t: any) => t.name === 'propose_changes')).toBe(false);
  expect(snapshot.contextStats.baseline.toolTokens).toBeGreaterThan(snapshot.contextStats.categories.find((c: any) => c.id === 'tools').tokens * 2);
  await mkdir(evidence, { recursive: true });
  for (const theme of ['light', 'dark']) for (const width of [1586, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 992 });
    await page.evaluate(theme => { document.documentElement.className = theme; localStorage.setItem('dovun.theme', theme); }, theme);
    await trigger.click();
    const popup = page.getByTestId('context-usage-popover');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText('工具定义');
    await expect(popup).toContainText('模型容量未配置');
    await expect(popup).toContainText('未返回');
    expect(await popup.evaluate(el => getComputedStyle(el).backgroundImage)).toContain('linear-gradient');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = (await popup.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(15); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    if (info.project.name === 'chromium' && [1586, 390].includes(width)) await page.screenshot({ path: `${evidence}/context-${theme}-${width}.png`, animations: 'disabled' });
    await popup.locator('summary').click();
    await expect(popup.getByText('query_tasks', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  }
  await page.reload();
  await page.getByTestId('context-usage-trigger').click();
  await expect(page.getByTestId('context-usage-popover')).toContainText('第 2 次调用');
  await page.keyboard.press('Escape');
  await page.evaluate(() => localStorage.setItem('dovun.language', 'en'));
  await page.reload();
  await page.getByRole('button', { name: 'View context usage' }).click();
  await expect(page.getByTestId('context-usage-popover')).toContainText('Tool definitions');
  expect(errors).toEqual([]);
});

test('lazy loading still requires preview approval and keeps its state after confirmation', async ({ page, request }) => {
  await page.goto('/#/chat');
  await page.getByRole('textbox', { name: '向 AI 提问' }).fill('按需提案验收');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-state', 'pending');
  expect(await e2eDatabase.task.count({ where: { title: '上下文按需加载审批验证' } })).toBe(0);
  await card.getByRole('button', { name: '确认修改', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'executed');
  await expect(page.getByText('已收到审批后的真实执行回执。', { exact: true })).toBeVisible();
  expect(await e2eDatabase.task.count({ where: { title: '上下文按需加载审批验证' } })).toBe(1);
  const id = await page.evaluate(() => localStorage.getItem('dovun.conversationId'));
  const stats = (await (await request.get(`${api}/api/conversations/${id}/snapshot`)).json()).data.contextStats;
  expect(stats.loadedGroups).toContain('workspace_write');
  expect(stats.totals.requests).toBe(3);
});
