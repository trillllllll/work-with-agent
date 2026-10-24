import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL!;
test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());

for (const queued of [false, true]) test(`text save ${queued ? 'in flight' : 'acknowledged'} then immediate completion works without event refresh`, async ({ page, request }) => {
  const task = (await (await request.post(`${api}/api/tasks`, { data: { title: '保存前的任务' } })).json()).data;
  // Reproduce the real refresh gap deterministically, rather than waiting for its 300ms timer.
  await page.route('**/api/v1/events', route => route.abort());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const intercepted = new Promise<void>(resolve => { reached = resolve; });
  const revisions: number[] = [];
  await page.route(`**/api/tasks/${task.id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const body = route.request().postDataJSON();
    if (body.title) {
      const response = await route.fetch();
      reached();
      await gate;
      return route.fulfill({ response });
    }
    revisions.push(body.expectedRevision);
    return route.continue();
  });
  await page.goto('/#/inbox');
  const row = page.getByTestId(`task-row-${task.id}`);
  await row.getByRole('button', { name: task.title, exact: true }).click();
  await page.getByRole('textbox', { name: '任务标题', exact: true }).fill('保存后立即完成');
  await intercepted;
  if (!queued) {
    release();
    await expect(row.locator('.task-inline-title')).toHaveText('保存后立即完成');
  }
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await row.getByRole('checkbox').click();
  if (queued) release();
  await expect.poll(async () => (await (await request.get(`${api}/api/tasks/${task.id}`)).json()).data.status).toBe('done');
  expect(revisions).toEqual([2]);
  const saved = (await (await request.get(`${api}/api/tasks/${task.id}`)).json()).data;
  expect(saved.title).toBe('保存后立即完成');
  await expect(page.getByText('对象已有后续修改，请重新读取并确认', { exact: true })).toHaveCount(0);
});

test('a real remote write after autosave still conflicts instead of being overwritten', async ({ page, request }) => {
  const task = (await (await request.post(`${api}/api/tasks`, { data: { title: '并发修改保护' } })).json()).data;
  await page.route('**/api/v1/events', route => route.abort());
  await page.goto('/#/inbox');
  const row = page.getByTestId(`task-row-${task.id}`);
  await row.getByRole('button', { name: task.title, exact: true }).click();
  await page.getByRole('textbox', { name: '任务标题', exact: true }).fill('本窗口已保存');
  await expect(row.locator('.task-inline-title')).toHaveText('本窗口已保存');
  const remote = await request.patch(`${api}/api/tasks/${task.id}`, { data: { priority: 'high' } });
  expect(remote.ok()).toBe(true);
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  const conflict = page.waitForResponse(response => response.url().endsWith(`/api/tasks/${task.id}`) && response.request().method() === 'PATCH');
  await row.getByRole('checkbox').click();
  expect((await conflict).status()).toBe(409);
  const saved = (await (await request.get(`${api}/api/tasks/${task.id}`)).json()).data;
  expect(saved.status).toBe('todo');
  expect(saved.priority).toBe('high');
  expect(saved.title).toBe('本窗口已保存');
});
