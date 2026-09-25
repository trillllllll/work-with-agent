import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = 'http://127.0.0.1:3015';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('层级清单不重复当前清单名，搜索仍显示归属', async ({ page, request }) => {
  const topic = await (await request.post(`${apiUrl}/api/topics`, { data: { name: '隔离主题' } })).json();
  const inbox = await (await request.post(`${apiUrl}/api/tasks`, { data: { title: '收集箱专属' } })).json();
  const tagged = await (await request.post(`${apiUrl}/api/tags`, { data: { name: '跨类标签' } })).json();
  await request.patch(`${apiUrl}/api/tasks/${inbox.data.id}`, { data: { tagIds: [tagged.data.id] } });
  const topicTask = await (await request.post(`${apiUrl}/api/tasks`, { data: { topicId: topic.data.id, title: '主题专属' } })).json();

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/board');
  const topicRow = page.getByTestId(`task-row-${topicTask.data.id}`);
  await expect(topicRow).toBeVisible();
  await expect(topicRow.locator('.task-place-chip')).toHaveCount(0);
  await expect(topicRow.getByText('隔离主题', { exact: true })).toHaveCount(0);

  await page.goto('/#/search');
  const inboxRow = page.getByTestId(`task-row-${inbox.data.id}`);
  await expect(inboxRow.locator('.task-place-chip')).toHaveText('收集箱');
  await expect(inboxRow.getByText('#跨类标签', { exact: true })).toBeVisible();
});

test('已完成任务收在底部，今天不画出空分组', async ({ page, request }) => {
  const open = await (await request.post(`${apiUrl}/api/tasks`, { data: { title: '还要做' } })).json();
  const done = await (await request.post(`${apiUrl}/api/tasks`, { data: { title: '已经做完' } })).json();
  expect((await request.patch(`${apiUrl}/api/tasks/${done.data.id}`, { data: { status: 'done' } })).ok()).toBe(true);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await expect(page.getByTestId(`task-row-${open.data.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-row-${done.data.id}`)).toBeHidden();
  await page.getByText('已完成 · 1', { exact: true }).click();
  await expect(page.getByTestId(`task-row-${done.data.id}`)).toBeVisible();
  await page.getByTestId(`task-row-${done.data.id}`).getByRole('checkbox', { name: '重开任务：已经做完' }).click();
  await expect(page.getByTestId(`task-row-${done.data.id}`)).toBeVisible();
  await expect(page.getByText('已完成 · 1', { exact: true })).toBeHidden();

  await page.goto('/#/today');
  await expect(page.getByRole('heading', { name: /^逾期/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^今天 ·/ })).toHaveCount(0);
  await expect(page.getByText('暂无任务', { exact: true })).toBeVisible();
});

test('打开聊天后未保存的标题还在', async ({ page, request }) => {
  const created = await (await request.post(`${apiUrl}/api/tasks`, { data: { title: '原来的标题' } })).json();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${created.data.id}`).getByRole('button', { name: '原来的标题', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await detail.getByLabel('任务标题', { exact: true }).fill('还没保存的标题');
  await page.getByRole('button', { name: '打开聊天', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '保存未完成的编辑？' })).toHaveCount(0);
  await expect(detail).toBeHidden();
  await expect(page.getByRole('button', { name: '关闭聊天', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭聊天', exact: true }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue('还没保存的标题');
});
