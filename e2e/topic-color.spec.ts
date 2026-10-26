import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
async function data(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

test.beforeEach(resetE2eDatabase);
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('清单颜色留在方块上，探索只多一枚标签', async ({ page, request }) => {
  await page.goto('/#/topics');
  await page.getByRole('button', { name: '新建清单', exact: true }).first().click();
  const create = page.getByRole('dialog', { name: '新建清单', exact: true });
  await create.getByLabel('清单名称', { exact: true }).fill('颜色样本');
  await create.getByRole('group', { name: '清单颜色' }).getByRole('button', { name: '蓝', exact: true }).click();
  await create.getByRole('button', { name: '保存清单', exact: true }).click();
  await expect(create).toBeHidden();

  const topic = (await data(await request.get(`${apiUrl}/api/topics`))).find((item: { name: string }) => item.name === '颜色样本');
  expect(topic.color).toBe('blue');
  const desktop = (page.viewportSize()?.width ?? 0) >= 1024;
  if (desktop) await expect(page.locator('.sidebar-list-mark[data-color="blue"]')).toBeVisible();
  await page.goto('/#/topics');
  await expect(page.locator('.list-color-dot[data-color="blue"]')).toBeVisible();

  await page.getByRole('button', { name: '编辑清单：颜色样本', exact: true }).first().click();
  const edit = page.getByRole('dialog', { name: '编辑清单', exact: true });
  await expect(edit.getByRole('button', { name: '蓝', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await edit.getByText('探索属性与目标', { exact: true }).click();
  await edit.getByLabel('当前仍在探索', { exact: true }).check();
  await edit.getByRole('button', { name: '保存清单', exact: true }).click();
  await expect(edit).toBeHidden();

  if (desktop) {
    await expect(page.locator('.sidebar-list-mark[data-color="blue"]')).toBeVisible();
    await expect(page.locator('[aria-label="清单"] .sidebar-explore-tag')).toHaveText('探索');
  }
  await page.goto('/#/topics');
  await expect(page.locator('.list-color-dot[data-color="blue"]')).toBeVisible();
  await expect(page.locator('.list-color-dot[data-color="blue"]').locator('xpath=..')).toContainText('探索');
  await expect(page.locator('.sidebar-list-mark.is-explore, .glass-topic-badge')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.list-color-dot[data-color="blue"]')).toBeVisible();
  await expect(page.locator('.sidebar-explore-tag', { hasText: '探索' }).first()).toBeVisible();

  await page.getByRole('button', { name: '编辑清单：颜色样本', exact: true }).first().click();
  const reopened = page.getByRole('dialog', { name: '编辑清单', exact: true });
  await expect(reopened.getByRole('button', { name: '蓝', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await reopened.getByRole('button', { name: '取消', exact: true }).click();

  const task = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '颜色样本任务', topicId: topic.id } }));
  await page.goto('/#/search');
  const row = page.getByTestId(`task-row-${task.id}`);
  await expect(row.getByText('颜色样本', { exact: true })).toBeVisible();
  await expect(row.locator('.task-place-chip').filter({ visible: true })).not.toHaveAttribute('data-color', /.+/);
});
