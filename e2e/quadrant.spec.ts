import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = 'http://127.0.0.1:3015';

async function data(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

test.beforeEach(resetE2eDatabase);
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('四象限复用优先级，并支持全局、清单和拖动保存', async ({ page, request }) => {
  const list = await data(await request.post(`${apiUrl}/api/topics`, { data: { name: '四象限清单' } }));
  const high = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '立即处理', priority: 'high' } }));
  await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '计划安排', priority: 'medium' } }));
  await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '快速处理', priority: 'low' } }));
  await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '减少删除', priority: 'none' } }));
  const completed = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '已完成任务', priority: 'medium' } }));
  await data(await request.patch(`${apiUrl}/api/tasks/${completed.id}`, { data: { status: 'done' } }));

  await page.goto('/#/quadrant');
  await expect(page.getByRole('heading', { name: '四象限', exact: true })).toBeVisible();
  for (const name of ['重要且紧急', '重要但不紧急', '不重要但紧急', '不重要且不紧急']) await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByTestId(`task-card-${high.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-card-${completed.id}`)).toBeHidden();
  await page.getByRole('checkbox', { name: '显示已完成', exact: true }).check();
  await page.getByText('已完成 · 1', { exact: true }).click();
  await expect(page.getByTestId(`task-card-${completed.id}`)).toBeVisible();

  await page.goto('/#/board');
  await expect(page.getByRole('heading', { name: '四象限清单', exact: true })).toBeVisible();
  const quadrantToggle = page.getByRole('main').getByRole('button', { name: '四象限', exact: true });
  await quadrantToggle.click();
  await expect(page.getByTestId(`task-card-${high.id}`)).toBeVisible();
  const source = page.getByTestId(`task-card-${high.id}`);
  const target = page.getByRole('region', { name: '重要但不紧急，计划安排', exact: true });
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('象限拖动区域没有布局');
  const x = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x + to.width / 2, y: to.y + to.height / 2, button: 'left', buttons: 0, clickCount: 1 });
  await expect.poll(async () => (await data(await request.get(`${apiUrl}/api/tasks/${high.id}`))).priority).toBe('medium');
  await page.reload();
  await page.getByRole('main').getByRole('button', { name: '四象限', exact: true }).click();
  const mediumRegion = page.getByRole('region', { name: '重要但不紧急，计划安排', exact: true });
  await expect(mediumRegion.getByTestId(`task-card-${high.id}`)).toBeVisible();
  const lowRegion = page.getByRole('region', { name: '不重要但紧急，快速处理或委派', exact: true });
  await page.route(`**/api/tasks/${high.id}`, async (route) => {
    if (route.request().method() === 'PATCH') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ data: null, error: '象限保存失败' }) });
    else await route.continue();
  });
  const failedSource = mediumRegion.getByTestId(`task-card-${high.id}`);
  const failedFrom = await failedSource.boundingBox();
  const failedTo = await lowRegion.boundingBox();
  if (!failedFrom || !failedTo) throw new Error('象限失败回滚区域没有布局');
  await page.mouse.move(failedFrom.x + failedFrom.width / 2, failedFrom.y + failedFrom.height / 2);
  await page.mouse.down();
  await page.mouse.move(failedTo.x + failedTo.width / 2, failedTo.y + failedTo.height / 2, { steps: 12 });
  const failedSession = await page.context().newCDPSession(page);
  await failedSession.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: failedTo.x + failedTo.width / 2, y: failedTo.y + failedTo.height / 2, button: 'left', buttons: 0, clickCount: 1 });
  await expect(page.getByText('象限保存失败', { exact: true }).first()).toBeVisible();
  await expect(mediumRegion.getByTestId(`task-card-${high.id}`)).toBeVisible();
  await page.unroute(`**/api/tasks/${high.id}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});
