import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const composer = '例如：创建任务：整理 API 文档';
const surfaces = [
  { width: 1280, height: 800, theme: 'light' },
  { width: 1280, height: 800, theme: 'dark' },
  { width: 390, height: 844, theme: 'light' },
  { width: 390, height: 844, theme: 'dark' },
] as const;

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

async function prepare(page: Page, request: APIRequestContext, surface: (typeof surfaces)[number]) {
  await resetE2eDatabase();
  const saved = await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript((theme) => {
    localStorage.setItem('agent-studio.theme', theme);
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
  }, surface.theme);
  await page.setViewportSize({ width: surface.width, height: surface.height });
}

test.afterAll(() => e2eDatabase.$disconnect());

for (const surface of surfaces) {
  test(`重新预览在 ${surface.width} ${surface.theme} 保留新旧两张卡`, async ({ page, isMobile, request }) => {
    test.skip(Boolean(isMobile), '视口在用例内设置');
    test.setTimeout(60_000);
    await prepare(page, request, surface);
    const task = await post(request, '/api/tasks', { title: '修复样本' }) as { id: string; revision: number };
    await page.goto('/#/inbox');
    await expect(page.locator('html')).toHaveClass(surface.theme === 'dark' ? /dark/ : /light/);
    await ask(page, '修复预览标题');
    const cards = page.getByTestId('approval-card');
    await expect(cards).toHaveCount(1);
    await request.patch(`${api}/api/tasks/${task.id}`, { data: { title: '外部先改了', expectedRevision: task.revision } });
    await cards.getByRole('button', { name: '确认修改', exact: true }).click();
    await expect(cards).toHaveAttribute('data-state', 'failed');
    await page.route('**/api/agent/approvals/*/repreview', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '重新生成失败', code: 'REVIEW_REQUIRED' }) }));
    await cards.getByRole('button', { name: '重新生成预览', exact: true }).click();
    await expect(cards.getByRole('alert').filter({ hasText: '重新生成失败' })).toBeVisible();
    await expect(cards.getByRole('button', { name: '重新生成预览', exact: true })).toBeEnabled();
    await expect(cards).toHaveCount(1);
    await page.unroute('**/api/agent/approvals/*/repreview');
    await cards.getByRole('button', { name: '重新生成预览', exact: true }).click();
    await expect(cards).toHaveCount(2);
    await expect(page.locator('[data-state="pending"]').getByRole('button', { name: '确认修改', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '查看新方案', exact: true }).click();
    await expect(page.locator('[data-state="pending"] [data-approval-id] h2, [data-state="pending"] h2').first()).toBeFocused();
    await page.reload();
    await openChat(page);
    await expect(page.getByTestId('approval-card')).toHaveCount(2);
    await expect(page.locator('[data-state="pending"]').getByRole('button', { name: '确认修改', exact: true })).toBeEnabled();
  });

  test(`调整方案在 ${surface.width} ${surface.theme} 带上引用并保持失败前的待确认`, async ({ page, isMobile, request }) => {
    test.skip(Boolean(isMobile), '视口在用例内设置');
    test.setTimeout(60_000);
    await prepare(page, request, surface);
    await post(request, '/api/tasks', { title: '调整样本' });
    await page.goto('/#/inbox');
    await ask(page, '请生成调整样本');
    const card = page.getByTestId('approval-card');
    await expect(card).toHaveCount(1);
    const adjust = card.getByRole('button', { name: '调整方案', exact: true });
    await adjust.focus();
    await page.keyboard.press('Enter');
    const input = page.getByPlaceholder(composer);
    await expect(input).toBeFocused();
    await expect(page.getByText('正在调整：修改 1 个任务')).toBeVisible();
    await input.fill('调整时生成失败');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('正在调整：修改 1 个任务')).toBeVisible();
    await expect(input).toHaveValue('调整时生成失败');
    await expect(card.getByRole('button', { name: '确认修改', exact: true })).toBeEnabled();
    await input.fill('请把方案改短');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('正在调整：')).toHaveCount(0);
    await expect(page.getByTestId('approval-card')).toHaveCount(2);
    await expect(page.locator('[data-state="superseded"]')).toHaveCount(1);
    await expect(page.locator('[data-state="pending"]').getByRole('button', { name: '确认修改', exact: true })).toBeEnabled();
  });

  test(`继续请求在 ${surface.width} ${surface.theme} 显示后续回答`, async ({ page, isMobile, request }) => {
    test.skip(Boolean(isMobile), '视口在用例内设置');
    test.setTimeout(60_000);
    await prepare(page, request, surface);
    await page.goto('/#/inbox');
    await ask(page, '继续处理到上限');
    await expect(page.getByRole('button', { name: '继续此请求', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '继续此请求', exact: true }).click();
    await expect(page.getByText('后续回答已经完成')).toBeVisible();
  });
}

test('待确认页的调整打开所属会话', async ({ page, isMobile, request }) => {
  test.skip(Boolean(isMobile), '视口在用例内设置');
  test.setTimeout(60_000);
  await prepare(page, request, surfaces[0]);
  await post(request, '/api/tasks', { title: '调整样本' });
  await page.goto('/#/inbox');
  await ask(page, '请生成调整样本');
  await expect(page.getByTestId('approval-card')).toHaveCount(1);
  await page.goto('/#/proposals');
  await page.getByRole('main').getByRole('button', { name: '调整方案', exact: true }).click();
  await expect(page.getByPlaceholder(composer)).toBeFocused();
  await expect(page.getByText('正在调整：修改 1 个任务')).toBeVisible();
});
