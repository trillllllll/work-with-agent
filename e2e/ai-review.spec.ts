import { test, expect, type APIRequestContext, type Locator, type Page } from './fixtures.js';
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

async function seedSchedule(request: APIRequestContext) {
  return post(request, '/api/tasks', {
    title: '安排样本',
    dueDate: '2026-10-15',
    scheduledStart: '2026-10-15T11:00',
    scheduledEnd: '2026-10-15T12:00',
  }) as Promise<{ id: string }>;
}

async function cardStyle(card: Locator) {
  return card.evaluate((el) => {
    const style = getComputedStyle(el);
    return { radius: style.borderRadius, padding: style.padding, border: style.borderTopWidth, background: style.backgroundColor, color: style.color };
  });
}

async function expectDiffLayout(card: Locator) {
  await expect.poll(async () => card.locator('.review-diff').first().evaluate((el) => {
    const host = el.closest('.task-batch-card');
    const spans = [...el.children] as HTMLElement[];
    if (!host || spans.length < 3) return 'pending';
    const style = getComputedStyle(host);
    const inner = host.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const before = spans[0].getBoundingClientRect();
    const after = spans[2].getBoundingClientRect();
    if (before.height < 8 || after.height < 8) return 'pending';
    if (inner >= 480) {
      return after.x > before.x + 40 && Math.abs(after.y - before.y) < 8 ? 'ok' : `wide ${Math.round(inner)}`;
    }
    return after.y > before.y + 8 && Math.abs(after.x - before.x) < 8 ? 'ok' : `narrow ${Math.round(inner)}`;
  })).toBe('ok');
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

test('确认安排修改后留在原页面，刷新仍是已完成卡片', async ({ page, isMobile, request }) => {
  test.skip(Boolean(isMobile), '审批卡在桌面视口验收，窄屏另测');
  const task = await seedSchedule(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await ask(page, '把安排改到2026-10-16');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expect(card.getByTestId('approval-impact')).toContainText('2026-10-16');
  await expect(card.getByTestId('approval-related')).toContainText('关联对象 0 项');
  await expect(card.getByRole('button', { name: '确认修改', exact: true })).toBeEnabled();
  expect(await cardStyle(card)).toEqual({
    radius: '12px',
    padding: '16px',
    border: '1px',
    background: 'rgb(255, 255, 255)',
    color: 'rgb(23, 23, 23)',
  });
  await expectDiffLayout(card);
  await card.screenshot({ path: '/tmp/wwa-approval-light.png' });
  await page.goto('/#/proposals');
  const wideCard = page.getByRole('main').getByTestId('approval-card');
  await expect(wideCard).toHaveCount(1);
  await expectDiffLayout(wideCard);
  await wideCard.screenshot({ path: '/tmp/wwa-approval-wide.png' });
  await page.goto('/');
  await openChat(page);
  await expect(card).toHaveAttribute('data-state', 'pending');

  const urlBeforeApprove = page.url();
  await card.getByRole('button', { name: '确认修改', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'executed');
  expect(page.url()).toBe(urlBeforeApprove);
  await expect(card.getByRole('button', { name: '确认修改', exact: true })).toHaveCount(0);
  await expect(card.getByRole('status')).toContainText('已修改');
  const chatHeader = page.locator('header').filter({ has: page.getByRole('heading', { name: '全局聊天' }) });
  await expect(page.getByText('安排方案已放在确认卡里。')).toBeVisible();
  await expect(page.getByText('正在输出…')).toHaveCount(0);
  await expect(chatHeader.getByText('可用', { exact: true })).toBeVisible();
  await expect(chatHeader.getByText('处理中…')).toHaveCount(0);

  await page.reload();
  await openChat(page);
  await expect(page.getByTestId('approval-card')).toHaveCount(1);
  await expect(page.getByTestId('approval-card')).toHaveAttribute('data-state', 'executed');
  await expect(page.getByText('正在输出…')).toHaveCount(0);
  await expect(page.locator('header').filter({ has: page.getByRole('heading', { name: '全局聊天' }) }).getByText('可用', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const stored = await e2eDatabase.task.findUniqueOrThrow({ where: { id: task.id } });
  expect(stored).toMatchObject({ dueDate: '2026-10-16', scheduledStart: '2026-10-16T11:00', scheduledEnd: '2026-10-16T12:00' });
});

test('深色审批卡使用约定颜色', async ({ page, isMobile, request }) => {
  test.skip(Boolean(isMobile), '深色审批卡在桌面视口验收');
  await seedSchedule(request);
  await page.addInitScript(() => { localStorage.setItem('agent-studio.theme', 'dark'); });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await ask(page, '把安排改到2026-10-16');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expect(card.getByTestId('approval-impact')).toContainText('2026-10-16');
  const colors = await cardStyle(card);
  expect(colors.background).toBe('rgb(23, 23, 23)');
  expect(colors.color).toBe('rgb(245, 245, 245)');
  await card.screenshot({ path: '/tmp/wwa-approval-dark.png' });
});

test('窄屏前后对比上下排列，主按钮独占一行', async ({ page, isMobile, request }) => {
  test.skip(Boolean(isMobile), '窄屏由视口尺寸覆盖，不重复移动项目');
  await seedSchedule(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await ask(page, '把安排改到2026-10-16');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expect(card.getByTestId('approval-impact')).toContainText('2026-10-16');
  const confirm = card.getByRole('button', { name: '确认修改', exact: true });
  await confirm.scrollIntoViewIfNeeded();
  expect((await confirm.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expectDiffLayout(card);
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await card.screenshot({ path: '/tmp/wwa-approval-narrow.png' });
});

test('键盘从取消两次跳到确认修改', async ({ page, isMobile, request }) => {
  test.skip(Boolean(isMobile), '键盘焦点在桌面视口验收');
  await seedSchedule(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await ask(page, '把安排改到2026-10-16');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-state', 'pending');
  await card.getByRole('button', { name: '取消', exact: true }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const confirm = card.getByRole('button', { name: '确认修改', exact: true });
  await expect(confirm).toBeFocused();
  expect(await confirm.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('2px');
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('data-state', 'executed');
});
