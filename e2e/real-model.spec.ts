import { test, expect } from '@playwright/test';

test.skip(!process.env.E2E_REAL_MODEL, 'Set E2E_REAL_MODEL=1 to run the real-model smoke test');

test('real model connection and read-only chat', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByLabel('接口地址').fill(process.env.E2E_MODEL_BASE_URL!);
  await page.getByLabel('模型名称').fill(process.env.E2E_MODEL_NAME!);
  await page.getByLabel('API Key').fill(process.env.E2E_MODEL_API_KEY!);
  await page.getByRole('button', { name: '测试连接并保存' }).click();
  await expect(page.getByText('设置已保存，连接测试通过。')).toBeVisible();
  await page.goto('/#/chat');
  await page.getByPlaceholder('例如：创建任务：整理 API 文档').fill('列出任务');
  await page.getByRole('button', { name: '发送' }).click();
  const assistantMessage = page.getByText('Agent', { exact: true }).last().locator('..');
  await expect(assistantMessage).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await assistantMessage.textContent())?.trim().length ?? 0, { timeout: 30_000 }).toBeGreaterThan(5);
});
