import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = 'http://127.0.0.1:3015';

async function data<T>(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as T;
}

test.beforeEach(resetE2eDatabase);
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('清单页只留标题、上下文、录入和任务', async ({ page, request }) => {
  const topic = await data<{ id: string; revision: number }>(await request.post(`${apiUrl}/api/topics`, { data: { name: '布局清单', goal: '把下一步放在最上面' } }));
  await request.post(`${apiUrl}/api/tasks`, { data: { topicId: topic.id, title: '先做这一条' } });
  const brief = await data<{ revision: number }>(await request.get(`${apiUrl}/api/v1/knowledge/brief?topicId=${topic.id}`));
  expect((await request.put(`${apiUrl}/api/v1/knowledge/brief`, { data: { topicId: topic.id, expectedVersion: brief.revision, manualNotes: '固定说明第一行\n固定说明第二行\n固定说明第三行' } })).ok()).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/board');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: '布局清单', exact: true })).toBeVisible();
  await expect(main.getByText('把下一步放在最上面', { exact: true })).toBeVisible();
  await expect(main.getByText('固定说明第一行', { exact: false })).toBeVisible();
  await expect(main.getByRole('button', { name: '项目资料', exact: true })).toBeVisible();
  await expect(main.getByText('资料、记忆与当前简报')).toHaveCount(0);
  await expect(main.getByText('探索与成果')).toHaveCount(0);
  await expect(main.getByRole('button', { name: '新建任务', exact: true })).toHaveCount(0);
  await expect(main.getByRole('textbox', { name: '搜索任务', exact: true })).toHaveCount(0);
  const capture = main.getByRole('textbox', { name: '任务名称', exact: true });
  await expect(capture).toBeVisible();
  await capture.fill('从第一行录入');
  await capture.press('Enter');
  await expect(main.getByRole('button', { name: '从第一行录入', exact: true })).toBeVisible();

  await main.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索任务', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: '筛选完成状态', exact: true }).selectOption('open');
  await expect(main.getByText('未完成', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await main.getByRole('button', { name: '先做这一条', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '任务详情', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();

  await main.getByRole('button', { name: '项目资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目资料', exact: true })).toBeVisible();
  await expect(page.getByLabel('资料所属清单')).toHaveValue(topic.id);

  await page.goto('/#/inbox');
  await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '搜索任务', exact: true })).toHaveCount(0);
  await page.goto('/#/today');
  await expect(page.getByRole('textbox', { name: '搜索任务', exact: true })).toHaveCount(0);
  await page.goto('/#/tags');
  await expect(page.getByRole('textbox', { name: '搜索任务', exact: true })).toHaveCount(0);
  await page.goto('/#/search');
  await expect(page.getByRole('textbox', { name: '搜索任务', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/#/board');
  await expect(main.getByRole('heading', { name: '布局清单', exact: true })).toBeVisible();
  await expect(main.getByText('把下一步放在最上面', { exact: true })).toBeVisible();
  await expect(main.getByRole('textbox', { name: '任务名称', exact: true })).toBeVisible();
  await main.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索任务', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '筛选完成状态', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});
