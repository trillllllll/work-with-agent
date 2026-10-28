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
async function reminderSettings(request: APIRequestContext) {
  return data(await request.get(`${apiUrl}/api/settings/reminders`));
}

test.beforeEach(resetE2eDatabase);
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test.describe('任务提醒', () => {
  test('任务详情可选择提醒档位并持久化', async ({ page, request }) => {
    const origin = await createTask(request, { title: '写周报', scheduledStart: '2026-03-05T15:00', dueDate: '2026-03-05' });
    await page.goto('/#/inbox');
    await page.getByTestId(`task-row-${origin.id}`).click();
    const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
    await detail.getByRole('button', { name: '提醒', exact: true }).click();
    await page.getByRole('button', { name: '提前 30 分钟', exact: true }).click();
    await expect.poll(async () => (await tasks(request))[0].reminderMinutesBefore).toBe(30);
    await detail.getByRole('button', { name: '提醒', exact: true }).click();
    await page.getByRole('button', { name: '不提醒', exact: true }).click();
    await expect.poll(async () => (await tasks(request))[0].reminderMinutesBefore).toBe(-1);
    await detail.getByRole('button', { name: '提醒', exact: true }).click();
    await page.getByRole('button', { name: '准时', exact: true }).click();
    await expect.poll(async () => (await tasks(request))[0].reminderMinutesBefore).toBe(0);
    // 刷新后从服务端数据重建详情，档位仍在。
    await page.reload();
    await page.getByTestId(`task-row-${origin.id}`).click();
    await expect(page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('button', { name: '提醒', exact: true })).toContainText('准时');
  });

  test('设置页修改默认提前量、全天时刻并保存', async ({ page, request }) => {
    await page.goto('/#/settings/ui');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('默认提前量')).toBeVisible();
    await expect(dialog.getByLabel('全天任务提醒时刻')).toHaveValue('09:00');
    await dialog.getByLabel('默认提前量').selectOption({ label: '提前 30 分钟' });
    await dialog.getByLabel('全天任务提醒时刻').fill('08:30');
    await dialog.getByRole('button', { name: '保存提醒设置' }).click();
    await expect.poll(async () => (await reminderSettings(request))).toMatchObject({ leadMinutes: 30, allDayTime: '08:30' });
    await expect(page.locator('[data-sonner-toast]').getByText('提醒设置已保存')).toBeVisible();
  });

  test('提醒设置区展示本设备推送卡片', async ({ page }) => {
    await page.goto('/#/settings/ui');
    const dialog = page.getByRole('dialog');
    const card = dialog.getByTestId('push-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('本设备推送');
    await expect(card.getByRole('button', { name: '开启推送' })).toBeVisible();
  });

  test('到点提醒经事件流出现应用内提示', async ({ page, request }) => {
    test.setTimeout(120_000);
    // 先打开页面让 SSE 连上，再创建“提醒时刻就是现在”的任务：提前量等于开始前时长。
    await page.goto('/#/today');
    await expect(page.getByPlaceholder('下一步要做什么？')).toBeVisible();
    const start = new Date(Date.now() + 60 * 60_000);
    const pad = (value: number) => String(value).padStart(2, '0');
    const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    await createTask(request, { title: '推送演练', scheduledStart: `${date}T${pad(start.getHours())}:${pad(start.getMinutes())}`, dueDate: date, reminderMinutesBefore: 60 });
    // 服务端调度每 30 秒一跳；到点后事件经 /api/v1/events 到达页面。
    await expect(page.locator('[data-sonner-toast]').getByText(/推送演练 将于 \d{2}:\d{2} 开始/)).toBeVisible({ timeout: 60_000 });
  });
});
