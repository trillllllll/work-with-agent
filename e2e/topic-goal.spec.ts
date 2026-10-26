import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
async function data(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

test.beforeEach(resetE2eDatabase);
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test.describe('清单长期目标', () => {
  test('编辑目标与截止日，清单页头部显示且逾期标红，侧栏有目标标记', async ({ page, request }) => {
    await page.goto('/#/topics');
    await page.getByRole('button', { name: '新建清单', exact: true }).first().click();
    const create = page.getByRole('dialog', { name: '新建清单', exact: true });
    await create.getByLabel('清单名称', { exact: true }).fill('年度整理');
    await create.getByRole('button', { name: '保存清单', exact: true }).click();
    await expect(create).toBeHidden();
    const topic = (await data(await request.get(`${apiUrl}/api/topics`)))[0];

    // 编辑目标与截止日（目标字段在“探索属性与目标”折叠区内）
    await page.getByRole('main').getByRole('button', { name: '编辑清单：年度整理', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑清单', exact: true });
    await edit.getByText('探索属性与目标', { exact: true }).click();
    await edit.getByLabel('目标', { exact: true }).fill('把积累的资料全部归档');
    await edit.getByLabel('目标截止日', { exact: true }).fill('2026-12-31');
    await edit.getByRole('button', { name: '保存清单', exact: true }).click();
    await expect(edit).toBeHidden();

    // 清单页头部显示目标与截止日
    await page.goto(`#/board/${topic.id}`);
    await expect(page.getByRole('heading', { name: '年度整理', exact: true })).toBeVisible();
    await expect(page.getByText('把积累的资料全部归档')).toBeVisible();
    await expect(page.getByText(/目标截止 12月31日/)).toBeVisible();

    // 侧栏标记
    await expect(page.locator('.sidebar-nav').getByText('目标', { exact: true })).toBeVisible();

    // 改成过期日期后显示逾期
    const revised = await data(await request.get(`${apiUrl}/api/topics`));
    await request.patch(`${apiUrl}/api/topics/${topic.id}`, { data: { goalDueDate: '2020-01-01', expectedRevision: revised.revision } });
    await page.reload();
    await expect(page.getByText(/目标截止.*已逾期/)).toBeVisible();
  });
});
