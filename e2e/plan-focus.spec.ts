import { test, expect, type Locator, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = 'http://127.0.0.1:3015';

function localKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function addDays(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return localKey(date);
}
function clockSeconds(value: string) {
  const [minutes, seconds] = value.split(':').map(Number);
  return minutes * 60 + seconds;
}

async function jsonData(response: { ok: () => boolean; text: () => Promise<string>; json: () => Promise<{ data: unknown }> }) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

async function drag(page: Page, from: Locator, to: Locator) {
  await from.scrollIntoViewIfNeeded();
  await to.scrollIntoViewIfNeeded();
  const source = await from.boundingBox();
  const target = await to.boundingBox();
  if (!source || !target) throw new Error('拖动区域没有布局');
  const startX = source.x + source.width / 2;
  const startY = source.y + source.height / 2;
  const endX = target.x + Math.min(Math.max(target.width / 2, 8), target.width - 4);
  const endY = target.y + target.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 24 });
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, button: 'left', buttons: 0, clickCount: 1 });
  await session.detach();
}

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
    if (typeof Notification !== 'undefined') Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'denied' });
  });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('规划页保持路由，并按公式摆放 14:00 时间块', async ({ page, request }) => {
  const today = localKey();
  const created = await jsonData(await request.post(`${apiUrl}/api/tasks`, { data: { title: '下午安排', estimatedMinutes: 90, dueDate: today, scheduledStart: `${today}T14:00`, scheduledEnd: `${today}T15:30` } })) as { id: string };
  await page.goto('/#/plan');
  await expect(page).toHaveURL(/#\/plan$/);
  await expect(page.getByRole('heading', { name: '规划', exact: true })).toBeVisible();
  const block = page.locator(`[data-testid="task-block"][data-task-id="${created.id}"]`);
  await expect(block).toBeVisible();
  const style = await block.evaluate((node) => {
    const parent = node.parentElement as HTMLElement;
    return { top: parent.style.top, height: parent.style.height };
  });
  expect(style.top).toBe('784px');
  expect(style.height).toBe('82px');

  await page.getByRole('button', { name: '周', exact: true }).click();
  await expect(page.locator('[data-plan-mode="week"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`[data-testid="task-block"][data-task-id="${created.id}"]`)).toBeVisible();

  await page.getByRole('button', { name: '月', exact: true }).click();
  await expect(page.locator(`[data-drop-id="cell:${today}"]`)).toContainText('14:00');
});

test('托盘拖到 16:00 得到一小时并可以撤销', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '鼠标跨列拖动；触屏安排由 schedule.spec.ts 的详情编辑覆盖');
  const today = localKey();
  const created = await jsonData(await request.post(`${apiUrl}/api/tasks`, { data: { title: '待安排事项' } })) as { id: string };
  await page.goto('/#/plan');
  const tray = page.getByTestId('tray-item').filter({ hasText: '待安排事项' });
  await expect(tray).toBeVisible();
  await drag(page, tray, page.locator(`[data-drop-id="slot:${today}:16:00"]`));
  await expect(page.getByText('任务已更新').first()).toBeVisible();
  await expect.poll(async () => (await jsonData(await request.get(`${apiUrl}/api/tasks/${created.id}`)) as { scheduledStart: string; scheduledEnd: string; dueDate: string })).toMatchObject({ scheduledStart: `${today}T16:00`, scheduledEnd: `${today}T17:00`, dueDate: today });
  await page.locator(`[data-testid="task-block"][data-task-id="${created.id}"]`).getByRole('button', { name: '打开任务：待安排事项', exact: true }).click();
  await expect(page.getByRole('button', { name: '安排时间', exact: true })).toContainText('16:00 — 17:00');
  await page.getByRole('button', { name: '撤销' }).click();
  await expect.poll(async () => (await jsonData(await request.get(`${apiUrl}/api/tasks/${created.id}`)) as { scheduledStart: string | null }).scheduledStart).toBeNull();
});

test('月视图拖到另一天保留时分', async ({ page, request }) => {
  const today = localKey();
  const tomorrow = addDays(today, 1);
  const next = tomorrow.slice(0, 7) === today.slice(0, 7) ? tomorrow : addDays(today, -1);
  const created = await jsonData(await request.post(`${apiUrl}/api/tasks`, { data: { title: '跨日安排', dueDate: today, scheduledStart: `${today}T14:00`, scheduledEnd: `${today}T15:30` } })) as { id: string };
  await page.goto('/#/plan');
  await page.getByRole('button', { name: '月', exact: true }).click();
  const source = page.locator(`[data-drop-id="cell:${today}"]`).getByText('跨日安排');
  await drag(page, source, page.locator(`[data-drop-id="cell:${next}"]`));
  await expect.poll(async () => await jsonData(await request.get(`${apiUrl}/api/tasks/${created.id}`)) as { dueDate: string; scheduledStart: string; scheduledEnd: string }).toMatchObject({ dueDate: next, scheduledStart: `${next}T14:00`, scheduledEnd: `${next}T15:30` });
});

test('一分钟专注完成后留下记录，刷新则暂停且不归零', async ({ page, request }) => {
  test.setTimeout(150_000);
  await page.goto('/#/focus');
  await page.evaluate(() => {
    localStorage.setItem('todo.focusTimer', JSON.stringify({ phase: 'idle', taskId: null, taskTitle: null, accumulatedMs: 0, segmentStartedAt: null, sessionStartedAt: null, plannedMinutes: 1, breakMinutes: 5, cycle: 0, autoStartBreak: false }));
  });
  await page.reload();
  await expect(page.getByTestId('focus-page')).toBeVisible();
  await expect(page.getByTestId('focus-remaining')).toHaveText('01:00');
  await page.getByRole('button', { name: '开始专注', exact: true }).click();
  await page.goto('/#/inbox');
  const chip = page.getByTestId('focus-chip');
  await expect(chip).toBeVisible();
  const clock = chip.locator('.tabular-nums');
  await expect(clock).not.toHaveText('01:00');
  const before = clockSeconds((await clock.textContent()) ?? '00:00');
  expect(before).toBeGreaterThan(0);
  await page.reload();
  await expect(chip).toBeVisible();
  await expect(chip.getByRole('button', { name: '继续' })).toBeVisible();
  const after = clockSeconds((await clock.textContent()) ?? '00:00');
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThanOrEqual(before);
  expect(after).toBeLessThan(60);
  await chip.getByRole('button', { name: '继续' }).click();
  await expect(page.getByText('专注完成，休息一下').first()).toBeVisible({ timeout: 70_000 });
  await expect(chip).toContainText('休息一下');
  await expect.poll(async () => {
    const rows = await jsonData(await request.get(`${apiUrl}/api/focus-sessions`)) as { durationMinutes: number; completed: boolean; kind: string; startedAt: string }[];
    return rows.some((row) => row.kind === 'focus' && row.durationMinutes === 1 && row.completed && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(row.startedAt));
  }).toBe(true);
});

test('暗色模式下规划页和专注页使用主题色', async ({ page }, testInfo) => {
  await page.goto(testInfo.project.name === 'mobile' ? '/#/more' : '/#/plan');
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.getByRole('menuitem', { name: '深色' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  if (testInfo.project.name === 'mobile') await page.goto('/#/plan');
  const darkTone = await page.getByRole('heading', { name: '规划' }).evaluate((node) => getComputedStyle(node).color);
  const darkChannels = darkTone.match(/\d+/g)!.map(Number);
  expect((darkChannels[0] + darkChannels[1] + darkChannels[2]) / 3).toBeGreaterThan(160);
  await expect(page.getByTestId('plan-page').getByRole('button', { name: '今天', exact: true })).toHaveCSS('color', darkTone);
  const lightFills = await page.getByTestId('plan-page').locator('*').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor).filter((color) => color === 'rgb(255, 255, 255)'));
  expect(lightFills).toEqual([]);
  await page.goto('/#/focus');
  const focusFills = await page.getByTestId('focus-page').locator('*').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor).filter((color) => color === 'rgb(255, 255, 255)'));
  expect(focusFills).toEqual([]);
});

test('375px 周视图可横滑，专注芯片在底栏上方', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/#/plan');
  const tabs = page.getByRole('navigation', { name: '主导航' });
  await expect(tabs.getByRole('button')).toHaveText(['收集箱', '今天', '四象限', '清单', '更多']);
  await page.getByRole('button', { name: '周', exact: true }).click();
  const scroll = await page.getByTestId('calendar-horizontal-scroll').evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, pageWidth: document.documentElement.scrollWidth }));
  expect(scroll.scrollWidth).toBeGreaterThanOrEqual(720);
  expect(scroll.clientWidth).toBeLessThanOrEqual(375);
  expect(scroll.pageWidth).toBeLessThanOrEqual(375);
  await page.goto('/#/focus');
  await page.getByRole('button', { name: '开始专注', exact: true }).click();
  const chip = await page.getByTestId('focus-chip').boundingBox();
  const tab = await tabs.boundingBox();
  if (!chip || !tab) throw new Error('芯片或底栏没有布局');
  expect(chip.y + chip.height).toBeLessThanOrEqual(tab.y + 1);
});
