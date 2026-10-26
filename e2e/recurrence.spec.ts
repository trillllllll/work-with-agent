import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
async function data(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}
async function tasks(request: APIRequestContext) {
  return data(await request.get(`${apiUrl}/api/tasks?status=all`));
}
async function createTask(request: APIRequestContext, body: Record<string, unknown>) {
  return data(await request.post(`${apiUrl}/api/tasks`, { data: body }));
}
async function completeTask(request: APIRequestContext, id: string) {
  const first = await request.patch(`${apiUrl}/api/tasks/${id}`, { data: { status: 'done' } });
  if (first.ok()) return (await first.json()).data;
  const payload = await first.json();
  expect(payload.code).toBe('PREVIEW_REQUIRED');
  const preview = await request.post(`${apiUrl}/api/v1/commands/preview`, { data: { commands: payload.details.commands } });
  expect(preview.ok(), await preview.text()).toBe(true);
  const token = (await preview.json()).data.previewToken as string;
  const retry = await request.patch(`${apiUrl}/api/tasks/${id}`, { data: { status: 'done', previewToken: token } });
  expect(retry.ok(), await retry.text()).toBe(true);
  return (await retry.json()).data;
}

test.beforeEach(resetE2eDatabase);
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test.describe('重复任务', () => {
  test('完成后按计划日期生成下一次，列表出现重复标识', async ({ page, request }) => {
    const origin = await createTask(request, { title: '每周复盘', dueDate: '2026-10-20', recurrenceRule: '{"unit":"week","step":1}' });
    await page.goto('/#/inbox');
    const row = page.getByTestId(`task-row-${origin.id}`);
    await expect(row).toBeVisible();
    await expect(row.getByLabel('重复任务：每周')).toBeVisible();
    await row.getByRole('checkbox', { name: '完成任务：每周复盘', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '确认连带修改', exact: true });
    await expect(preview).toBeVisible();
    await expect(preview.getByText('这是重复任务，完成后会按计划日期生成下一次')).toBeVisible();
    await preview.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect(preview).toBeHidden();
    await expect.poll(async () => (await tasks(request)).length).toBe(2);
    const next = (await tasks(request)).find((value: any) => value.id !== origin.id);
    expect(next).toMatchObject({ title: '每周复盘', status: 'todo', dueDate: '2026-10-27', recurrenceRule: '{"unit":"week","step":1}' });
    await expect(page.getByTestId(`task-row-${next.id}`)).toBeVisible();
    await expect(page.getByTestId(`task-row-${next.id}`).getByLabel('重复任务：每周')).toBeVisible();
  });

  test('任务详情可设置并清除重复', async ({ page, request }) => {
    const origin = await createTask(request, { title: '月度汇总' });
    await page.goto('/#/inbox');
    await page.getByTestId(`task-row-${origin.id}`).click();
    const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
    await detail.getByRole('button', { name: '重复', exact: true }).click();
    await page.getByRole('button', { name: '每月', exact: true }).click();
    await expect.poll(async () => (await tasks(request))[0].recurrenceRule).toBe('{"unit":"month","step":1}');
    await detail.getByRole('button', { name: '重复', exact: true }).click();
    await page.getByRole('button', { name: '不重复', exact: true }).click();
    await expect.poll(async () => (await tasks(request))[0].recurrenceRule).toBe('');
  });
});
