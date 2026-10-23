import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.beforeEach(async () => { await resetE2eDatabase(); });
test.afterAll(() => e2eDatabase.$disconnect());

test('missing model is explicit and a deleted source leaves the conversation open', async ({ page }) => {
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const assistant = page.getByTestId('ai-assistant');
  await expect(assistant.getByRole('status')).toContainText('未配置模型');
  const input = assistant.getByRole('textbox', { name: '向 AI 提问' });
  await input.fill('保留这条输入');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('wwa-open-source', { detail: { kind: 'task', id: 'deleted-source', title: '已删除任务' } })));
  await expect(page.getByText('来源已删除、不可访问或版本不存在', { exact: true })).toBeVisible();
  await expect(assistant).toBeVisible();
  await expect(input).toHaveValue('保留这条输入');
});

test('transport failure preserves the draft and offers retry', async ({ page, request }) => {
  await request.patch('http://127.0.0.1:3015/api/settings', { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const assistant = page.getByTestId('ai-assistant');
  const input = assistant.getByRole('textbox', { name: '向 AI 提问' });
  await input.fill('失败后保留的内容');
  await page.route('**/api/chat', (route) => route.abort('failed'));
  await assistant.getByRole('button', { name: '发送', exact: true }).click();
  await expect(assistant.getByText('连接中断', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(assistant.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await expect(input).toHaveValue('失败后保留的内容');
});
