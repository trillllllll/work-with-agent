import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.use({ timezoneId: 'Asia/Shanghai' });
test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.clock.setFixedTime(new Date('2026-10-16T13:00:00+08:00'));
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('默认七天等宽，周末能创建任务，待安排面板按需展开', async ({ page }, testInfo) => {
  await e2eDatabase.task.create({ data: { id: 'waiting', title: '等待周末安排' } });
  await page.goto('/#/plan');
  await expect(page.locator('[data-plan-mode="week"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('time-band-day')).toHaveCount(7);
  await expect(page.getByRole('complementary', { name: '待安排任务' })).toBeHidden();
  const widths = await page.getByTestId('time-band-day').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
  await page.getByRole('button', { name: /^待安排/ }).click();
  await expect(page.getByTestId('tray-item')).toContainText('等待周末安排');
  await page.getByLabel('搜索安排任务').fill('不存在');
  await expect(page.getByText('没有符合条件的任务')).toBeVisible();
  await page.getByRole('button', { name: '收起待安排任务' }).click();
  const slot = page.getByRole('button', { name: '在2026-10-18 14:00添加任务', exact: true });
  await slot.scrollIntoViewIfNeeded();
  await slot.click();
  const dialog = page.getByRole('dialog', { name: '创建任务' });
  await dialog.getByLabel('任务标题').fill('周日学习');
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-date="2026-10-18"][data-testid="task-block"]')).toContainText('周日学习');
  await page.getByTestId('calendar-horizontal-scroll').evaluate((node) => { node.scrollLeft = 0; });
  if (testInfo.project.name === 'chromium') {
    await page.screenshot({ path: testInfo.outputPath('seven-day-light.png') });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({ path: testInfo.outputPath('seven-day-dark.png') });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('重叠任务叠成行后每项可打开、完成，并可恢复显示已完成', async ({ page }) => {
  await e2eDatabase.task.createMany({ data: [
    { id: 'overlap-a', title: '接口开发', scheduledStart: '2026-10-17T14:00', scheduledEnd: '2026-10-17T15:00', dueDate: '2026-10-17' },
    { id: 'overlap-b', title: '需求评审', scheduledStart: '2026-10-17T14:30', scheduledEnd: '2026-10-17T15:30', dueDate: '2026-10-17' },
    { id: 'overlap-c', title: '测试用例', scheduledStart: '2026-10-17T14:45', scheduledEnd: '2026-10-17T16:00', dueDate: '2026-10-17' },
  ] });
  await page.goto('/#/plan');
  const day = page.locator('[data-testid="time-band-day"][data-date="2026-10-17"]');
  const stack = day.getByTestId('plan-stack');
  await stack.scrollIntoViewIfNeeded();
  await expect(stack).toContainText('接口开发');
  await expect(stack).toContainText('需求评审');
  await expect(stack).toContainText('测试用例');
  await expect(stack.getByTestId('plan-stack-more')).toHaveCount(0);
  await stack.getByLabel('完成任务：接口开发', { exact: true }).click();
  await expect(stack.getByText('接口开发', { exact: true })).toHaveCount(0);
  await page.getByLabel('显示已完成', { exact: true }).check();
  await expect(stack.getByLabel('重开任务：接口开发')).toBeChecked();
  await stack.getByRole('button', { name: '打开任务：需求评审', exact: true }).click();
  await expect(page.getByRole('button', { name: '安排时间', exact: true })).toContainText('14:30');
});

test('日视图一个用整卡，两个并排，三个以上叠行', async ({ page }) => {
  await e2eDatabase.task.createMany({ data: [
    { id: 'solo', title: '独自整理', scheduledStart: '2026-10-16T10:00', scheduledEnd: '2026-10-16T11:00', dueDate: '2026-10-16' },
    { id: 'pair-a', title: '并排甲', scheduledStart: '2026-10-16T11:00', scheduledEnd: '2026-10-16T12:00', dueDate: '2026-10-16' },
    { id: 'pair-b', title: '并排乙', scheduledStart: '2026-10-16T11:00', scheduledEnd: '2026-10-16T12:00', dueDate: '2026-10-16' },
    { id: 'pile-a', title: '叠行甲', scheduledStart: '2026-10-16T14:00', scheduledEnd: '2026-10-16T16:00', dueDate: '2026-10-16' },
    { id: 'pile-b', title: '叠行乙', scheduledStart: '2026-10-16T14:00', scheduledEnd: '2026-10-16T16:00', dueDate: '2026-10-16' },
    { id: 'pile-c', title: '叠行丙', scheduledStart: '2026-10-16T14:00', scheduledEnd: '2026-10-16T16:00', dueDate: '2026-10-16' },
    { id: 'pile-d', title: '叠行丁', scheduledStart: '2026-10-16T14:10', scheduledEnd: '2026-10-16T16:00', dueDate: '2026-10-16' },
  ] });
  await page.goto('/#/plan');
  await page.getByRole('button', { name: '日', exact: true }).click();
  const day = page.locator('[data-testid="time-band-day"][data-date="2026-10-16"]');
  const solo = day.locator('[data-task-id="solo"]');
  const pair = day.locator('[data-task-id="pair-a"]');
  const stack = day.getByTestId('plan-stack');
  await expect(solo).toContainText('独自整理');
  await expect(day.locator('[data-task-id="pair-b"]')).toContainText('并排乙');
  await expect(stack).toContainText('叠行甲');
  await expect(stack).toContainText('叠行丙');
  await expect(stack.getByTestId('plan-stack-more')).toHaveText('还有 1 个');
  await expect(stack).not.toContainText('叠行丁');
  const borders = await pair.evaluate((node) => {
    const style = getComputedStyle(node);
    return { left: style.borderLeftWidth, top: style.borderTopWidth, leftColor: style.borderLeftColor, topColor: style.borderTopColor };
  });
  expect(borders.left).toBe(borders.top);
  expect(borders.leftColor).toBe(borders.topColor);
  const soloBorders = await solo.evaluate((node) => {
    const style = getComputedStyle(node);
    return style.borderLeftWidth === style.borderRightWidth && style.borderLeftColor === style.borderRightColor;
  });
  expect(soloBorders).toBe(true);
  await stack.getByTestId('plan-stack-more').click();
  const dialog = page.getByRole('dialog', { name: '重叠任务' });
  await expect(dialog).toContainText('叠行丁');
  await expect(dialog).not.toContainText('叠行甲');
});

test('相邻时间点与午夜合并卡片不遮挡后续任务或超出当天', async ({ page }) => {
  await e2eDatabase.task.createMany({ data: [
    { id: 'point-a', title: '十点提醒甲', scheduledStart: '2026-10-17T10:00', dueDate: '2026-10-17' },
    { id: 'point-b', title: '十点提醒乙', scheduledStart: '2026-10-17T10:00', dueDate: '2026-10-17' },
    { id: 'point-next', title: '十点半提醒', scheduledStart: '2026-10-17T10:30', dueDate: '2026-10-17' },
    { id: 'point-late-a', title: '午夜提醒甲', scheduledStart: '2026-10-18T23:59', dueDate: '2026-10-18' },
    { id: 'point-late-b', title: '午夜提醒乙', scheduledStart: '2026-10-18T23:59', dueDate: '2026-10-18' },
  ] });
  await page.goto('/#/plan');
  await expect(page.getByTestId('plan-stack')).toHaveCount(2);
  const saturday = page.locator('[data-testid="time-band-day"][data-date="2026-10-17"]');
  const group = saturday.getByTestId('plan-stack');
  const next = saturday.locator('[data-task-id="point-next"]');
  const groupRect = await group.boundingBox();
  const nextRect = await next.boundingBox();
  expect(groupRect!.y + groupRect!.height).toBeLessThanOrEqual(nextRect!.y);
  const sunday = page.locator('[data-testid="time-band-day"][data-date="2026-10-18"]');
  const lateRect = await sunday.getByTestId('plan-stack').boundingBox();
  const dayRect = await sunday.boundingBox();
  expect(lateRect!.y + lateRect!.height).toBeLessThanOrEqual(dayRect!.y + dayRect!.height);
  await next.getByRole('button', { name: '打开任务：十点半提醒', exact: true }).click();
  await expect(page.getByRole('button', { name: '安排时间', exact: true })).toContainText('10:30');
});
