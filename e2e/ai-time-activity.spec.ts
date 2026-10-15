import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = 'http://127.0.0.1:3015';
const composer = '例如：创建任务：整理 API 文档';

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`${api}${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

async function openChat(page: Page) {
  if (!(await page.getByPlaceholder(composer).isVisible())) await page.getByRole('button', { name: '打开聊天', exact: true }).click();
}

async function ask(page: Page, message: string) {
  await openChat(page);
  await page.getByPlaceholder(composer).fill(message);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  const saved = await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(() => {
    localStorage.setItem('agent-studio.theme', 'light');
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
  });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('读取当前时间后回答本地日期，不生成审批', async ({ page, isMobile }) => {
  test.skip(Boolean(isMobile), '时间读取在桌面视口验收');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const expected = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()));
  await ask(page, '读取当前时间');
  await expect(page.getByText(`本地日期 ${expected}。`, { exact: true })).toBeVisible();
  await expect(page.getByTestId('approval-card')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('读取任务动态时说明最近 30 天，并把接口创建者显示为你', async ({ page, isMobile, request }) => {
  test.skip(Boolean(isMobile), '任务动态在桌面视口验收');
  const task = await post(request, '/api/tasks', { title: '动态样本' }) as { id: string };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await ask(page, `读取任务动态 taskId=${task.id}`);
  await expect(page.getByText(/最近 30 天的动态里，记录到的操作者是你。这不代表从未发生过更早的修改。/)).toBeVisible();
  await expect(page.getByTestId('approval-card')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await openChat(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
