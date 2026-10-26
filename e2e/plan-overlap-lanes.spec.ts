import { test, expect, type Locator, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const day = '2026-10-16';

test.use({ timezoneId: 'Asia/Shanghai' });
test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.clock.setFixedTime(new Date('2026-10-16T13:00:00+08:00'));
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

const at = (time: string, date = day) => `${date}T${time}`;
/** The scenario from the requirement screenshot: three tasks chained from 15:00 to 17:00, the 15:00–16:00 one completed. */
async function seedScreenshotScenario() {
  await e2eDatabase.task.createMany({ data: [
    { id: 'bug-8925', title: '[BUGONLINE-8925] 抖音-在抖音平台使用青鸟协同智能退款时，退款原因映射不正确', scheduledStart: at('14:00'), scheduledEnd: at('15:00'), dueDate: day },
    { id: 'bug-10799', title: '[BUGONLINE-10799] 淘宝+青鸟工单登记时有消息提醒，但列表不刷新', scheduledStart: at('14:00'), scheduledEnd: at('15:00'), dueDate: day },
    { id: 'qps', title: '统计qps', scheduledStart: at('15:00'), scheduledEnd: at('16:00'), dueDate: day, status: 'done' },
    { id: 'alipay', title: '支付宝批量打款接口评估', scheduledStart: at('15:00'), scheduledEnd: at('16:30'), dueDate: day },
    { id: 'bugfix', title: 'bug修复', scheduledStart: at('16:00'), scheduledEnd: at('17:00'), dueDate: day },
  ] });
}
const column = (page: Page, date = day) => page.locator(`[data-testid="time-band-day"][data-date="${date}"]`);
const card = (scope: Locator, id: string) => scope.locator(`[data-testid="task-block"][data-task-id="${id}"]`).locator('xpath=..');
async function lanes(scope: Locator, id: string) {
  const node = card(scope, id);
  return { lane: Number(await node.getAttribute('data-lane')), count: Number(await node.getAttribute('data-lane-count')) };
}
async function scrollTo(page: Page, hour: number) {
  await page.getByTestId('timeline-scroll').evaluate((node, value) => { node.scrollTop = value * 56; }, hour);
}
async function openDay(page: Page) {
  await page.goto('/#/plan');
  await page.getByRole('button', { name: '日', exact: true }).click();
  await expect(page.locator('[data-plan-mode="day"]')).toHaveAttribute('aria-pressed', 'true');
}
/** Every visible card and +N chip in a column stays inside the task lane and none overlap. */
async function expectNoCollisions(scope: Locator) {
  const problems = await scope.evaluate((node) => {
    const lane = node.querySelector('[data-testid="plan-task-lane"]')!.getBoundingClientRect();
    const items = [...node.querySelectorAll('[data-testid="plan-task-lane"] > *')].map((element) => ({ rect: element.getBoundingClientRect(), name: (element.textContent ?? '').trim().slice(0, 12) }));
    const out: string[] = [];
    for (const item of items) if (item.rect.left < lane.left - 0.5 || item.rect.right > lane.right + 0.5) out.push(`溢出 ${item.name}`);
    for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i].rect; const b = items[j].rect;
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) out.push(`${items[i].name} × ${items[j].name}`);
    }
    return out;
  });
  expect(problems).toEqual([]);
}

test('截图场景：三条分成两条泳道，完成状态不改变既有左右顺序', async ({ page }) => {
  await seedScreenshotScenario();
  await openDay(page);
  await page.getByLabel('显示已完成', { exact: true }).check();
  const col = column(page);
  await scrollTo(page, 13);
  await expect(page.getByTestId('plan-stack')).toHaveCount(0);
  await expect(card(col, 'qps')).toBeVisible();
  expect(await lanes(col, 'alipay')).toEqual({ lane: 0, count: 2 });
  expect(await lanes(col, 'qps')).toEqual({ lane: 1, count: 2 });
  expect(await lanes(col, 'bugfix')).toEqual({ lane: 1, count: 2 });
  // Same start and length: ids break the tie, so bug-10799 sorts first.
  expect(await lanes(col, 'bug-10799')).toEqual({ lane: 0, count: 2 });
  expect(await lanes(col, 'bug-8925')).toEqual({ lane: 1, count: 2 });
  await expect(col.getByTestId('plan-lane-more')).toHaveCount(0);
  await expectNoCollisions(col);
  const left = (await card(col, 'alipay').boundingBox())!;
  const right = (await card(col, 'qps').boundingBox())!;
  expect(right.x).toBeGreaterThan(left.x + left.width - 1);

  await page.getByLabel('显示已完成', { exact: true }).uncheck();
  await expect(card(col, 'qps')).toHaveCount(0);
  expect(await lanes(col, 'alipay')).toEqual({ lane: 0, count: 2 });
  expect(await lanes(col, 'bugfix')).toEqual({ lane: 1, count: 2 });
  await col.getByLabel('完成任务：bug修复', { exact: true }).click();
  await expect(card(col, 'bugfix')).toHaveCount(0);
  await expect.poll(() => lanes(col, 'alipay')).toEqual({ lane: 0, count: 1 });
});

test('链式重叠复用泳道，五条以上并排，窄列出现 +N 并能用键盘打开操作', async ({ page }) => {
  await e2eDatabase.task.createMany({ data: [
    { id: 'chain-a', title: 'A 梳理需求', scheduledStart: at('09:00'), scheduledEnd: at('10:00'), dueDate: day },
    { id: 'chain-b', title: 'B 联调沙箱', scheduledStart: at('09:30'), scheduledEnd: at('11:00'), dueDate: day },
    { id: 'chain-c', title: 'C 评审材料', scheduledStart: at('10:30'), scheduledEnd: at('11:30'), dueDate: day },
    ...['甲', '乙', '丙', '丁', '戊', '己'].map((name, index) => ({ id: `heavy-${index}`, title: `并行${name}`, scheduledStart: at(index === 5 ? '14:15' : '14:00'), scheduledEnd: at('15:30'), dueDate: day })),
  ] });
  await openDay(page);
  const col = column(page);
  await scrollTo(page, 8.5);
  expect(await lanes(col, 'chain-a')).toEqual({ lane: 0, count: 2 });
  expect(await lanes(col, 'chain-b')).toEqual({ lane: 1, count: 2 });
  expect(await lanes(col, 'chain-c')).toEqual({ lane: 0, count: 2 });
  await scrollTo(page, 13.5);
  const laneWidth = await col.getByTestId('plan-task-lane').evaluate((node) => node.clientWidth);
  const fits = Math.max(2, Math.floor(laneWidth / 56));
  if (fits >= 6) {
    await expect(col.getByTestId('plan-lane-more')).toHaveCount(0);
    for (let index = 0; index < 6; index += 1) expect((await lanes(col, `heavy-${index}`)).count).toBe(6);
  }
  await expectNoCollisions(col);

  await page.getByRole('button', { name: '周', exact: true }).click();
  const week = column(page);
  await scrollTo(page, 13.5);
  const more = week.getByTestId('plan-lane-more');
  await expect(more).toHaveCount(1);
  await more.scrollIntoViewIfNeeded();
  const weekWidth = await week.getByTestId('plan-task-lane').evaluate((node) => node.clientWidth);
  const weekCap = Math.max(2, Math.floor(weekWidth / 56));
  await expect(more).toHaveText(`+${6 - (weekCap - 1)}`);
  await expect(more).toHaveAttribute('aria-label', new RegExp(`^还有 ${6 - (weekCap - 1)} 个重叠任务，14:00–15:30`));
  await expectNoCollisions(week);
  await more.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '重叠任务' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('并行己');
  await expect(dialog).not.toContainText('并行甲');
  await dialog.getByLabel('完成任务：并行己', { exact: true }).click();
  await expect(dialog).not.toContainText('并行己');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(more).toBeFocused();
  await expect(more).toHaveText(`+${5 - (weekCap - 1)}`);
  await more.click();
  await dialog.getByRole('button', { name: /并行戊/ }).click();
  await expect(page.getByRole('button', { name: '安排时间', exact: true })).toContainText('14:00');
});

test('1024 宽并打开 AI 助手时日、周视图卡片不重叠、不溢出', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '桌面侧栏布局');
  await seedScreenshotScenario();
  await page.setViewportSize({ width: 1024, height: 800 });
  await openDay(page);
  await page.getByLabel('显示已完成', { exact: true }).check();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.locator('[data-assistant-open]')).toHaveCount(1);
  for (const span of ['日', '周'] as const) {
    await page.getByRole('button', { name: span, exact: true }).click();
    await scrollTo(page, 13.5);
    const col = column(page);
    await expect(card(col, 'alipay')).toBeVisible();
    await expectNoCollisions(col);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1025);
  }
  // Week columns sit at the 760px minimum here: two lanes are kept, so both chained tasks stay visible.
  expect((await lanes(column(page), 'alipay')).count).toBe(2);
});

test('拖动泳道里的任务只改时间，拖进拥挤时段不会中断，另一条恢复整宽', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '鼠标拖动；触屏安排由详情编辑覆盖');
  await e2eDatabase.task.createMany({ data: [
    { id: 'pair-a', title: '并排甲', scheduledStart: at('10:00'), scheduledEnd: at('11:00'), dueDate: day },
    { id: 'pair-b', title: '并排乙', scheduledStart: at('10:00'), scheduledEnd: at('11:00'), dueDate: day },
    { id: 'busy-a', title: '拥挤甲', scheduledStart: at('14:00'), scheduledEnd: at('16:00'), dueDate: day },
    { id: 'busy-b', title: '拥挤乙', scheduledStart: at('14:00'), scheduledEnd: at('16:00'), dueDate: day },
  ] });
  await page.goto('/#/plan');
  const col = column(page);
  await scrollTo(page, 9.5);
  expect(await lanes(col, 'pair-b')).toEqual({ lane: 1, count: 2 });
  const drag = async (id: string, slot: string) => {
    const from = (await card(col, id).locator('article').getByRole('button', { name: /^打开任务/ }).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 2, from.y + from.height / 2 + 8, { steps: 3 });
    const target = col.locator(`[data-drop-id="slot:${day}:${slot}"]`);
    const to = (await target.boundingBox())!;
    await page.mouse.move(to.x + 6, to.y + to.height / 2, { steps: 20 });
    await page.mouse.up();
  };
  await drag('pair-b', '12:00');
  await expect.poll(async () => (await (await page.request.get(`${apiUrl}/api/tasks/pair-b`)).json()).data.scheduledStart).toBe(`${day}T12:00`);
  await expect.poll(() => lanes(col, 'pair-a')).toEqual({ lane: 0, count: 1 });
  // Wait for the save to finish; cards cannot be dragged while it is in flight.
  await expect(col.locator('[data-task-id="pair-a"]').getByRole('checkbox')).toBeEnabled();
  // The refetch after the first save can re-render the card mid-press; retry the gesture until it lands.
  await expect(async () => {
    await drag('pair-a', '14:00');
    await expect.poll(async () => (await (await page.request.get(`${apiUrl}/api/tasks/pair-a`)).json()).data.scheduledStart, { timeout: 2000 }).toBe(`${day}T14:00`);
  }).toPass({ timeout: 15_000 });
  await expect(col.getByTestId('plan-lane-more')).toBeVisible();
  await expectNoCollisions(col);
});


test('父子默认相邻，水平换列持久化且不改排期或清单顺序', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '鼠标水平换列');
  await e2eDatabase.task.createMany({ data: [
    { id: 'a-parent', title: '主任务', scheduledStart: at('10:00'), scheduledEnd: at('11:00'), dueDate: day, sortOrder: 0 },
    { id: 'b-child', title: '子任务', parentId: 'a-parent', scheduledStart: at('10:00'), scheduledEnd: at('11:00'), dueDate: day, sortOrder: 0 },
    { id: 'z-other', title: '其他任务', scheduledStart: at('10:00'), scheduledEnd: at('11:00'), dueDate: day, sortOrder: 0 },
  ] });
  await openDay(page);
  await page.getByLabel('显示已完成', { exact: true }).check();
  const col = column(page);
  await scrollTo(page, 9.5);
  expect(await lanes(col, 'a-parent')).toEqual({ lane: 0, count: 3 });
  expect(await lanes(col, 'b-child')).toEqual({ lane: 1, count: 3 });
  expect(await lanes(col, 'z-other')).toEqual({ lane: 2, count: 3 });

  const source = (await card(col, 'b-child').locator('article').getByRole('button', { name: /^打开任务/ }).boundingBox())!;
  const target = (await card(col, 'a-parent').boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 - 20, source.y + source.height / 2, { steps: 4 });
  await page.mouse.move(target.x + target.width * 0.25, target.y + target.height / 2, { steps: 16 });
  await expect(card(col, 'a-parent').locator('article')).toHaveAttribute('data-lane-drop', 'before');
  await page.mouse.up();

  await expect.poll(() => lanes(col, 'b-child')).toEqual({ lane: 0, count: 3 });
  expect(await lanes(col, 'a-parent')).toEqual({ lane: 1, count: 3 });
  expect(await lanes(col, 'z-other')).toEqual({ lane: 2, count: 3 });
  const child = (await (await page.request.get(`${apiUrl}/api/tasks/b-child`)).json()).data;
  expect(child).toMatchObject({ scheduledStart: at('10:00'), scheduledEnd: at('11:00'), dueDate: day, parentId: 'a-parent', sortOrder: 0 });

  await page.reload();
  await expect.poll(() => lanes(column(page), 'b-child')).toEqual({ lane: 0, count: 3 });
  expect(await lanes(column(page), 'a-parent')).toEqual({ lane: 1, count: 3 });
  await column(page).getByLabel('完成任务：子任务', { exact: true }).click();
  await page.getByRole('dialog', { name: '确认连带修改' }).getByRole('button', { name: '确认影响并执行', exact: true }).click();
  await expect(column(page).getByLabel('重开任务：子任务', { exact: true })).toBeVisible();
  expect(await lanes(column(page), 'b-child')).toEqual({ lane: 0, count: 3 });
  await expectNoCollisions(column(page));
});
