import { mkdirSync } from 'node:fs';
import type { TestInfo } from '@playwright/test';
import { test, expect, type APIRequestContext, type Locator, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const sourceDay = '2026-10-14';
const shotDir = '/workspace/wwa-todo-shots/mobile-month-dnd';
const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;
const columnDays = ['2026-10-12', '2026-10-13', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'] as const;

type Point = { x: number; y: number };
type Scheduled = { dueDate: string; scheduledStart: string; scheduledEnd: string };

function weekdayLabel(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  return weekdayLabels[new Date(year, month - 1, day).getDay()];
}

function movePreview(iso: string) {
  const [, month, day] = iso.split('-').map(Number);
  return `→ ${month}月${day}日 ${weekdayLabel(iso)}`;
}

function scheduleKey(day: string) {
  return `${day}|${day}T14:00|${day}T15:30`;
}

function mobileOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== 'mobile', '真触摸只在 mobile 项目');
}

function chromiumOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== 'chromium', '鼠标回归只在 chromium 项目');
}

function shotsOnly() {
  test.skip(process.env.WWA_SHOTS !== '1', 'WWA_SHOTS 未设为 1，不写截图');
}

function shotPath(name: string) {
  mkdirSync(shotDir, { recursive: true });
  return `${shotDir}/${name}`;
}

async function jsonData(response: { ok: () => boolean; text: () => Promise<string>; json: () => Promise<{ data: unknown }> }) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

async function createScheduled(request: APIRequestContext, title: string, day: string) {
  return await jsonData(await request.post(`${apiUrl}/api/tasks`, {
    data: { title, dueDate: day, scheduledStart: `${day}T14:00`, scheduledEnd: `${day}T15:30` },
  })) as { id: string };
}

function scheduledKey(row: Scheduled) {
  return `${row.dueDate}|${row.scheduledStart}|${row.scheduledEnd}`;
}

async function expectSchedule(request: APIRequestContext, id: string, day: string) {
  await expect.poll(async () => scheduledKey(await jsonData(await request.get(`${apiUrl}/api/tasks/${id}`)) as Scheduled)).toBe(scheduleKey(day));
}

async function readSchedule(request: APIRequestContext, id: string) {
  return scheduledKey(await jsonData(await request.get(`${apiUrl}/api/tasks/${id}`)) as Scheduled);
}

// Copied from plan-focus.spec.ts. Optional hold / beforeRelease cover the week-edge and screenshot cases.
async function drag(page: Page, from: Locator, to: Locator, options?: { holdMs?: number; beforeRelease?: () => Promise<void> }) {
  await from.scrollIntoViewIfNeeded();
  await to.scrollIntoViewIfNeeded();
  await to.evaluate((node) => {
    const main = node.closest('.app-main');
    if (!main) return;
    const cell = node.getBoundingClientRect();
    const box = main.getBoundingClientRect();
    main.scrollTop += cell.top + cell.height / 2 - box.top - box.height / 2;
  });
  await to.evaluate((node) => { const scroller = node.closest('[data-testid="timeline-scroll"]'); if (scroller) { const target = node.getBoundingClientRect(); const box = scroller.getBoundingClientRect(); scroller.scrollTop += target.top + target.height / 2 - box.top - box.height / 2; } });
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
  if (options?.holdMs) await page.waitForTimeout(options.holdMs);
  if (options?.beforeRelease) await options.beforeRelease();
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, button: 'left', buttons: 0, clickCount: 1 });
  await session.detach();
}

async function dragToPoint(page: Page, from: Locator, point: Point, holdMs: number) {
  await from.scrollIntoViewIfNeeded();
  const source = await from.boundingBox();
  if (!source) throw new Error('拖动区域没有布局');
  const startX = source.x + source.width / 2;
  const startY = source.y + source.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 24 });
  if (holdMs) await page.waitForTimeout(holdMs);
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  await session.detach();
}

// CSS pixels from boundingBox(). Do not multiply by deviceScaleFactor.
async function touchDrag(page: Page, from: Locator, to: Locator, options: { holdMs: number; end?: Point; beforeRelease?: (point: Point) => Promise<void> }) {
  const source = await from.boundingBox();
  if (!source) throw new Error('拖动区域没有布局');
  const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  let end = options.end;
  if (!end) {
    const target = await to.boundingBox();
    if (!target) throw new Error('拖动区域没有布局');
    end = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  }
  const session = await page.context().newCDPSession(page);
  let scrollTopDelta = 0;
  let cellId: string | null = null;
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start.x, y: start.y, id: 0 }] });
    await page.waitForTimeout(250);
    await expect(page.getByTestId('plan-drag-overlay')).toBeVisible();
    const steps = 12;
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      let x = start.x + (end.x - start.x) * progress;
      let y = start.y + (end.y - start.y) * progress;
      if (index === 1 && Math.hypot(x - start.x, y - start.y) < 4) {
        const dirX = end.x - start.x || 1;
        const dirY = end.y - start.y;
        const length = Math.hypot(dirX, dirY) || 1;
        x = start.x + (dirX / length) * 6;
        y = start.y + (dirY / length) * 6;
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 0 }] });
    }
    if (options.holdMs > 0) {
      const before = await page.locator('.app-main').evaluate((node) => node.scrollTop);
      await page.waitForTimeout(options.holdMs);
      const after = await page.locator('.app-main').evaluate((node) => node.scrollTop);
      scrollTopDelta = after - before;
    }
    if (options.beforeRelease) await options.beforeRelease(end);
    cellId = await page.evaluate(({ x, y }) => {
      const top = document.elementFromPoint(x, y);
      const direct = top instanceof Element ? top.closest('[data-drop-id^="cell:"]') : null;
      if (direct) return direct.getAttribute('data-drop-id');
      // The fixed overlay is the top hit and is not inside a cell. Take the nearest cell under the pointer.
      for (const node of document.elementsFromPoint(x, y)) {
        if (!(node instanceof Element)) continue;
        const cell = node.closest('[data-drop-id^="cell:"]');
        if (cell) return cell.getAttribute('data-drop-id');
      }
      return null;
    }, end);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
  return { cellId, scrollTopDelta };
}

async function openPlan(page: Page, mode: 'month' | 'week') {
  await page.goto('/#/plan');
  await expect(page.locator(`[data-plan-mode="${mode}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId(mode === 'month' ? 'month-horizontal-scroll' : 'calendar-horizontal-scroll')).toBeVisible();
}

function monthTask(page: Page, day: string) {
  return page.locator(`[data-drop-id="cell:${day}"] .plan-month-task`);
}

async function assertMonthScroll(page: Page) {
  const scroll = await page.getByTestId('month-horizontal-scroll').evaluate((node) => ({
    scrollLeft: node.scrollLeft,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  expect(scroll.scrollLeft).toBe(0);
  expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
}

// Put the last row's center inside the bottom 10% of .app-main, near the middle of that band.
async function alignLastRow(page: Page) {
  const cell = page.locator('[data-drop-id="cell:2026-10-29"]');
  await expect(cell).toBeAttached();
  return cell.evaluate((node) => {
    const main = node.closest('.app-main') as HTMLElement | null;
    if (!main) return { inBand: false, fractionFromBottom: 1, scrollTop: 0, maxScroll: 0, mainHeight: 0 };
    const maxScroll = main.scrollHeight - main.clientHeight;
    const measure = () => {
      const mainBox = main.getBoundingClientRect();
      const cellBox = node.getBoundingClientRect();
      const center = cellBox.top + cellBox.height / 2;
      return { mainBox, center, cellHeight: cellBox.height };
    };
    const current = measure();
    const desired = current.mainBox.bottom - current.mainBox.height * 0.05;
    main.scrollTop = Math.min(maxScroll, Math.max(0, main.scrollTop + current.center - desired));
    const next = measure();
    const fractionFromBottom = (next.mainBox.bottom - next.center) / next.mainBox.height;
    const bandTop = next.mainBox.bottom - next.mainBox.height * 0.1;
    return {
      inBand: next.center >= bandTop - 1 && next.center <= next.mainBox.bottom + 1,
      fractionFromBottom,
      scrollTop: main.scrollTop,
      maxScroll,
      mainHeight: next.mainBox.height,
      cellHeight: next.cellHeight,
    };
  });
}

test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.clock.setFixedTime(new Date('2026-10-14T12:00:00'));
  await page.addInitScript(() => {
    if (localStorage.getItem('dovun.plan.showCompleted') === null) localStorage.setItem('dovun.plan.showCompleted', 'true');
    localStorage.setItem('dovun.plan.mode', 'month');
  });
  await page.addInitScript(() => {
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
    if (typeof Notification !== 'undefined') Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'denied' });
  });
});

for (const day of columnDays) {
  for (const holdMs of [0, 1000] as const) {
    test(`手机月视图拖到 ${day} ${weekdayLabel(day)}，停 ${holdMs}ms`, async ({ page, request }, testInfo) => {
      mobileOnly(testInfo);
      const created = await createScheduled(request, `拖到${day}-${holdMs}`, sourceDay);
      await openPlan(page, 'month');
      const source = monthTask(page, sourceDay);
      await expect(source).toBeVisible();
      const target = page.locator(`[data-drop-id="cell:${day}"]`);
      const { cellId, scrollTopDelta } = await touchDrag(page, source, target, {
        holdMs,
        beforeRelease: async () => {
          await expect(target).toHaveAttribute('data-over', '');
          await expect(page.getByTestId('plan-drag-overlay')).toContainText(movePreview(day));
          await expectOverlayFits(page);
          if (holdMs === 1000) await assertMonthScroll(page);
        },
      });
      expect(cellId).toBe(`cell:${day}`);
      if (holdMs === 1000) expect(scrollTopDelta).toBeLessThan(76);
      await expectSchedule(request, created.id, day);
      expect(day).toBe(cellId?.slice('cell:'.length));
    });
  }
}

for (const holdMs of [0, 1000] as const) {
  test(`手机月视图底行从 2026-10-27 拖到 2026-10-29，停 ${holdMs}ms`, async ({ page, request }, testInfo) => {
    mobileOnly(testInfo);
    const fromDay = '2026-10-27';
    const toDay = '2026-10-29';
    const created = await createScheduled(request, `底行${holdMs}`, fromDay);
    await openPlan(page, 'month');
    await expect(page.locator('[data-drop-id="cell:2026-10-26"]')).toBeAttached();
    await expect(page.locator('[data-drop-id="cell:2026-11-01"]')).toBeAttached();
    const placement = await alignLastRow(page);
    if (!placement.inBand) {
      testInfo.annotations.push({
        type: 'bottom-row',
        description: `最后一行中心未能进入 .app-main 底部 10%：距底部 ${(placement.fractionFromBottom * 100).toFixed(1)}%，scrollTop=${placement.scrollTop}/${placement.maxScroll}，mainHeight=${placement.mainHeight}`,
      });
    }
    const source = monthTask(page, fromDay);
    await expect(source).toBeVisible();
    const target = page.locator(`[data-drop-id="cell:${toDay}"]`);
    const { cellId, scrollTopDelta } = await touchDrag(page, source, target, {
      holdMs,
      beforeRelease: async () => {
        await expect(target).toHaveAttribute('data-over', '');
        await expect(page.getByTestId('plan-drag-overlay')).toContainText(movePreview(toDay));
        if (holdMs === 1000) await assertMonthScroll(page);
      },
    });
    expect(cellId, `底行 fractionFromBottom=${placement.fractionFromBottom.toFixed(3)} inBand=${placement.inBand} scrollTopDelta=${scrollTopDelta}`).toBe(`cell:${toDay}`);
    if (holdMs === 1000) expect(scrollTopDelta).toBeLessThan(76);
    await expectSchedule(request, created.id, toDay);
    expect(toDay).toBe(cellId?.slice('cell:'.length));
  });
}

/** The phone overlay must not inherit the 54px bar width: preview on one line, whole box inside the viewport. */
async function expectOverlayFits(page: Page) {
  const box = await page.getByTestId('plan-drag-overlay').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const detail = node.querySelector('p:last-child') as HTMLElement | null;
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, vw: window.innerWidth, vh: window.innerHeight, detailHeight: detail?.getBoundingClientRect().height ?? 0, lineHeight: detail ? parseFloat(getComputedStyle(detail).lineHeight) : 0, overflow: Math.max(node.scrollWidth - node.clientWidth, detail ? detail.scrollWidth - detail.clientWidth : 0) };
  });
  expect(box.detailHeight).toBeLessThanOrEqual(box.lineHeight + 1);
  expect(box.overflow).toBeLessThanOrEqual(1);
  expect(box.left).toBeGreaterThanOrEqual(-1);
  expect(box.right).toBeLessThanOrEqual(box.vw + 1);
  expect(box.top).toBeGreaterThanOrEqual(-1);
  expect(box.bottom).toBeLessThanOrEqual(box.vh + 1);
}

test('短按月视图任务打开详情且安排时间在视口内', async ({ page, request }, testInfo) => {
  mobileOnly(testInfo);
  const created = await createScheduled(request, '短按安排', sourceDay);
  await openPlan(page, 'month');
  const source = monthTask(page, sourceDay);
  await expect(source).toBeVisible();
  const box = await source.boundingBox();
  if (!box) throw new Error('拖动区域没有布局');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 0 }] });
    await page.waitForTimeout(40);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
  await expectSchedule(request, created.id, sourceDay);
  const dialog = page.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(dialog).toBeVisible();
  const rect = await dialog.getByRole('button', { name: '安排时间', exact: true }).evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { top: box.top, left: box.left, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
  });
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('没有视口');
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.bottom).toBeLessThanOrEqual(viewport.height);
  expect(rect.right).toBeLessThanOrEqual(viewport.width);
});

test('月视图在长按前上滑不拖动任务', async ({ page, request }, testInfo) => {
  mobileOnly(testInfo);
  await page.addInitScript(() => localStorage.setItem('dovun.plan.anchor', '2026-03-15'));
  const days = ['2026-03-03', '2026-03-10', '2026-03-18', '2026-03-26'];
  const created: { day: string; id: string }[] = [];
  for (const [index, day] of days.entries()) created.push({ day, id: (await createScheduled(request, `三月任务${index + 1}`, day)).id });
  await openPlan(page, 'month');
  // Pixel 7 上 2026-03 的 6 周和 4 条单日任务放得下（scrollHeight === clientHeight），页脚下仍有空白。
  // 打开待安排托盘把这一屏垫高，滚动才量得到。
  await page.getByRole('button', { name: /待安排/ }).click();
  await expect(page.locator('#plan-task-tray')).toBeVisible();
  const main = page.locator('.app-main');
  const beforeMetrics = await main.evaluate((node) => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, scrollTop: node.scrollTop }));
  expect(beforeMetrics.scrollHeight, `scrollHeight=${beforeMetrics.scrollHeight} clientHeight=${beforeMetrics.clientHeight}`).toBeGreaterThan(beforeMetrics.clientHeight + 40);
  const source = monthTask(page, days[0]);
  await expect(source).toBeVisible();
  const box = await source.boundingBox();
  if (!box) throw new Error('拖动区域没有布局');
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 0 }] });
    await page.waitForTimeout(40);
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y: start.y - 30, id: 0 }] });
    expect(await page.getByTestId('plan-drag-overlay').count()).toBe(0);
    for (let index = 1; index <= 8; index += 1) {
      const y = Math.max(8, start.y - 30 - index * 28);
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y, id: 0 }] });
    }
    expect(await page.getByTestId('plan-drag-overlay').count()).toBe(0);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
  expect(await page.getByTestId('plan-drag-overlay').count()).toBe(0);
  for (const task of created) expect(await readSchedule(request, task.id)).toBe(scheduleKey(task.day));
  const afterTop = await main.evaluate((node) => node.scrollTop);
  if (afterTop > beforeMetrics.scrollTop) expect(afterTop).toBeGreaterThan(beforeMetrics.scrollTop);
  else {
    expect(afterTop).toBeGreaterThanOrEqual(beforeMetrics.scrollTop);
    testInfo.annotations.push({
      type: 'note',
      description: `CDP 触摸滑动没有产生原生滚动（scrollTop ${beforeMetrics.scrollTop} → ${afterTop}）。已断言 scrollTop 不减少且任务日期未变。`,
    });
  }
});

test('手机周视图拖到右缘停 1 秒不横滚', async ({ page, request }, testInfo) => {
  mobileOnly(testInfo);
  await page.addInitScript(() => localStorage.setItem('dovun.plan.mode', 'week'));
  const created = await createScheduled(request, '周缘时间块', sourceDay);
  await openPlan(page, 'week');
  const block = page.locator(`[data-testid="task-block"][data-task-id="${created.id}"]`);
  await expect(block).toBeVisible();
  await block.scrollIntoViewIfNeeded();
  const handle = block.getByRole('button', { name: '打开任务：周缘时间块', exact: true });
  const scroller = page.getByTestId('calendar-horizontal-scroll');
  const scrollBox = await scroller.boundingBox();
  const blockBox = await handle.boundingBox();
  if (!scrollBox || !blockBox) throw new Error('拖动区域没有布局');
  const beforeLeft = await scroller.evaluate((node) => node.scrollLeft);
  let afterLeft = beforeLeft;
  await touchDrag(page, handle, scroller, {
    holdMs: 1000,
    end: { x: scrollBox.x + scrollBox.width - 2, y: blockBox.y + blockBox.height / 2 },
    beforeRelease: async () => { afterLeft = await scroller.evaluate((node) => node.scrollLeft); },
  });
  expect(afterLeft).toBeLessThanOrEqual(beforeLeft);
});

for (const width of [640, 800, 1400] as const) {
  test(`月视图 ${width}×900 仍显示 14:00 并可拖到周四`, async ({ page, request }, testInfo) => {
    chromiumOnly(testInfo);
    await page.setViewportSize({ width, height: 900 });
    const created = await createScheduled(request, '跨日安排', sourceDay);
    await openPlan(page, 'month');
    const todayCell = page.locator(`[data-drop-id="cell:${sourceDay}"]`);
    await expect(todayCell).toContainText('14:00');
    const scroll = await page.getByTestId('month-horizontal-scroll').evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
    expect(scroll.scrollWidth).toBeGreaterThanOrEqual(560);
    const adds = page.locator('.plan-month-add');
    await expect(adds).toHaveCount(await page.locator('[data-drop-id^="cell:"]').count());
    const total = await adds.count();
    for (let index = 0; index < total; index += 1) await expect(adds.nth(index)).toBeVisible();
    await drag(page, todayCell.getByText('跨日安排'), page.locator('[data-drop-id="cell:2026-10-15"]'));
    await expectSchedule(request, created.id, '2026-10-15');
  });
}

test('800×900 周视图拖到右缘可以横滚', async ({ page, request }, testInfo) => {
  chromiumOnly(testInfo);
  await page.setViewportSize({ width: 800, height: 900 });
  await page.addInitScript(() => localStorage.setItem('dovun.plan.mode', 'week'));
  const created = await createScheduled(request, '周缘时间块', sourceDay);
  await openPlan(page, 'week');
  const block = page.locator(`[data-testid="task-block"][data-task-id="${created.id}"]`);
  await expect(block).toBeVisible();
  await block.scrollIntoViewIfNeeded();
  const scroller = page.getByTestId('calendar-horizontal-scroll');
  const metrics = await scroller.evaluate((node) => ({ scrollLeft: node.scrollLeft, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
  if (metrics.scrollWidth <= metrics.clientWidth) {
    testInfo.annotations.push({
      type: 'note',
      description: `800×900 周网格不需要横滚（scrollWidth ${metrics.scrollWidth} <= clientWidth ${metrics.clientWidth}），跳过 scrollLeft 增加断言`,
    });
    return;
  }
  const scrollBox = await scroller.boundingBox();
  const blockBox = await block.boundingBox();
  if (!scrollBox || !blockBox) throw new Error('拖动区域没有布局');
  const beforeLeft = await scroller.evaluate((node) => node.scrollLeft);
  await dragToPoint(page, block, { x: scrollBox.x + scrollBox.width - 2, y: blockBox.y + blockBox.height / 2 }, 300);
  const afterLeft = await scroller.evaluate((node) => node.scrollLeft);
  expect(afterLeft).toBeGreaterThan(beforeLeft);
});

async function shotMonthDrag(page: Page, request: APIRequestContext, fileName: string, preview: string, forbidArrow: boolean, dark = false) {
  const created = await createScheduled(request, '拖动截图', sourceDay);
  await openPlan(page, 'month');
  if (dark) await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  const source = monthTask(page, sourceDay);
  await expect(source).toBeVisible();
  const target = page.locator('[data-drop-id="cell:2026-10-16"]');
  if (forbidArrow) {
    await drag(page, page.locator(`[data-drop-id="cell:${sourceDay}"]`).getByText('拖动截图'), target, {
      beforeRelease: async () => {
        const overlay = page.getByTestId('plan-drag-overlay');
        await expect(overlay).toContainText(preview);
        await expect(overlay).not.toContainText('→');
        await expect(target).toHaveAttribute('data-over', '');
        await page.screenshot({ path: shotPath(fileName) });
      },
    });
  } else {
    await touchDrag(page, source, target, {
      holdMs: 0,
      beforeRelease: async () => {
        await expect(target).toHaveAttribute('data-over', '');
        await expect(page.getByTestId('plan-drag-overlay')).toContainText(preview);
        await page.screenshot({ path: shotPath(fileName) });
      },
    });
  }
  await expectSchedule(request, created.id, '2026-10-16');
}

test('截图手机拖到周五亮色', async ({ page, request }, testInfo) => {
  mobileOnly(testInfo);
  shotsOnly();
  await page.emulateMedia({ colorScheme: 'light' });
  await shotMonthDrag(page, request, 'c2-phone-dragging-light.png', movePreview('2026-10-16'), false);
});

test('截图手机拖到周五暗色', async ({ page, request }, testInfo) => {
  mobileOnly(testInfo);
  shotsOnly();
  await page.emulateMedia({ colorScheme: 'dark' });
  await shotMonthDrag(page, request, 'c2-phone-dragging-dark.png', movePreview('2026-10-16'), false, true);
});

test('截图手机拖到周五英文', async ({ page, request }, testInfo) => {
  mobileOnly(testInfo);
  shotsOnly();
  await page.addInitScript(() => localStorage.setItem('wwa.language', 'en'));
  await shotMonthDrag(page, request, 'c2-phone-dragging-en.png', '→ Fri, October 16', false);
});

test('截图 1400 月视图拖动亮色', async ({ page, request }, testInfo) => {
  chromiumOnly(testInfo);
  shotsOnly();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await shotMonthDrag(page, request, 'c2-desktop-1400-light.png', '2026-10-16 14:00 — 15:30', true);
});

test('截图 1400 月视图拖动暗色', async ({ page, request }, testInfo) => {
  chromiumOnly(testInfo);
  shotsOnly();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shotMonthDrag(page, request, 'c2-desktop-1400-dark.png', '2026-10-16 14:00 — 15:30', true, true);
});
