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

test('旧资料入口进入资料库，记忆和简报仍可从资料库打开', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/knowledge');
  await expect(page).toHaveURL(/#\/library$/);
  await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '材料', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await expect(page).toHaveURL(/#\/knowledge\/memories$/);
  await expect(page.getByRole('button', { name: '记录记忆', exact: true })).toBeVisible();

  await page.goto('/#/library');
  await page.getByRole('button', { name: '当前简报', exact: true }).click();
  await expect(page).toHaveURL(/#\/knowledge\/brief$/);
  await expect(page.getByLabel('简报固定说明', { exact: true })).toBeVisible();
});

test('一份资料可以同时关联多个任务，预览留在栏内而不是居中弹窗', async ({ page, request }) => {
  const topicA = await request.post(`${base}/api/topics`, { data: { name: '清单甲' } });
  const topicB = await request.post(`${base}/api/topics`, { data: { name: '清单乙' } });
  expect(topicA.ok() && topicB.ok()).toBe(true);
  const taskA = await request.post(`${base}/api/tasks`, { data: { title: '跨清单任务甲', topicId: (await topicA.json()).data.id } });
  const taskB = await request.post(`${base}/api/tasks`, { data: { title: '跨清单任务乙', topicId: (await topicB.json()).data.id } });
  expect(taskA.ok() && taskB.ok()).toBe(true);
  const material = await command(request, [{ kind: 'material.create', input: { topicId: null, kind: 'text', title: '多任务资料', content: '同一份资料关联两件任务' } }]) as { id: string };

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/#/library');
  await page.getByTestId(`library-row-${material.id}`).click();
  const preview = page.getByTestId('library-preview');
  await expect(preview).toBeVisible();
  const box = (await preview.boundingBox())!;
  expect(box.width).toBeLessThan(500);
  await expect(page.getByRole('combobox', { name: '关联任务', exact: true })).toHaveCount(0);

  await preview.getByLabel('添加关联任务', { exact: true }).selectOption({ label: '跨清单任务甲' });
  await preview.getByRole('button', { name: '关联', exact: true }).click();
  await expect(preview.getByRole('button', { name: '跨清单任务甲', exact: true })).toBeVisible();
  await preview.getByLabel('添加关联任务', { exact: true }).selectOption({ label: '跨清单任务乙' });
  await preview.getByRole('button', { name: '关联', exact: true }).click();
  await expect(preview.getByRole('button', { name: '跨清单任务甲', exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: '跨清单任务乙', exact: true })).toBeVisible();
  await expect(page.getByTestId(`library-row-${material.id}`).locator('td').nth(3)).toHaveText('2');
});
