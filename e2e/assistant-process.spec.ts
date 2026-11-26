import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const panel = (page: Page) => page.getByTestId('ai-assistant');

async function openAssistant(page: Page) {
  if (await panel(page).isVisible()) return;
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

async function ask(page: Page, text: string) {
  await openAssistant(page);
  await panel(page).getByRole('textbox', { name: '向 AI 提问' }).fill(text);
  await panel(page).getByRole('button', { name: '发送', exact: true }).click();
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  const response = await request.patch('http://127.0.0.1:3015/api/settings', { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  expect(response.ok()).toBe(true);
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
});

test.afterAll(() => e2eDatabase.$disconnect());

test('running history scrolls and a successful completion keeps only the summary', async ({ page, isMobile }) => {
  await page.goto('/#/inbox');
  await ask(page, '执行过程滚动验收');
  const assistant = panel(page);
  const peek = assistant.getByTestId('assistant-process-peek');
  await expect(peek).toBeVisible({ timeout: 15_000 });
  await expect(peek.locator('li')).toHaveCount(2, { timeout: 15_000 });
  await expect(assistant.getByText('正在输出…', { exact: true })).toHaveCount(0);
  if (!isMobile) await peek.hover();
  await expect(peek.locator('li')).toHaveCount(4, { timeout: 15_000 });
  await expect(peek.locator('li').last()).toContainText('正在整理回答');
  await expect(assistant.getByText('正在输出…', { exact: true })).toHaveCount(0);
  await expect.poll(() => peek.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  if (!isMobile) {
    expect(await peek.evaluate(element => element.scrollTop)).toBe(0);
    await assistant.getByRole('textbox', { name: '向 AI 提问' }).hover();
  }
  await expect.poll(() => peek.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(assistant.getByText('执行过程滚动验收完成。', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(peek).toHaveCount(0);
  const process = assistant.getByTestId('assistant-process').last();
  await expect(process.locator(':scope > summary')).toContainText('执行过程');
  await expect(process.locator(':scope > summary')).not.toContainText('失败');

  await page.reload();
  await openAssistant(page);
  await expect(assistant.getByText('执行过程滚动验收完成。', { exact: true })).toBeVisible();
  await expect(assistant.getByTestId('assistant-process-peek')).toHaveCount(0);
});

test('an empty first response keeps the original streaming placeholder without a process', async ({ page }) => {
  await page.goto('/#/inbox');
  await ask(page, '普通输出占位验收');
  const assistant = panel(page);
  await expect(assistant.getByText('正在输出…', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(assistant.getByTestId('assistant-process-peek')).toHaveCount(0);
  await expect(assistant.getByText('普通输出占位验收完成。', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(assistant.getByText('正在输出…', { exact: true })).toHaveCount(0);
});

test('a failed query stays only in expanded history without alerts or retry', async ({ page }) => {
  await page.goto('/#/inbox');
  await ask(page, '执行过程失败验收');
  const assistant = panel(page);
  const peek = assistant.getByTestId('assistant-process-peek');
  await expect(assistant.getByText('执行过程失败验收完成。', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(peek).toBeVisible();
  await expect(peek.locator('li')).toHaveCount(1);
  await expect(peek).not.toContainText('失败');
  await expect(peek).not.toContainText('不接受额外参数');
  const process = assistant.getByTestId('assistant-process').last();
  const summary = process.locator(':scope > summary');
  await expect(summary).toContainText('执行过程');
  await expect(summary).not.toContainText('失败');
  await expect(summary).not.toContainText('中断');
  await expect(assistant.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);

  await summary.click();
  await expect(process.locator('.assistant-process-step')).toHaveCount(2);
  await expect(process.locator('.assistant-process-step-icon svg.text-warning')).toHaveCount(1);
  await expect(process.locator('.assistant-process-step').last()).toContainText('不接受额外参数');
  await expect(process.locator('.assistant-process-warning')).toHaveCount(0);

  await page.reload();
  await openAssistant(page);
  const restoredPeek = assistant.getByTestId('assistant-process-peek');
  await expect(restoredPeek).toBeVisible();
  await expect(restoredPeek).not.toContainText('失败');
  await expect(assistant.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
});
