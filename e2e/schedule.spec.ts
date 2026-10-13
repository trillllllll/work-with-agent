import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
import type { Locator } from '@playwright/test';

const api = 'http://127.0.0.1:3015';
const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const dayShift = (day: string, count: number) => new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
async function drag(page: Page, from: Locator, to: Locator) {
  await to.scrollIntoViewIfNeeded();
  await from.scrollIntoViewIfNeeded();
  const source = await from.boundingBox(); const target = await to.boundingBox();
  if (!source || !target) throw new Error('No drag layout');
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 8, source.y + source.height / 2, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await page.mouse.up();
}
async function openDetails(page: Page, title: string) {
  await page.getByRole('button', { name: `打开任务：${title}`, exact: true }).click();
  await page.getByRole('button', { name: '安排时间', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('全天和跨午夜任务在日周月都可找到，时间点不占用时长', async ({ page, request }) => {
  const day = today(); const previous = dayShift(day, -1);
  const create = async (data: Record<string, unknown>) => (await (await request.post(`${api}/api/tasks`, { data })).json()).data;
  const allDay = await create({ title: '全天事项', dueDate: day });
  const range = await create({ title: '跨午夜事项', scheduledStart: `${previous}T23:00`, scheduledEnd: `${day}T01:00` });
  const point = await create({ title: '时间点事项', scheduledStart: `${day}T15:00` });
  await page.goto('/#/plan');
  await expect(page.locator(`[data-drop-id="allday:${day}"]`)).toContainText(allDay.title);
  const continuation = page.locator(`[data-task-id="${range.id}"]`);
  await expect(continuation).toHaveCount(1);
  await expect(continuation.getByLabel('调整开始：跨午夜事项')).toHaveCount(0);
  await expect(continuation.getByLabel('调整结束：跨午夜事项')).toHaveCount(1);
  await expect(page.locator(`[data-task-id="${point.id}"]`)).toHaveAttribute('data-point', 'true');
  await page.getByRole('button', { name: '周', exact: true }).click();
  await expect(page.locator(`[data-drop-id="allday:${day}"]`)).toContainText('全天事项');
  await expect(page.locator(`[data-task-id="${range.id}"][data-date="${day}"]`)).toHaveCount(1);
  await page.getByRole('button', { name: '月', exact: true }).click();
  await expect(page.locator(`[data-drop-id="cell:${day}"]`)).toContainText('跨午夜事项');
  await page.goto('/#/today');
  await expect(page.getByTestId(`task-row-${range.id}`)).toHaveCount(1);
  await expect(page.getByRole('heading', { name: /^逾期/ })).toHaveCount(0);
});

test('全天任务超过两条时收起，展开后刷新和周视图保持', async ({ page }) => {
  const day = today();
  await e2eDatabase.task.createMany({ data: [
    { id: 'allday-1', title: '全天甲', dueDate: day, sortOrder: 0 },
    { id: 'allday-2', title: '全天乙', dueDate: day, sortOrder: 1 },
    { id: 'allday-3', title: '全天丙', dueDate: day, sortOrder: 2 },
  ] });
  await page.goto('/#/plan');
  const zone = page.locator(`[data-drop-id="allday:${day}"]`);
  await expect(zone).toContainText('全天甲');
  await expect(zone).toContainText('全天乙');
  await expect(page.getByText('全天丙', { exact: true })).toHaveCount(0);
  await expect(zone.getByRole('button', { name: '还有 1 个', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '展开全天任务', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: '/tmp/wwa-allday-collapsed-light.png' });
  await zone.getByRole('button', { name: '还有 1 个', exact: true }).click();
  await expect(page.getByText('全天丙', { exact: true })).toBeVisible();
  const expanded = page.getByRole('button', { name: '收起全天任务', exact: true });
  await expect(expanded).toHaveAttribute('aria-expanded', 'true');
  await expect(zone).toHaveCSS('max-height', '144px');
  await expect(zone).toHaveCSS('overflow-y', 'auto');
  await page.screenshot({ path: '/tmp/wwa-allday-expanded-light.png' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: '/tmp/wwa-allday-expanded-dark.png' });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await expanded.click();
  await expect(page.getByText('全天丙', { exact: true })).toHaveCount(0);
  await expect(zone).toHaveCSS('max-height', 'none');
  await page.getByRole('button', { name: '展开全天任务', exact: true }).click();
  await page.reload();
  await expect(page.getByText('全天丙', { exact: true })).toBeVisible();
  await e2eDatabase.task.createMany({ data: Array.from({ length: 8 }, (_, index) => ({ id: `allday-extra-${index}`, title: `全天更多${index}`, dueDate: day, sortOrder: 3 + index })) });
  await page.reload();
  const capped = await zone.evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight }));
  expect(capped.client).toBeLessThanOrEqual(144);
  expect(capped.scroll).toBeGreaterThan(capped.client);
  expect(await page.getByTestId('timeline-scroll').evaluate((node) => node.getBoundingClientRect().top)).toBeLessThan(700);
  await page.getByRole('button', { name: '周', exact: true }).click();
  await expect(page.locator(`[data-drop-id="allday:${day}"]`)).toContainText('全天丙');
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.screenshot({ path: '/tmp/wwa-allday-week-1200.png' });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.screenshot({ path: '/tmp/wwa-allday-week-390.png' });
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const scroll = page.getByTestId('calendar-horizontal-scroll');
  expect(await scroll.evaluate((node) => node.scrollWidth)).toBeGreaterThan(375);
});

test('详情安排显式保存，取消不写入，时长按钮改变结束时间', async ({ page, request }) => {
  const day = today();
  const item = (await (await request.post(`${api}/api/tasks`, { data: { title: '编辑安排', scheduledStart: `${day}T14:00`, scheduledEnd: `${day}T15:00`, estimatedMinutes: 60 } })).json()).data;
  const read = async () => (await (await request.get(`${api}/api/tasks/${item.id}`)).json()).data;
  await page.goto('/#/plan'); await openDetails(page, '编辑安排');
  await page.getByRole('button', { name: '2小时', exact: true }).click();
  expect((await read()).scheduledEnd).toBe(`${day}T15:00`);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '安排时间', exact: true }).click();
  await expect(page.getByLabel('结束时间', { exact: true })).toHaveValue(`${day}T15:00`);
  await page.getByRole('button', { name: '2小时', exact: true }).click();
  await page.getByRole('button', { name: '保存安排', exact: true }).click();
  await expect.poll(async () => (await read()).scheduledEnd).toBe(`${day}T16:00`);
  await page.getByRole('button', { name: '预计时长', exact: true }).click();
  await page.getByLabel('预计时长分钟', { exact: true }).fill('30');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await read()).estimatedMinutes).toBe(30);
  expect((await read()).scheduledEnd).toBe(`${day}T16:00`);
  await page.getByRole('button', { name: '安排时间', exact: true }).click();
  await page.getByLabel('安排方式', { exact: true }).selectOption('point');
  await page.getByRole('button', { name: '保存安排', exact: true }).click();
  await expect.poll(async () => (await read()).scheduledEnd).toBeNull();
});

test('空白处创建支持输入法和取消，完成后保留且隐藏选择可恢复', async ({ page, request }) => {
  const day = today();
  await page.goto('/#/plan');
  const slot = page.getByRole('button', { name: `在${day} 15:00添加任务`, exact: true });
  await slot.click();
  let dialog = page.getByRole('dialog', { name: '创建任务', exact: true });
  await dialog.getByLabel('任务标题').fill('取消的草稿');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await (await request.get(`${api}/api/tasks`)).json()).data).toHaveLength(0);
  await slot.click(); dialog = page.getByRole('dialog', { name: '创建任务', exact: true });
  const title = dialog.getByLabel('任务标题');
  await title.dispatchEvent('compositionstart'); await title.fill('输入法创建'); await title.press('Enter');
  expect((await (await request.get(`${api}/api/tasks`)).json()).data).toHaveLength(0);
  await title.dispatchEvent('compositionend');
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const rows = (await (await request.get(`${api}/api/tasks`)).json()).data;
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ title: '输入法创建', topicId: null, scheduledStart: `${day}T15:00`, scheduledEnd: `${day}T16:00` });
  const block = page.locator(`[data-task-id="${rows[0].id}"]`);
  await block.getByLabel('完成任务：输入法创建', { exact: true }).click();
  await expect(block.getByLabel('重开任务：输入法创建')).toBeChecked();
  await page.getByLabel('显示已完成', { exact: true }).uncheck();
  await expect(block).toHaveCount(0);
  await page.reload(); await expect(page.getByLabel('显示已完成', { exact: true })).not.toBeChecked();
  await page.getByLabel('显示已完成', { exact: true }).check(); await expect(block).toHaveCount(1);
});

test('安排任务超过50条可搜索、筛选并打开，窄屏周视图没有页面溢出', async ({ page, request }) => {
  // Seed directly in the isolated E2E database to avoid 55 command round-trips.
  await e2eDatabase.task.createMany({ data: Array.from({ length: 55 }, (_, index) => ({ id: `tray-${index}`, title: `待安排${index}` })) });
  await page.goto('/#/plan');
  await expect(page.getByTestId('tray-item')).toHaveCount(55);
  await page.getByLabel('搜索安排任务').fill('待安排54');
  await expect(page.getByTestId('tray-item')).toHaveCount(1);
  await page.getByTestId('tray-item').click();
  await expect(page.getByRole('dialog', { name: '任务详情', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 800 });
  await page.getByRole('button', { name: '周', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const scroll = page.getByTestId('calendar-horizontal-scroll');
  expect(await scroll.evaluate((node) => node.scrollWidth)).toBeGreaterThan(375);
  // Capture both themes for visual verification without adding tracked artifacts.
  await page.screenshot({ path: '/tmp/wwa-schedule-mobile-light.png' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: '/tmp/wwa-schedule-mobile-dark.png' });
  expect((await (await request.get(`${api}/api/tasks`)).json()).data).toHaveLength(55);
});

test('拖动安排、缩放、拖回取消和撤销保持一致', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '触屏使用已覆盖的详情编辑入口');
  await page.setViewportSize({ width: 1500, height: 1000 });
  const day = today();
  const item = (await (await request.post(`${api}/api/tasks`, { data: { title: '拖动完整闭环', estimatedMinutes: 90 } })).json()).data;
  const read = async () => (await (await request.get(`${api}/api/tasks/${item.id}`)).json()).data;
  await page.goto('/#/plan');
  const slot = page.locator(`[data-drop-id="slot:${day}:14:00"]`);
  await drag(page, page.getByTestId('tray-item'), slot);
  await expect.poll(async () => (await read()).scheduledStart).toBe(`${day}T14:00`);
  const block = page.locator(`[data-task-id="${item.id}"]`);
  await block.scrollIntoViewIfNeeded();
  const handle = block.getByLabel('调整结束：拖动完整闭环'); const box = await handle.boundingBox();
  if (!box) throw new Error('No resize handle');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 28, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await read()).scheduledEnd).toBe(`${day}T16:00`);
  await page.screenshot({ path: '/tmp/wwa-schedule-desktop-light.png' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: '/tmp/wwa-schedule-desktop-dark.png' });
  await drag(page, block.getByRole('button', { name: '打开任务：拖动完整闭环', exact: true }), page.locator('[data-drop-id="unschedule"]'));
  await expect.poll(async () => (await read()).dueDate).toBeNull();
  expect(await read()).toMatchObject({ scheduledStart: null, scheduledEnd: null, estimatedMinutes: 90 });
  await page.getByRole('button', { name: '撤销', exact: true }).last().click();
  await expect.poll(async () => (await read()).scheduledEnd).toBe(`${day}T16:00`);
});

test('打开弹层期间外部更新会触发版本冲突，不覆盖安排或预计时长', async ({ page, request }) => {
  const day = today();
  const item = (await (await request.post(`${api}/api/tasks`, { data: { title: '外部并发安排', scheduledStart: `${day}T14:00`, scheduledEnd: `${day}T15:00`, estimatedMinutes: 60 } })).json()).data;
  const read = async () => (await (await request.get(`${api}/api/tasks/${item.id}`)).json()).data;
  await page.goto('/#/plan'); await openDetails(page, '外部并发安排');
  await page.getByRole('button', { name: '2小时', exact: true }).click();
  await request.patch(`${api}/api/tasks/${item.id}`, { data: { scheduledStart: `${day}T17:00`, scheduledEnd: `${day}T18:00` } });
  await expect(page.getByRole('button', { name: '安排时间', exact: true })).toContainText('17:00');
  const [conflict] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/api/tasks/${item.id}`) && response.request().method() === 'PATCH'),
    page.getByRole('button', { name: '保存安排', exact: true }).click(),
  ]);
  expect(conflict.status()).toBe(409);
  expect(await read()).toMatchObject({ scheduledStart: `${day}T17:00`, scheduledEnd: `${day}T18:00` });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '预计时长', exact: true }).click();
  await page.getByLabel('预计时长分钟', { exact: true }).fill('30');
  await request.patch(`${api}/api/tasks/${item.id}`, { data: { estimatedMinutes: 90 } });
  await expect(page.getByRole('button', { name: '预计时长', exact: true })).toContainText('90分钟');
  const [estimateConflict] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/api/tasks/${item.id}`) && response.request().method() === 'PATCH'),
    page.getByRole('button', { name: '保存', exact: true }).click(),
  ]);
  expect(estimateConflict.status()).toBe(409);
  expect((await read()).estimatedMinutes).toBe(90);
});

test('拖动保存失败后恢复原安排，不留下预览块', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '触屏使用详情编辑');
  await page.setViewportSize({ width: 1500, height: 1000 });
  const day = today();
  const item = (await (await request.post(`${api}/api/tasks`, { data: { title: '保存失败安排', scheduledStart: `${day}T14:00`, scheduledEnd: `${day}T15:00` } })).json()).data;
  await page.goto('/#/plan');
  await page.route(`**/api/tasks/${item.id}`, async (route) => {
    if (route.request().method() === 'PATCH') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ data: null, code: 'TEST_FAILURE', error: '安排保存失败' }) });
    return route.continue();
  });
  const block = page.locator(`[data-task-id="${item.id}"]`);
  await drag(page, block.getByRole('button', { name: '打开任务：保存失败安排', exact: true }), page.locator('[data-drop-id="unschedule"]'));
  await expect(page.getByText('安排保存失败', { exact: true })).toBeVisible();
  await expect(block).toHaveCount(1);
  expect((await (await request.get(`${api}/api/tasks/${item.id}`)).json()).data).toMatchObject({ dueDate: day, scheduledStart: `${day}T14:00`, scheduledEnd: `${day}T15:00` });
  expect(await block.evaluate((node) => (node.parentElement as HTMLElement).style.top)).toBe('784px');
});
