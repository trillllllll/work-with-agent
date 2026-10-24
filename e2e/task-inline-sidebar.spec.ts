import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  await page.addInitScript(() => { (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('task and assistant fill one rail and retain editor, chat draft, attachments and keyboard focus', async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const task = (await (await request.post(`${api}/api/tasks`, { data: { title: '侧栏编辑保留', description: '任务正文' } })).json()).data;
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: task.title, exact: true }).click();
  const rail = page.getByRole('tablist', { name: '工作侧栏' });
  const editor = page.getByLabel('任务标题', { exact: true });
  const assistant = page.getByTestId('ai-assistant');
  await expect(rail).toBeVisible();
  const side = page.locator('.dovun-work-rail');
  await expect(side.getByRole('button', { name: /关闭|返回当前页面/ })).toHaveCount(1);
  const tabsBox = await rail.boundingBox();
  const sideBox = await side.boundingBox();
  const headerBox = await page.locator('.dovun-rail-header').boundingBox();
  expect(tabsBox!.width).toBeLessThan(230);
  expect(tabsBox!.width).toBeLessThan(sideBox!.width * 0.7);
  expect(headerBox!.height).toBeLessThan(85);
  await expect(rail.getByRole('tab', { name: '任务', exact: true })).toHaveCSS('transition-duration', '0s');
  await editor.fill('侧栏编辑后的标题');
  await editor.evaluate(node => { (node as any).__sidebarRetained = true; });
  await page.getByRole('button', { name: '问 AI', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(assistant).toBeVisible();
  await expect(assistant.getByTestId('assistant-task-reference')).toHaveCount(0);
  await expect(side.getByRole('button', { name: /关闭|返回当前页面/ })).toHaveCount(1);
  await expect(assistant.getByTestId('assistant-context')).toContainText('侧栏编辑后的标题');
  await assistant.getByLabel('向 AI 提问').fill('不要丢失聊天草稿');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('dovun-open-assistant', { detail: { attachment: { id: 'sidebar-reference', title: '侧栏草稿附件', kind: 'draft', text: '未保存内容', unsaved: true } } })));
  await rail.getByRole('tab', { name: '任务', exact: true }).click();
  await expect(assistant).toBeHidden();
  await expect(editor).toHaveValue('侧栏编辑后的标题');
  expect(await editor.evaluate(node => (node as any).__sidebarRetained)).toBe(true);
  await expect(rail.getByLabel('有未发送草稿')).toBeVisible();
  await rail.getByRole('tab', { name: '任务', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(rail.getByRole('tab', { name: 'AI 助手', exact: true })).toBeFocused();
  await expect(assistant.getByLabel('向 AI 提问')).toHaveValue('不要丢失聊天草稿');
  await expect(assistant.getByText('侧栏草稿附件 · 未保存草稿', { exact: true })).toBeVisible();
  const box = await page.locator('#work-rail-panel-assistant').boundingBox();
  const railBox = await page.locator('.dovun-work-rail').boundingBox();
  expect(box!.height).toBeGreaterThan(railBox!.height * 0.65);
  await page.screenshot({ path: `/tmp/dovun-sidebar-ai-${testInfo.project.name}.png` });
  await rail.getByRole('tab', { name: '任务', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect.poll(async () => (await (await request.get(`${api}/api/tasks/${task.id}`)).json()).data.title).toBe('侧栏编辑后的标题');
  await page.screenshot({ path: `/tmp/dovun-sidebar-task-${testInfo.project.name}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('opening another task returns to task tab and next AI message references that task', async ({ page, request, isMobile }) => {
  const tasks = [];
  for (const title of ['侧栏任务甲', '侧栏任务乙']) tasks.push((await (await request.post(`${api}/api/tasks`, { data: { title } })).json()).data);
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${tasks[0].id}`).getByRole('button', { name: tasks[0].title, exact: true }).click();
  await page.getByRole('button', { name: '问 AI', exact: true }).click();
  if (isMobile) {
    // On a narrow screen the list is behind the rail; use the same task-open event as source links.
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('dovun-open-task', { detail: { taskId: id } })), tasks[1].id);
  } else await page.getByTestId(`task-row-${tasks[1].id}`).getByRole('button', { name: tasks[1].title, exact: true }).click();
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(tasks[1].title);
  await expect(page.getByRole('tab', { name: '任务', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '问 AI', exact: true }).click();
  const assistant = page.getByTestId('ai-assistant');
  await expect(assistant.getByTestId('assistant-context')).toContainText(tasks[1].title);
  const sent = page.waitForRequest(req => req.url().endsWith('/api/chat') && req.method() === 'POST');
  await assistant.getByLabel('向 AI 提问').fill('AI验收侧栏当前任务');
  await assistant.getByRole('button', { name: '发送', exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.context.taskId).toBe(tasks[1].id);
  expect(body.context.selectedTaskIds).toEqual([tasks[1].id]);
  await expect(assistant.getByText('AI验收完成，已读取当前页面与功能说明。', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('tab', { name: 'AI 助手', exact: true }).click();
  await expect(assistant.getByText('AI验收完成，已读取当前页面与功能说明。', { exact: true })).toBeVisible();
});

test('closing the rail saves the task, hides both panes and preserves assistant input', async ({ page, request }) => {
  const task = (await (await request.post(`${api}/api/tasks`, { data: { title: '关闭侧栏前保存' } })).json()).data;
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: task.title, exact: true }).click();
  await page.getByLabel('任务标题', { exact: true }).fill('关闭侧栏保存后的标题');
  await page.getByRole('button', { name: '问 AI', exact: true }).click();
  await page.getByLabel('向 AI 提问').fill('关闭后仍保留');
  await page.getByRole('button', { name: '关闭工作侧栏', exact: true }).click();
  await expect(page.getByRole('tablist', { name: '工作侧栏' })).toHaveCount(0);
  await expect(page.getByTestId('ai-assistant')).toBeHidden();
  await expect.poll(async () => (await (await request.get(`${api}/api/tasks/${task.id}`)).json()).data.title).toBe('关闭侧栏保存后的标题');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.getByLabel('向 AI 提问')).toHaveValue('关闭后仍保留');
});

test('assistant task sources open the task tab from side and expanded presentations', async ({ page, request }) => {
  const task = (await (await request.post(`${api}/api/tasks`, { data: { title: '来自助手的任务' } })).json()).data;
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('dovun-open-source', { detail: { kind: 'task', id, title: '来自助手的任务' } })), task.id);
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(task.title);
  await expect(page.getByRole('tab', { name: '任务', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '问 AI', exact: true }).click();
  await page.getByRole('button', { name: '放大到独立页', exact: true }).click();
  await expect(page.getByTestId('assistant-page')).toBeVisible();
  await expect(page.getByTestId('ai-assistant')).toHaveAttribute('data-presentation', 'expanded');
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('dovun-open-source', { detail: { kind: 'task', id, title: '来自助手的任务' } })), task.id);
  await expect(page).toHaveURL(/#\/inbox$/);
  await expect(page.getByLabel('任务标题', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-assistant')).toBeHidden();
});
