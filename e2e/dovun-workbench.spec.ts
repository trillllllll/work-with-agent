import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    localStorage.setItem('dovun.theme', 'light');
    (window as any).__REACT_GRAB_DISABLED__ = true;
  });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('new installation starts Today, captures its first task without a hidden list, and works without a model', async ({ page, request, isMobile }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  if (!isMobile) await expect(page.getByRole('button', { name: '配置模型', exact: true })).toBeVisible();
  const created = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
  await page.getByRole('textbox', { name: '任务名称', exact: true }).fill('我的第一项工作');
  await page.getByRole('textbox', { name: '任务名称', exact: true }).press('Enter');
  const response = await created;
  expect(response.ok()).toBe(true);
  const task = (await response.json()).data;
  expect(task.topicId).toBeNull();
  expect(task.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByTestId(`task-row-${task.id}`)).toBeVisible();
  const navigation = (await (await request.get(api + '/api/settings/mobile-navigation')).json()).data;
  expect(navigation.visibleViews).toEqual(['today', 'plan', 'topics', 'library']);
});

test('shared rail preserves chat draft and keeps all header controls reachable after composer focus', async ({ page, request, isMobile }) => {
  test.skip(isMobile, 'shared desktop rail');
  await request.patch(api + '/api/settings', { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  await page.goto('/');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const assistant = page.getByTestId('ai-assistant');
  const input = assistant.getByRole('textbox', { name: '向 AI 提问', exact: true });
  await input.fill('未发送的原草稿');
  await assistant.getByRole('button', { name: '关闭聊天', exact: true }).click();
  await page.getByRole('button', { name: '帮我梳理今天的安排', exact: true }).click();
  await expect(input).toHaveValue('未发送的原草稿');
  const task = (await (await request.post(api + '/api/tasks', { data: { title: '右栏验收任务', topicId: null } })).json()).data;
  await page.evaluate(() => { location.hash = '/inbox'; });
  await page.getByTestId(`task-row-${task.id}`).click();
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 });
    await input.focus();
    await expect(assistant).toHaveCount(1);
    const bounds = await assistant.boundingBox();
    for (const label of ['关闭聊天', '放大到独立页']) {
      const button = assistant.getByRole('button', { name: label, exact: true });
      await expect(button).toBeVisible();
      const rect = await button.boundingBox();
      expect(rect!.y).toBeGreaterThanOrEqual(bounds!.y);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
      await expect(button).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('detail tabs keep the same editor and unsaved text mounted', async ({ page, request }) => {
  const task = (await (await request.post(api + '/api/tasks', { data: { title: '页签草稿', description: '原文', topicId: null } })).json()).data;
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).click();
  const editor = page.getByRole('textbox', { name: '详情', exact: true });
  await editor.fill('保留切换前的正文');
  await editor.evaluate(node => { node.setAttribute('data-test-instance', 'retained'); });
  await page.getByRole('tab', { name: '相关资料', exact: true }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('tab', { name: '工作上下文', exact: true }).click();
  await expect(page.getByRole('heading', { name: '当前简报', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '任务详情', exact: true }).click();
  await expect(editor).toContainText('保留切换前的正文');
  await expect(editor).toHaveAttribute('data-test-instance', 'retained');
});
