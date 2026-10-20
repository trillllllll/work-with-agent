import { test, expect, type APIRequestContext, type Locator, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = 'http://127.0.0.1:3015';
const oldTitle = '按大威的意见，修改k8s入门文档';
const checkTitle = '核对，第9节，我们怎么使用k8s';
const composer = '例如：创建任务：整理 API 文档';

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`${api}${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

async function seed(request: APIRequestContext, title = oldTitle) {
  const topic = await post(request, '/api/topics', { name: `e2e-batch-${Date.now()}-${Math.random().toString(16).slice(2)}` });
  const parent = await post(request, '/api/tasks', { topicId: topic.id, title, priority: 'low', description: '保留已有说明', dueDate: '2026-10-12' });
  const child = await post(request, '/api/tasks', { topicId: topic.id, parentId: parent.id, title: checkTitle, dueDate: '2026-10-12' });
  return { topic, parent, child };
}

async function expandChanges(card: Locator) {
  const toggle = card.getByRole('button', { name: /^全部修改/ });
  if (await toggle.count()) await toggle.click();
}

async function openChat(page: Page) {
  if (!(await page.getByPlaceholder(composer).isVisible())) await page.getByRole('button', { name: '打开聊天', exact: true }).click();
}

async function closeChat(page: Page) {
  const close = page.getByRole('button', { name: /^(关闭聊天|返回当前页面)$/ });
  if (await close.isVisible()) await close.click();
}

async function ask(page: Page, message: string) {
  await openChat(page);
  await page.getByPlaceholder(composer).fill(message);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

async function contentWidth(card: Locator) {
  return card.evaluate((el) => {
    const style = getComputedStyle(el);
    return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
}

async function expectColumns(card: Locator) {
  await expandChanges(card);
  await expect.poll(async () => card.evaluate((el) => {
    const before = el.querySelector('[data-testid="batch-before"]')?.getBoundingClientRect();
    const after = el.querySelector('[data-testid="batch-after"]')?.getBoundingClientRect();
    if (!before || !after || before.height < 8 || after.height < 8) return 'pending';
    const style = getComputedStyle(el);
    const inner = el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    if (inner >= 480) {
      const sideBySide = after.x > before.x + 40 && Math.abs(after.y - before.y) < 8;
      return sideBySide ? 'ok' : `wide ${Math.round(inner)} ${Math.round(before.x)},${Math.round(before.y)} ${Math.round(after.x)},${Math.round(after.y)}`;
    }
    const stacked = after.y > before.y + 16 && Math.abs(after.x - before.x) < 8;
    return stacked ? 'ok' : `narrow ${Math.round(inner)} ${Math.round(before.x)},${Math.round(before.y)} ${Math.round(after.x)},${Math.round(after.y)}`;
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

test('聊天里一次确认整组任务修改，刷新后仍是同一张已完成卡片', async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/search');
  await ask(page, '整组确认k8s文档：新建父任务用原标题，原任务改名为执行修改，两个任务作为并列子级');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expandChanges(card);
  await expect(card.getByTestId('batch-before')).toContainText('按大威的意见，修改k8s入门文档');
  await expect(card.getByTestId('batch-after')).toContainText('执行修改');
  await expect(card.getByTestId('batch-after')).toContainText('核对，第9节，我们怎么使用k8s');
  await expect(card.getByRole('button', { name: '确认修改', exact: true })).toBeEnabled();
  await expect(card.getByText('propose_task_changes')).toHaveCount(0);

  const pendingStyle = await card.evaluate((el) => ({
    radius: getComputedStyle(el).borderRadius,
    padding: getComputedStyle(el).padding,
    border: getComputedStyle(el).borderTopWidth,
    background: getComputedStyle(el).backgroundColor,
  }));
  expect(pendingStyle).toEqual({ radius: '12px', padding: '16px', border: '1px', background: 'rgb(255, 255, 255)' });

  await card.getByRole('button', { name: '确认修改', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'executed');
  await expect(card.getByRole('status')).toContainText('已修改');
  await expect(card.getByRole('button', { name: '确认修改', exact: true })).toHaveCount(0);
  await page.reload();
  await openChat(page);
  await expect(page.getByTestId('approval-card')).toHaveCount(1);
  await expect(page.getByTestId('approval-card')).toHaveAttribute('data-state', 'executed');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('暗色卡片使用约定的背景和正文颜色', async ({ page, request }) => {
  await seed(request);
  await page.addInitScript(() => { localStorage.setItem('agent-studio.theme', 'dark'); });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/search');
  await ask(page, '整组确认k8s文档：请提出整组修改');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expandChanges(card);
  const colors = await card.evaluate((el) => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
  expect(colors).toEqual({ background: 'rgb(23, 23, 23)', color: 'rgb(245, 245, 245)' });
});

test('取消整组修改不改任务', async ({ page, request }) => {
  const seeded = await seed(request);
  await page.goto('/#/search');
  await ask(page, '整组确认k8s文档：请提出整组修改');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expandChanges(card);
  await card.getByRole('button', { name: '取消', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'rejected');
  await expect(card.getByRole('status')).toContainText('已取消，未修改数据');
  expect((await e2eDatabase.task.findUniqueOrThrow({ where: { id: seeded.parent.id } })).title).toBe(oldTitle);
});

test('外部改动后批准失败并保留原任务', async ({ page, request }) => {
  const seeded = await seed(request);
  await page.goto('/#/search');
  await ask(page, '整组确认k8s文档：请提出整组修改');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expandChanges(card);
  const changed = await request.patch(`${api}/api/tasks/${seeded.child.id}`, { data: { description: '用户审批前改动' } });
  expect(changed.ok(), await changed.text()).toBe(true);
  await card.getByRole('button', { name: '确认修改', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'failed');
  await expect(card.getByRole('status')).toContainText('内容已变化，本次未修改');
  await expect(card.getByRole('alert')).toContainText('内容已变化，本次未修改');
  await expect(card.getByRole('button', { name: '刷新版本' })).toHaveCount(0);
  expect((await e2eDatabase.task.findUniqueOrThrow({ where: { id: seeded.parent.id } })).title).toBe(oldTitle);
  expect(await e2eDatabase.task.count({ where: { topicId: seeded.topic.id } })).toBe(2);
});

test('新的整组提议替换旧的待确认', async ({ page, request }) => {
  await seed(request);
  await page.goto('/#/search');
  await ask(page, '整组确认k8s文档：请提出整组修改');
  const first = page.getByTestId('approval-card');
  await expect(first).toHaveAttribute('data-state', 'pending');
  const previous = await first.getAttribute('data-approval-id');
  await ask(page, '替换这份整组提议 整组确认k8s文档');
  await expect(page.locator('[data-testid="approval-card"][data-state="pending"]')).toHaveCount(1);
  await expect(page.locator(`[data-testid="approval-card"][data-approval-id="${previous}"]`)).toHaveAttribute('data-state', 'superseded');
});

test('提交响应丢失后刷新仍显示已完成', async ({ page, request }) => {
  await seed(request);
  await page.goto('/#/search');
  await ask(page, '整组确认k8s文档：请提出整组修改');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expandChanges(card);
  await page.route('**/api/agent/approvals/*/approve', async (route) => {
    await route.fetch();
    await route.fulfill({ status: 500, contentType: 'text/plain', body: 'lost' });
  });
  await card.getByRole('button', { name: '确认修改', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'executed');
  await page.unroute('**/api/agent/approvals/*/approve');
  await page.reload();
  await openChat(page);
  await expect(page.getByTestId('approval-card')).toHaveCount(1);
  await expect(page.getByTestId('approval-card')).toHaveAttribute('data-state', 'executed');
});

test('待确认页使用同一张卡片批准', async ({ page, request }) => {
  const seeded = await seed(request);
  await page.goto('/#/search');
  await ask(page, '整组确认k8s文档：请提出整组修改');
  await expect(page.getByTestId('approval-card')).toHaveAttribute('data-state', 'pending');
  await closeChat(page);
  await page.goto('/#/proposals');
  const card = page.getByRole('main').getByTestId('approval-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('button', { name: '保存并重新预览' })).toHaveCount(0);
  await card.getByRole('button', { name: '确认修改', exact: true }).click();
  await expect.poll(async () => (await e2eDatabase.task.findUniqueOrThrow({ where: { id: seeded.parent.id } })).title).toBe('执行修改');
  await expect(card).toHaveAttribute('data-state', 'executed');
});

test('键盘确认修改并显示焦点轮廓', async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/search');
  await ask(page, '整组确认k8s文档：请提出整组修改');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expandChanges(card);
  await card.getByRole('button', { name: '取消', exact: true }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const confirm = card.getByRole('button', { name: '确认修改', exact: true });
  await expect(confirm).toBeFocused();
  expect(await confirm.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('2px');
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('data-state', 'executed');
});

test('窄屏和宽屏都不横向溢出，列数跟随卡片内容宽度', async ({ page, request }) => {
  await seed(request);
  await page.goto('/#/search');
  await ask(page, '整组确认k8s文档：请提出整组修改');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expandChanges(card);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await openChat(page);
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectColumns(card);
    if (width < 480) expect((await card.getByRole('button', { name: '确认修改', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await closeChat(page);
  await page.goto('/#/proposals');
  const wide = page.getByRole('main').getByTestId('approval-card');
  await expect(wide).toHaveCount(1);
  await expect(wide).toBeVisible();
  expect(await contentWidth(wide)).toBeGreaterThanOrEqual(480);
  await expectColumns(wide);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('超长标题在修改后完整换行', async ({ page, request }) => {
  const title = `${oldTitle}${'文档'.repeat(100)}`;
  expect(title.length).toBeGreaterThanOrEqual(200);
  await seed(request, title);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/#/search');
  await ask(page, '整组确认k8s文档：请提出整组修改');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expandChanges(card);
  const node = card.getByTestId('batch-after').locator('[data-created="true"]');
  await expect(node).toContainText(title);
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await node.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test('只查询状态不会取消待确认', async ({ page, request }) => {
  const seeded = await seed(request);
  await page.goto('/#/search');
  await ask(page, '整组确认k8s文档：请提出整组修改');
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expandChanges(card);
  await ask(page, '看看现在状态');
  await expect(page.getByText('整组提议仍在等待确认。')).toBeVisible();
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expandChanges(card);
  expect((await e2eDatabase.task.findUniqueOrThrow({ where: { id: seeded.parent.id } })).title).toBe(oldTitle);
});
