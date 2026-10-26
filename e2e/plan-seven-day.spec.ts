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

test('重叠任务在周视图并排成泳道，每项可打开、完成，并可恢复显示已完成', async ({ page }) => {
  await e2eDatabase.task.createMany({ data: [
    { id: 'overlap-a', title: '接口开发', scheduledStart: '2026-10-16T14:00', scheduledEnd: '2026-10-16T15:00', dueDate: '2026-10-16' },
    { id: 'overlap-b', title: '需求评审', scheduledStart: '2026-10-16T14:30', scheduledEnd: '2026-10-16T15:30', dueDate: '2026-10-16' },
  ] });
  await page.goto('/#/plan');
  const day = page.locator('[data-testid="time-band-day"][data-date="2026-10-16"]');
  const first = day.locator('[data-task-id="overlap-a"]');
  const second = day.locator('[data-task-id="overlap-b"]');
  await first.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('plan-stack')).toHaveCount(0);
  await expect(first.locator('xpath=..')).toHaveAttribute('data-lane', '0');
  await expect(second.locator('xpath=..')).toHaveAttribute('data-lane', '1');
  await expect(second.locator('xpath=..')).toHaveAttribute('data-lane-count', '2');
  // Narrow week lanes may hide the checkbox; complete from the wider day view.
  await page.getByRole('button', { name: '日', exact: true }).click();
  await first.scrollIntoViewIfNeeded();
  await first.getByLabel('完成任务：接口开发', { exact: true }).click();
  await expect(day.getByText('接口开发', { exact: true })).toHaveCount(0);
  await expect(second.locator('xpath=..')).toHaveAttribute('data-lane-count', '1');
  await page.getByLabel('显示已完成', { exact: true }).check();
  await expect(first.getByLabel('重开任务：接口开发')).toBeChecked();
  // Completion changes the visual state only; both tasks keep their lanes.
  await expect(first.locator('xpath=..')).toHaveAttribute('data-lane', '0');
  await expect(second.locator('xpath=..')).toHaveAttribute('data-lane', '1');
  await second.getByRole('button', { name: '打开任务：需求评审', exact: true }).click();
  await expect(page.getByRole('button', { name: '安排时间', exact: true })).toContainText('14:30');
});

test('日视图一个用整卡，重叠的按泳道并排，列太窄时多出的收进 +N', async ({ page }) => {
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
  await expect(solo).toContainText('独自整理');
  await expect(solo.locator('xpath=..')).toHaveAttribute('data-lane-count', '1');
  await expect(day.locator('[data-task-id="pair-b"]')).toContainText('并排乙');
  await expect(pair.locator('xpath=..')).toHaveAttribute('data-lane-count', '2');
  for (const id of ['pile-a', 'pile-b', 'pile-c', 'pile-d']) await expect(day.locator(`[data-task-id="${id}"]`).locator('xpath=..')).toHaveAttribute('data-lane-count', '4');
  await expect(day.getByTestId('plan-lane-more')).toHaveCount(0);
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
  await page.getByRole('button', { name: '周', exact: true }).click();
  const week = page.locator('[data-testid="time-band-day"][data-date="2026-10-16"]');
  const more = week.getByTestId('plan-lane-more');
  await more.scrollIntoViewIfNeeded();
  await expect(more).toHaveText('+3');
  await more.click();
  const dialog = page.getByRole('dialog', { name: '重叠任务' });
  await expect(dialog).toContainText('叠行丁');
  await expect(dialog).not.toContainText('叠行甲');
});

test('相邻时间点与午夜任务不遮挡后续任务或超出当天', async ({ page }) => {
  await e2eDatabase.task.createMany({ data: [
    { id: 'point-a', title: '十点提醒甲', scheduledStart: '2026-10-17T10:00', dueDate: '2026-10-17' },
    { id: 'point-b', title: '十点提醒乙', scheduledStart: '2026-10-17T10:00', dueDate: '2026-10-17' },
    { id: 'point-next', title: '十点半提醒', scheduledStart: '2026-10-17T10:30', dueDate: '2026-10-17' },
    { id: 'point-late-a', title: '午夜提醒甲', scheduledStart: '2026-10-18T23:59', dueDate: '2026-10-18' },
    { id: 'point-late-b', title: '午夜提醒乙', scheduledStart: '2026-10-18T23:59', dueDate: '2026-10-18' },
  ] });
  await page.goto('/#/plan');
  await expect(page.getByTestId('plan-stack')).toHaveCount(0);
  const saturday = page.locator('[data-testid="time-band-day"][data-date="2026-10-17"]');
  const next = saturday.locator('[data-task-id="point-next"]');
  const nextRect = await next.boundingBox();
  for (const id of ['point-a', 'point-b']) {
    const rect = await saturday.locator(`[data-task-id="${id}"]`).boundingBox();
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(nextRect!.y);
  }
  await expect(saturday.locator('[data-task-id="point-b"]').locator('xpath=..')).toHaveAttribute('data-lane-count', '2');
  const sunday = page.locator('[data-testid="time-band-day"][data-date="2026-10-18"]');
  const dayRect = await sunday.boundingBox();
  for (const id of ['point-late-a', 'point-late-b']) {
    const rect = await sunday.locator(`[data-task-id="${id}"]`).boundingBox();
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(dayRect!.y + dayRect!.height);
  }
  await next.getByRole('button', { name: '打开任务：十点半提醒', exact: true }).click();
  await expect(page.getByRole('button', { name: '安排时间', exact: true })).toContainText('10:30');
});

test('离开规划页后仍停在上次的日月周和日期', async ({ page }) => {
  const dates = () => page.getByTestId('time-band-day').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-date')));
  await page.goto('/#/plan');
  await expect(page.locator('[data-plan-mode="week"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '月', exact: true }).click();
  await page.goto('/#/inbox');
  await page.goto('/#/plan');
  await expect(page.locator('[data-plan-mode="month"]')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('[data-plan-mode="month"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '查看2026-10-18', exact: true }).click();
  await expect(page.locator('[data-plan-mode="day"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('time-band-day')).toHaveAttribute('data-date', '2026-10-18');
  await page.goto('/#/inbox');
  await page.goto('/#/plan');
  await expect(page.locator('[data-plan-mode="day"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('time-band-day')).toHaveAttribute('data-date', '2026-10-18');
  await page.getByTestId('plan-page').getByRole('button', { name: '今天', exact: true }).click();
  await expect(page.locator('[data-plan-mode="day"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('time-band-day')).toHaveAttribute('data-date', '2026-10-16');
  await page.goto('/#/inbox');
  await page.goto('/#/plan');
  await expect(page.locator('[data-plan-mode="day"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('time-band-day')).toHaveAttribute('data-date', '2026-10-16');
  await page.getByRole('button', { name: '周', exact: true }).click();
  await page.getByRole('button', { name: '下一段', exact: true }).click();
  await page.goto('/#/inbox');
  await page.goto('/#/plan');
  await expect(page.locator('[data-plan-mode="week"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await dates()).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  await page.evaluate(() => { localStorage.setItem('dovun.plan.mode', 'year'); localStorage.setItem('dovun.plan.anchor', '2026-02-31'); });
  await page.reload();
  await expect(page.locator('[data-plan-mode="week"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await dates()).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
});
