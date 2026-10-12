import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = 'http://127.0.0.1:3015';

async function command(request: APIRequestContext, commands: unknown[]) {
  const response = await request.post(`${base}/api/v1/commands`, { data: { requestId: crypto.randomUUID(), commands } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data.results[0];
}

async function createMaterial(request: APIRequestContext, title: string) {
  return command(request, [{ kind: 'material.create', input: { topicId: null, kind: 'text', title, content: `${title}的正文` } }]) as Promise<{ id: string; revision: number }>;
}

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
  });
});
test.afterAll(() => e2eDatabase.$disconnect());

async function openTask(page: Page, taskId: string) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${taskId}`).click();
  await expect(page.getByTestId('task-materials')).toBeVisible();
}

test('任务详情直接显示资料区，引用可多选且与关联同时出现', async ({ page, request }) => {
  const created = await request.post(`${base}/api/tasks`, { data: { title: '需要资料的任务' } });
  expect(created.ok(), await created.text()).toBe(true);
  const taskId = (await created.json()).data.id as string;
  const first = await createMaterial(request, '可引用甲');
  const second = await createMaterial(request, '可引用乙');
  await openTask(page, taskId);
  await expect(page.getByRole('menuitem', { name: '关联资料', exact: true })).toHaveCount(0);
  await expect(page.getByText('拖入文件，或引用已有资料', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '引用已有资料', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '引用已有资料', exact: true });
  const firstBox = picker.getByRole('checkbox', { name: '可引用甲', exact: true });
  const secondBox = picker.getByRole('checkbox', { name: '可引用乙', exact: true });
  await firstBox.check();
  await secondBox.check();
  await expect(firstBox).toBeChecked();
  await expect(secondBox).toBeChecked();
  await picker.getByRole('button', { name: '插入引用', exact: true }).click();

  await expect(page.getByTestId(`material-reference-${first.id}`)).toBeVisible();
  await expect(page.getByTestId(`material-reference-${second.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-material-${first.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-material-${second.id}`)).toBeVisible();
  await expect(page.getByTestId('task-materials')).toContainText('资料 · 2');

  await page.getByTestId(`task-material-${first.id}`).getByRole('button', { name: '解除关联', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '解除关联', exact: true });
  await expect(confirm).toContainText('正文仍引用');
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByTestId(`material-reference-${first.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-material-${first.id}`)).toBeVisible();

  const description = page.getByLabel('详情', { exact: true });
  const descriptionBox = await description.boundingBox();
  await description.click({ position: { x: Math.max(24, (descriptionBox?.width ?? 240) - 12), y: 18 } });
  await page.keyboard.press('Meta+A');
  await page.keyboard.insertText('引用已经从正文删除');
  await page.getByLabel('任务标题', { exact: true }).click();
  await expect(page.getByTestId(`material-reference-${first.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`material-reference-${second.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`task-material-${first.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-material-${second.id}`)).toBeVisible();
});
