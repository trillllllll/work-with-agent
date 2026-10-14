import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = 'http://127.0.0.1:3015';

async function command(request: APIRequestContext, commands: unknown[]) {
  const response = await request.post(`${base}/api/v1/commands`, { data: { requestId: crypto.randomUUID(), commands } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data.results[0];
}

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
  });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('工作上下文和资料库分别打开，记忆和当前进展仍可从资料库进入', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/knowledge');
  await expect(page.getByRole('heading', { name: '工作上下文', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '当前进展', exact: true })).toHaveAttribute('aria-selected', 'true');

  await page.goto('/#/library');
  await expect(page).toHaveURL(/#\/library$/);
  await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '材料', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await expect(page).toHaveURL(/#\/knowledge\/memories\?topicId=/);
  await expect(page.getByRole('button', { name: '手动记录', exact: true })).toBeVisible();

  await page.goto('/#/library');
  await page.getByRole('button', { name: '当前进展', exact: true }).click();
  await expect(page).toHaveURL(/#\/knowledge\/brief\?topicId=/);
  await expect(page.getByLabel('简报固定说明', { exact: true })).toBeVisible();
});

test('一份资料可以同时关联多个任务，预览留在栏内而不是居中弹窗', async ({ page, request }) => {
  const topicA = await request.post(`${base}/api/topics`, { data: { name: '清单甲' } });
  const topicB = await request.post(`${base}/api/topics`, { data: { name: '清单乙' } });
  expect(topicA.ok() && topicB.ok()).toBe(true);
  const taskA = await request.post(`${base}/api/tasks`, { data: { title: '跨清单任务甲', topicId: (await topicA.json()).data.id } });
  const taskB = await request.post(`${base}/api/tasks`, { data: { title: '跨清单任务乙', topicId: (await topicB.json()).data.id } });
  expect(taskA.ok() && taskB.ok()).toBe(true);
  const taskAId = (await taskA.json()).data.id as string;
  const taskBId = (await taskB.json()).data.id as string;
  const material = await command(request, [{ kind: 'material.create', input: { topicId: null, kind: 'text', title: '多任务资料', content: '同一份资料关联两件任务' } }]) as { id: string };

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/#/library');
  await page.getByTestId(`library-row-${material.id}`).click();
  const preview = page.getByTestId('library-preview');
  await expect(preview).toBeVisible();
  const box = (await preview.boundingBox())!;
  expect(box.width).toBeLessThan(500);
  await expect(page.getByRole('combobox', { name: '关联任务', exact: true })).toHaveCount(0);

  await preview.getByRole('textbox', { name: '搜索任务', exact: true }).fill('跨清单任务甲');
  const rowA = preview.getByTestId(`task-picker-row-${taskAId}`);
  await expect(rowA).toBeVisible();
  await expect(rowA).toContainText('清单甲');
  await expect(rowA).toContainText('待办');
  await expect(preview.getByTestId(`task-picker-row-${taskBId}`)).toHaveCount(0);
  await preview.getByRole('checkbox', { name: '选择 跨清单任务甲', exact: true }).check();
  await preview.getByRole('button', { name: '关联', exact: true }).click();
  await expect(preview.getByRole('button', { name: '跨清单任务甲', exact: true })).toBeVisible();
  await preview.getByRole('textbox', { name: '搜索任务', exact: true }).fill('跨清单任务乙');
  const rowB = preview.getByTestId(`task-picker-row-${taskBId}`);
  await expect(rowB).toContainText('清单乙');
  await expect(rowB).toContainText('待办');
  await preview.getByRole('checkbox', { name: '选择 跨清单任务乙', exact: true }).check();
  await preview.getByRole('button', { name: '关联', exact: true }).click();
  await expect(preview.getByRole('button', { name: '跨清单任务甲', exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: '跨清单任务乙', exact: true })).toBeVisible();
  await expect(page.getByTestId(`library-row-${material.id}`).locator('td').nth(3)).toHaveText('2');
});
