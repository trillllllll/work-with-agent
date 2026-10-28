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
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('dovun-open-source', { detail: { kind: 'task', id: 'deleted-source', title: '已删除任务' } })));
  await expect(page.getByText('来源已删除、不可访问或版本不存在', { exact: true })).toBeVisible();
  await expect(assistant).toBeVisible();
  await expect(input).toHaveValue('保留这条输入');
});

test('transport failure clears the box and recovers idempotently via the request key', async ({ page, request }) => {
  await request.patch('http://127.0.0.1:3015/api/settings', { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const assistant = page.getByTestId('ai-assistant');
  const input = assistant.getByRole('textbox', { name: '向 AI 提问' });
  await input.fill('对话思考验收：开始');
  let chatCalls = 0;
  await page.route('**/api/chat', async (route) => { chatCalls += 1; if (chatCalls === 1) return route.abort('failed'); return route.continue(); });
  await assistant.getByRole('button', { name: '发送', exact: true }).click();
  // The box is cleared at send time; an unknown outcome never restores the text (duplicate-send risk).
  await expect(input).toHaveValue('');
  await expect(page.getByText('先完成计数器练习。', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(input).toHaveValue('');
  await expect(assistant.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
  expect(chatCalls).toBe(2);
});

test('transport failure with no recovery keeps the retry entry and an empty box', async ({ page, request }) => {
  await request.patch('http://127.0.0.1:3015/api/settings', { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const assistant = page.getByTestId('ai-assistant');
  const input = assistant.getByRole('textbox', { name: '向 AI 提问' });
  await input.fill('彻底断线的请求');
  await page.route('**/api/chat', (route) => route.abort('failed'));
  await assistant.getByRole('button', { name: '发送', exact: true }).click();
  await expect(assistant.getByText('连接中断', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(assistant.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
});

test('an explicit rejection restores the original only when no newer draft exists', async ({ page, request }) => {
  expect((await request.patch('http://127.0.0.1:3015/api/settings', { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } })).ok()).toBe(true);
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const assistant = page.getByTestId('ai-assistant');
  const input = assistant.getByRole('textbox', { name: '向 AI 提问' });
  const refuse = () => page.route('**/api/chat', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'mock 拒绝' }) }));
  await refuse();
  await input.fill('被拒后恢复的原文');
  await assistant.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('mock 拒绝', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('被拒后恢复的原文');
  await expect(assistant.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  // The refused message never reached the server, so it must not stay in the thread.
  await expect(assistant.locator('.assistant-thread')).not.toContainText('被拒后恢复的原文');

  await page.unroute('**/api/chat');
  await page.route('**/api/chat', async (route) => { await new Promise((resolve) => setTimeout(resolve, 600)); return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'mock 拒绝' }) }); });
  await input.fill('新稿场景的原文');
  await assistant.getByRole('button', { name: '发送', exact: true }).click();
  await input.fill('等待时的新草稿');
  await expect(page.getByText('mock 拒绝', { exact: true }).last()).toBeVisible({ timeout: 10_000 });
  // The newer draft wins; the refused original stays visible in the thread as its recovery entry.
  await expect(input).toHaveValue('等待时的新草稿');
  await expect(assistant.locator('.assistant-thread')).toContainText('新稿场景的原文');
  await assistant.getByRole('button', { name: '重试', exact: true }).click();
  await expect(input).toHaveValue('等待时的新草稿');
});

test('an upstream failure keeps the cleared box and the accepted message', async ({ page, request }) => {
  expect((await request.patch('http://127.0.0.1:3015/api/settings', { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } })).ok()).toBe(true);
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const assistant = page.getByTestId('ai-assistant');
  const input = assistant.getByRole('textbox', { name: '向 AI 提问' });
  await input.fill('上游错误');
  await assistant.getByRole('button', { name: '发送', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.getByText(/模型服务错误/)).toBeVisible({ timeout: 15_000 });
  await expect(input).toHaveValue('');
  await expect(assistant.locator('.assistant-thread')).toContainText('上游错误');
});

test('sending clears the box immediately and a retyped identical draft survives completion', async ({ page, request }) => {
  expect((await request.patch('http://127.0.0.1:3015/api/settings', { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } })).ok()).toBe(true);
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const assistant = page.getByTestId('ai-assistant');
  const input = assistant.getByRole('textbox', { name: '向 AI 提问' });
  await input.fill('对话思考验收：开始');
  await assistant.getByRole('button', { name: '发送', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(assistant.getByTestId('assistant-reasoning')).toHaveAttribute('data-state', 'streaming');
  await input.fill('对话思考验收：开始');
  await expect(assistant.getByText('先完成计数器练习。', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(input).toHaveValue('对话思考验收：开始');
});
