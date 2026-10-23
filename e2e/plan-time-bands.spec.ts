import { createHash } from 'node:crypto';
import { test, expect, type Locator, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const fixedTime = '2026-10-12T10:00:00+08:00';
const work = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '工作',
  startMinute: 540,
  endMinute: 1080,
  weekdays: [1, 2, 3, 4, 5],
  color: 'blue',
};
const lunch = {
  id: '00000000-0000-4000-8000-000000000002',
  name: '午休',
  startMinute: 720,
  endMinute: 780,
  weekdays: [1, 2, 3, 4, 5],
  color: 'green',
};
const csrf = createHash('sha256').update('csrf:wwa-e2e-owner-session').digest('hex');

test.use({ timezoneId: 'Asia/Shanghai' });

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { if (localStorage.getItem('dovun.plan.showCompleted') === null) localStorage.setItem('dovun.plan.showCompleted', 'true'); });
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.addInitScript(() => {
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
  });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

async function saveBands(request: { put: (url: string, options: { data: unknown }) => Promise<{ ok: () => boolean; text: () => Promise<string> }> }, bands: unknown[]) {
  const response = await request.put(`${apiUrl}/api/plan/time-bands`, { data: { bands } });
  expect(response.ok(), await response.text()).toBe(true);
}

async function openPlan(page: Page) {
  await page.goto('/#/plan');
  await expect(page.getByRole('heading', { name: '规划', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '日', exact: true }).click();
}

async function switchDark(page: Page, project: string) {
  if (project === 'mobile') await page.goto('/#/more');
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.getByRole('menuitem', { name: '深色' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  if (project === 'mobile') await page.goto('/#/plan');
}

test('日视图按重叠规则绘制不透明背景', async ({ page, request }, testInfo) => {
  await saveBands(request, [work, lunch]);
  await openPlan(page);
  const day = page.locator('[data-testid="time-band-day"][data-date="2026-10-12"]');
  const segments = day.getByTestId('time-band-segment');
  await expect(segments).toHaveCount(3);
  expect(await segments.evaluateAll(nodes => nodes.map(node => {
    const element = node as HTMLElement;
    return {
      start: element.dataset.startMinute,
      end: element.dataset.endMinute,
      top: element.style.top,
      height: element.style.height,
    };
  }))).toEqual([
    { start: '540', end: '720', top: '504px', height: '168px' },
    { start: '720', end: '780', top: '672px', height: '56px' },
    { start: '780', end: '1080', top: '728px', height: '280px' },
  ]);
  await expect(segments.nth(0)).toHaveCSS('background-color', 'rgb(234, 242, 255)');
  await expect(segments.nth(1)).toHaveCSS('background-color', 'rgb(234, 247, 239)');
  await expect(day.getByTestId('time-band-layer')).toHaveCSS('pointer-events', 'none');
  await expect(day.locator('[data-testid="time-band-label"][aria-label="工作 09:00–18:00"]')).toHaveCount(1);
  await expect(day.locator('[data-testid="time-band-label"][aria-label="午休 12:00–13:00"]')).toHaveCount(1);
  await expect(day.getByTestId('time-band-label').first()).toHaveAttribute('data-label-mode', 'both');
  await expect(segments.nth(2)).not.toContainText('工作');
  if (testInfo.project.name === 'chromium') await page.screenshot({ path: '/tmp/wwa-plan-time-bands-light-day.png' });

  await switchDark(page, testInfo.project.name);
  const darkDay = page.locator('[data-testid="time-band-day"][data-date="2026-10-12"]');
  const darkSegments = darkDay.getByTestId('time-band-segment');
  await expect(darkSegments.nth(0)).toHaveCSS('background-color', 'rgb(24, 38, 61)');
  await expect(darkSegments.nth(1)).toHaveCSS('background-color', 'rgb(24, 45, 37)');
  if (testInfo.project.name === 'chromium') await page.screenshot({ path: '/tmp/wwa-plan-time-bands-dark-day.png' });
});

test('从空状态添加后重新加载仍保持名称、时间、星期和颜色', async ({ page }) => {
  await openPlan(page);
  await page.getByRole('button', { name: '时间段', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '时间段分组' });
  await expect(dialog.getByText('还没有时间段，添加后会显示在日、周时间轴上。')).toBeVisible();
  await dialog.getByRole('button', { name: '添加时间段', exact: true }).click();
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('晚间');
  await dialog.getByRole('textbox', { name: '开始时间', exact: true }).fill('18:00');
  await dialog.getByRole('textbox', { name: '结束时间', exact: true }).fill('21:00');
  await dialog.getByRole('button', { name: '周六', exact: true }).click();
  await dialog.getByRole('button', { name: '橙色', exact: true }).click();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('时间段已保存')).toBeVisible();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.locator('[data-testid="time-band-day"][data-date="2026-10-12"]').getByTestId('time-band-segment')).toHaveCount(1);
  await page.getByRole('button', { name: '时间段', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('晚间');
  await expect(dialog.getByRole('textbox', { name: '开始时间', exact: true })).toHaveValue('18:00');
  await expect(dialog.getByRole('textbox', { name: '结束时间', exact: true })).toHaveValue('21:00');
  await expect(dialog.getByRole('button', { name: '周一', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: '周六', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: '周日', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(dialog.getByRole('button', { name: '橙色', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('取消、Escape 和遮罩丢弃草稿，背景保持已保存的值', async ({ page, request }) => {
  await saveBands(request, [work]);
  await openPlan(page);
  const open = () => page.getByRole('button', { name: '时间段', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '时间段分组' });
  const name = () => dialog.getByRole('textbox', { name: '名称', exact: true });
  await open();
  await name().fill('临时');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toBeHidden();
  await open();
  await expect(name()).toHaveValue('工作');
  await name().fill('临时二');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await open();
  await expect(name()).toHaveValue('工作');
  await name().fill('临时三');
  await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: 8, y: 8 } });
  await expect(dialog).toBeHidden();
  await open();
  await expect(name()).toHaveValue('工作');
  await expect(page.getByTestId('time-band-segment')).toHaveAttribute('data-end-minute', '1080');
});

test('保存后背景位置更新，删除后背景消失', async ({ page, request }) => {
  await saveBands(request, [work]);
  await openPlan(page);
  await page.getByRole('button', { name: '时间段', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '时间段分组' });
  await dialog.getByRole('textbox', { name: '结束时间', exact: true }).fill('12:00');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  const segment = page.locator('[data-testid="time-band-day"][data-date="2026-10-12"]').getByTestId('time-band-segment');
  await expect(segment).toHaveCount(1);
  expect(await segment.evaluate(node => {
    const element = node as HTMLElement;
    return { end: element.dataset.endMinute, top: element.style.top, height: element.style.height };
  })).toEqual({ end: '720', top: '504px', height: '168px' });
  await page.getByRole('button', { name: '时间段', exact: true }).click();
  await dialog.getByRole('button', { name: '删除时间段', exact: true }).click();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('time-band-segment')).toHaveCount(0);
});

test('另一个浏览器上下文能读到同一份已保存设置', async ({ page, request }) => {
  await saveBands(request, [work, lunch]);
  await openPlan(page);
  const browser = page.context().browser();
  if (!browser) throw new Error('当前浏览器不支持独立上下文');
  const other = await browser.newContext({
    timezoneId: 'Asia/Shanghai',
    storageState: { cookies: [{ name: 'dovun_session', value: 'wwa-e2e-owner-session', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' }], origins: [] },
    extraHTTPHeaders: { 'X-CSRF-Token': csrf, Origin: (process.env.E2E_UI_URL ?? 'http://127.0.0.1:5175') },
  });
  try {
    const otherPage = await other.newPage();
    await otherPage.clock.setFixedTime(new Date(fixedTime));
    await otherPage.addInitScript(() => {
      (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
    });
    await otherPage.goto(`${process.env.E2E_UI_URL ?? 'http://127.0.0.1:5175'}/#/plan`);
    const day = otherPage.locator('[data-testid="time-band-day"][data-date="2026-10-12"]');
    await expect(day.getByTestId('time-band-segment')).toHaveCount(3);
    await otherPage.getByRole('button', { name: '时间段', exact: true }).click();
    const dialog = otherPage.getByRole('dialog', { name: '时间段分组' });
    await expect(dialog.getByRole('textbox', { name: '名称', exact: true }).first()).toHaveValue('工作');
    await expect(dialog.getByRole('textbox', { name: '名称', exact: true }).nth(1)).toHaveValue('午休');
  } finally {
    await other.close();
  }
});

test('保存失败时保留草稿和原背景，恢复后可以保存', async ({ page, request }) => {
  await saveBands(request, [work, lunch]);
  await openPlan(page);
  const before = await page.locator('[data-testid="time-band-day"][data-date="2026-10-12"]').getByTestId('time-band-segment').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).style.top));
  let fail = true;
  await page.route('**/api/plan/time-bands', async (route) => {
    if (fail && route.request().method() === 'PUT') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ data: null, error: '保存失败' }) });
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '时间段', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '时间段分组' });
  const name = dialog.getByRole('textbox', { name: '名称', exact: true }).first();
  await name.fill('改名');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(name).toHaveValue('改名');
  await expect(dialog.getByText('保存失败，请重试')).toBeVisible();
  expect(await page.locator('[data-testid="time-band-day"][data-date="2026-10-12"]').getByTestId('time-band-segment').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).style.top))).toEqual(before);
  await expect(page.locator('[data-testid="time-band-day"][data-date="2026-10-12"]')).not.toContainText('改名');
  fail = false;
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('时间段已保存')).toBeVisible();
  await page.getByRole('button', { name: '时间段', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true }).first()).toHaveValue('改名');
});

test('首次读取失败时任务仍在，不能用空列表覆盖', async ({ page, request }) => {
  test.setTimeout(60_000);
  const created = await request.post(`${apiUrl}/api/tasks`, { data: { title: '读取失败仍显示', dueDate: '2026-10-12', scheduledStart: '2026-10-12T14:00', scheduledEnd: '2026-10-12T15:00' } });
  expect(created.ok(), await created.text()).toBe(true);
  await saveBands(request, [work]);
  const puts: string[] = [];
  page.on('request', (incoming) => {
    if (incoming.method() === 'PUT' && incoming.url().includes('/api/plan/time-bands')) puts.push(incoming.postData() ?? '');
  });
  await page.route('**/api/plan/time-bands', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ data: null, error: '读取失败' }) });
      return;
    }
    await route.continue();
  });
  await openPlan(page);
  await expect(page.locator('[data-testid="task-block"]')).toContainText('读取失败仍显示');
  await expect(page.getByText('时间段加载失败').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: '重试', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '时间段', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '时间段分组' });
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  expect(puts).toEqual([]);
  expect((await (await request.get(`${apiUrl}/api/plan/time-bands`)).json()).data.bands).toEqual([work]);
});

test('周视图只在周一至周五显示，月视图没有底色', async ({ page, request }, testInfo) => {
  await saveBands(request, [work, lunch]);
  await openPlan(page);
  await page.getByRole('button', { name: '周', exact: true }).click();
  for (const date of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']) {
    await expect(page.locator(`[data-testid="time-band-day"][data-date="${date}"]`).getByTestId('time-band-segment')).toHaveCount(3);
  }
  await expect(page.locator('[data-testid="time-band-day"][data-date="2026-10-17"]').getByTestId('time-band-segment')).toHaveCount(0);
  await expect(page.locator('[data-testid="time-band-day"][data-date="2026-10-18"]').getByTestId('time-band-segment')).toHaveCount(0);
  if (testInfo.project.name === 'chromium') await page.screenshot({ path: '/tmp/wwa-plan-time-bands-week.png' });
  await page.getByRole('button', { name: '月', exact: true }).click();
  await expect(page.getByTestId('time-band-layer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '时间段', exact: true })).toBeEnabled();
});

test('点击被背景覆盖的 10:00 时间槽仍能创建任务', async ({ page, request }) => {
  await saveBands(request, [work, lunch]);
  await openPlan(page);
  await page.getByRole('button', { name: '在2026-10-12 10:00添加任务', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '创建任务' })).toBeVisible();
});

test('底色不吞掉任务缩放', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '触屏缩放由现有日程测试覆盖');
  await saveBands(request, [work, lunch]);
  const created = await request.post(`${apiUrl}/api/tasks`, { data: { title: '缩放目标', dueDate: '2026-10-12', scheduledStart: '2026-10-12T14:00', scheduledEnd: '2026-10-12T15:00' } });
  expect(created.ok(), await created.text()).toBe(true);
  const task = (await created.json()).data as { id: string };
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPlan(page);
  const block = page.locator(`[data-testid="task-block"][data-task-id="${task.id}"]`);
  await block.scrollIntoViewIfNeeded();
  const handle = block.getByLabel('调整结束：缩放目标');
  const box = await handle.boundingBox();
  if (!box) throw new Error('没有缩放手柄');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 28, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await (await request.get(`${apiUrl}/api/tasks/${task.id}`)).json()).data.scheduledEnd).toBe('2026-10-12T15:30');
});

test('375px 弹窗不横向溢出，保存按钮可操作', async ({ page }, testInfo) => {
  await openPlan(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.getByRole('button', { name: '时间段', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '时间段分组' });
  const box = await dialog.boundingBox();

  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(15);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);

  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth
  )).toBeLessThanOrEqual(375);
  const save = dialog.getByRole('button', { name: '保存', exact: true });
  await expect(save).toBeVisible();
  const saveBox = await save.boundingBox();
  expect(saveBox).not.toBeNull();
  expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(800);
  await save.click();
  await expect(dialog.getByText('请输入 1–40 个字符的名称')).toHaveCount(0);
  if (testInfo.project.name === 'chromium') await page.screenshot({ path: '/tmp/wwa-plan-time-bands-dialog-375.png' });
});

test('星期和颜色可键盘切换，错误有关联，关闭后焦点回到按钮', async ({ page }) => {
  await openPlan(page);
  const trigger = page.getByRole('button', { name: '时间段', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '时间段分组' });
  await dialog.getByRole('button', { name: '添加时间段', exact: true }).click();
  const monday = dialog.getByRole('button', { name: '周一', exact: true });
  await monday.focus();
  await expect(monday).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect(monday).toHaveAttribute('aria-pressed', 'false');
  const green = dialog.getByRole('button', { name: '绿色', exact: true });
  await green.focus();
  await page.keyboard.press('Enter');
  await expect(green).toHaveAttribute('aria-pressed', 'true');
  const name = dialog.getByRole('textbox', { name: '名称', exact: true });
  await name.fill('');
  await name.blur();
  const describedBy = await name.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  await expect(dialog.locator(`[id="${describedBy}"]`)).toHaveText('请输入 1–40 个字符的名称');
  for (const day of ['周二', '周三', '周四', '周五']) await dialog.getByRole('button', { name: day, exact: true }).click();
  const group = dialog.getByRole('group', { name: '重复星期' });
  await expect(group).toHaveAttribute('aria-describedby', /.+/);
  await expect(dialog.locator(`[id="${await group.getAttribute('aria-describedby')}"]`)).toHaveText('至少选择一天');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('结束 24:00 可以保存，并且下边界不超过一天的高度', async ({ page }) => {
  await openPlan(page);
  await page.getByRole('button', { name: '时间段', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '时间段分组' });
  await dialog.getByRole('button', { name: '添加时间段', exact: true }).click();
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('到午夜');
  await dialog.getByRole('textbox', { name: '开始时间', exact: true }).fill('22:00');
  await dialog.getByRole('textbox', { name: '结束时间', exact: true }).fill('24:00');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  const segment = page.locator('[data-testid="time-band-day"][data-date="2026-10-12"]').getByTestId('time-band-segment');
  await expect(segment).toHaveCount(1);
  const geometry = await segment.evaluate(node => {
    const element = node as HTMLElement;
    return { end: element.dataset.endMinute, top: Number.parseFloat(element.style.top), height: Number.parseFloat(element.style.height) };
  });
  expect(geometry.end).toBe('1440');
  expect(geometry.top + geometry.height).toBeLessThanOrEqual(1344);
  await page.reload();
  await page.getByRole('button', { name: '时间段', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '结束时间', exact: true })).toHaveValue('24:00');
});

const weekMinWidth = 760;

function band(id: string, name: string, startMinute: number, endMinute: number, color: string) {
  return { id: `00000000-0000-4000-8000-${id}`, name, startMinute, endMinute, weekdays: [1, 2, 3, 4, 5], color };
}

async function createTask(request: { post: (url: string, options: { data: unknown }) => Promise<{ ok: () => boolean; text: () => Promise<string>; json: () => Promise<{ data: { id: string } }> }> }, data: Record<string, unknown>) {
  const response = await request.post(`${apiUrl}/api/tasks`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

async function pageScrollWidth(page: Page) {
  return page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
}

async function railMetrics(day: Locator) {
  return day.evaluate((node) => {
    const rail = node.querySelector('[data-testid="time-band-rail"]') as HTMLElement | null;
    const lane = node.querySelector('[data-testid="plan-task-lane"]') as HTMLElement;
    const segment = node.querySelector('[data-testid="time-band-segment"]') as HTMLElement | null;
    const border = Number.parseFloat(getComputedStyle(node).borderLeftWidth) || 0;
    const dayRect = node.getBoundingClientRect();
    const laneRect = lane.getBoundingClientRect();
    const railRect = rail?.getBoundingClientRect();
    const segmentRect = segment?.getBoundingClientRect();
    return {
      rail: railRect?.width ?? 0,
      laneLeft: laneRect.left - dayRect.left - border,
      laneWidth: laneRect.width,
      clientWidth: node.clientWidth,
      segmentWidth: segmentRect?.width ?? 0,
    };
  });
}

async function expectLabelsClearOfTasks(day: Locator) {
  const hit = await day.evaluate((node) => {
    const rects = (selector: string) => [...node.querySelectorAll(selector)].map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, text: (element.textContent ?? '').trim() };
    }).filter((rect) => rect.right - rect.left > 0.5 && rect.bottom - rect.top > 0.5);
    const labels = rects('[data-testid="time-band-label-name"], [data-testid="time-band-label-range"]');
    const tasks = rects('[data-testid="task-block"] span.truncate');
    const rail = node.querySelector('[data-testid="time-band-rail"]')?.getBoundingClientRect();
    const collisions: string[] = [];
    for (const label of labels) {
      if (rail && (label.left < rail.left - 1 || label.right > rail.right + 1)) collisions.push(`标签超出侧栏 ${label.text}`);
      for (const task of tasks) {
        const width = Math.min(label.right, task.right) - Math.max(label.left, task.left);
        const height = Math.min(label.bottom, task.bottom) - Math.max(label.top, task.top);
        if (width > 0.5 && height > 0.5) collisions.push(`${label.text} × ${task.text}`);
      }
    }
    if (rail) for (const task of tasks) if (task.left < rail.right - 1) collisions.push(`任务进入侧栏 ${task.text}`);
    return collisions;
  });
  expect(hit).toEqual([]);
}

test('标签留在侧栏，任务文字与标签不相交', async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const longName = `验证省略${'名'.repeat(36)}`;
  await saveBands(request, [
    band('0000000000a1', '看不见', 0, 21, 'gray'),
    band('0000000000a2', '只显示名', 60, 82, 'green'),
    band('0000000000a3', '两行小段', 120, 159, 'orange'),
    band('0000000000a4', '上班（上午）', 600, 720, 'blue'),
    band('0000000000a5', '上班（下午）', 840, 1140, 'purple'),
    band('0000000000a6', longName, 1200, 1260, 'pink'),
  ]);
  const video = await createTask(request, { title: '新增视频接口的实现，按照最新的tr4', dueDate: '2026-10-12', scheduledStart: '2026-10-12T10:00', scheduledEnd: '2026-10-12T17:00' });
  await createTask(request, { title: '并行评审', dueDate: '2026-10-12', scheduledStart: '2026-10-12T10:30', scheduledEnd: '2026-10-12T12:00' });
  await createTask(request, { title: '跨午夜联调', dueDate: '2026-10-12', scheduledStart: '2026-10-12T22:00', scheduledEnd: '2026-10-13T02:00' });
  await createTask(request, { title: '全天对照', dueDate: '2026-10-12' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPlan(page);

  const day = () => page.locator('[data-testid="time-band-day"][data-date="2026-10-12"]');
  const scrollTimeline = () => page.getByTestId('timeline-scroll').evaluate((node) => { node.scrollTop = 8 * 56; });
  const show = async (span: 'day' | 'week', width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: span === 'day' ? '日' : '周', exact: true }).click();
    await scrollTimeline();
    expect(await pageScrollWidth(page)).toBeLessThanOrEqual(width + 1);
  };
  const expectRail = async (column: Locator, width: number) => {
    const metrics = await railMetrics(column);
    expect(Math.abs(metrics.rail - width)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.laneLeft - width)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.segmentWidth - metrics.clientWidth)).toBeLessThanOrEqual(1);
    expect(metrics.segmentWidth).toBeGreaterThan(width + 40);
    await expectLabelsClearOfTasks(column);
    return metrics;
  };

  const checkDay = async (width: number, rail: number) => {
    await show('day', width);
    const column = day();
    await expect(column.getByTestId('time-band-segment')).toHaveCount(6);
    const metrics = await expectRail(column, rail);
    expect(metrics.laneWidth).toBeGreaterThan(80);
    const morning = column.locator('[data-testid="time-band-segment"][data-start-minute="600"]');
    const afternoon = column.locator('[data-testid="time-band-segment"][data-start-minute="840"]');
    const hidden = column.locator('[data-testid="time-band-segment"][data-start-minute="0"]');
    const nameOnly = column.locator('[data-testid="time-band-segment"][data-start-minute="60"]');
    const shortBoth = column.locator('[data-testid="time-band-segment"][data-start-minute="120"]');
    const block = column.locator(`[data-testid="task-block"][data-task-id="${video.id}"]`);
    await expect(morning).toHaveAttribute('style', /top:\s*560px/);
    await expect(morning).toHaveAttribute('style', /height:\s*112px/);
    await expect(afternoon).toHaveAttribute('style', /top:\s*784px/);
    await expect(block.locator('xpath=..')).toHaveAttribute('style', /top:\s*560px/);
    await expect(morning.getByTestId('time-band-label')).toHaveAttribute('aria-label', '上班（上午） 10:00–12:00');
    await expect(morning.getByTestId('time-band-label-range')).toHaveText('10:00–12:00');
    await expect(hidden.getByTestId('time-band-label')).toHaveCount(0);
    expect(await hidden.evaluate((node) => Number.parseFloat((node as HTMLElement).style.height))).toBeLessThan(20);
    await expect(nameOnly.getByTestId('time-band-label')).toHaveAttribute('data-label-mode', 'name');
    await expect(nameOnly.getByTestId('time-band-label-range')).toHaveCount(0);
    await expect(nameOnly.getByTestId('time-band-label')).toHaveAttribute('aria-label', '只显示名 01:00–01:22');
    const nameOnlyHeight = await nameOnly.evaluate((node) => Number.parseFloat((node as HTMLElement).style.height));
    expect(nameOnlyHeight).toBeGreaterThanOrEqual(20);
    expect(nameOnlyHeight).toBeLessThan(36);
    await expect(shortBoth.getByTestId('time-band-label')).toHaveAttribute('data-label-mode', 'both');
    const longLabel = column.locator('[data-testid="time-band-segment"][data-start-minute="1200"]').getByTestId('time-band-label');
    await expect(longLabel).toHaveAttribute('aria-label', `${longName} 20:00–21:00`);
    expect(await longLabel.getByTestId('time-band-label-name').evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(true);
    await expect(page.locator('[data-drop-id="allday:2026-10-12"]')).toContainText('全天对照');
    await expect(column.getByTestId('plan-task-lane')).not.toContainText('全天对照');
    await expect(column.getByText('并行评审')).toBeVisible();
    const scroll = page.getByTestId('calendar-horizontal-scroll');
    expect(await scroll.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  };
  const checkWeek = async (width: number) => {
    await show('week', width);
    expect(await page.getByTestId('calendar-horizontal-scroll').evaluate((node) => node.scrollWidth)).toBeGreaterThanOrEqual(weekMinWidth);
    for (const date of ['2026-10-12', '2026-10-13', '2026-10-16']) {
      const column = page.locator(`[data-testid="time-band-day"][data-date="${date}"]`);
      const metrics = await expectRail(column, 0);
      expect(metrics.laneWidth).toBeGreaterThanOrEqual(100);
      await expect(column.getByTestId('time-band-layer')).toHaveCSS('opacity', '0.28');
      await expect(column.getByTestId('time-band-label').first()).not.toBeVisible();
    }
    const saturday = page.locator('[data-testid="time-band-day"][data-date="2026-10-17"]');
    await expect(saturday).toHaveAttribute('data-band-rail', 'false');
    await expect(saturday.getByTestId('time-band-rail')).toHaveCount(0);
    const open = await railMetrics(saturday);
    expect(open.rail).toBe(0);
    expect(Math.abs(open.laneLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(open.laneWidth - open.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-testid="task-block"][data-date="2026-10-12"]').filter({ hasText: '跨午夜联调' })).toHaveCount(1);
    await expect(page.locator('[data-testid="task-block"][data-date="2026-10-13"]').filter({ hasText: '跨午夜联调' })).toHaveCount(1);
    await expectLabelsClearOfTasks(page.locator('[data-testid="time-band-day"][data-date="2026-10-13"]'));
  };

  await checkDay(1280, 112);
  if (testInfo.project.name === 'chromium') await page.screenshot({ path: '/tmp/wwa-plan-rail-day-light.png' });
  await checkDay(390, 80);
  if (testInfo.project.name === 'chromium') await page.screenshot({ path: '/tmp/wwa-plan-rail-day-390.png' });
  await checkDay(375, 80);
  if (testInfo.project.name === 'chromium') await page.screenshot({ path: '/tmp/wwa-plan-rail-day-375.png' });
  await checkWeek(1280);
  if (testInfo.project.name === 'chromium') await page.screenshot({ path: '/tmp/wwa-plan-rail-week-light.png' });
  await checkWeek(390);
  await checkWeek(375);
  await page.getByRole('button', { name: '月', exact: true }).click();
  await expect(page.getByTestId('time-band-layer')).toHaveCount(0);
  await expect(page.getByTestId('time-band-rail')).toHaveCount(0);
  expect(await pageScrollWidth(page)).toBeLessThanOrEqual(376);

  await page.setViewportSize({ width: testInfo.project.name === 'mobile' ? 390 : 1280, height: 900 });
  await page.getByRole('button', { name: '日', exact: true }).click();
  await switchDark(page, testInfo.project.name);
  await checkDay(1280, 112);
  await expect(day().locator('[data-testid="time-band-segment"][data-start-minute="600"]')).toHaveCSS('background-color', 'rgb(24, 38, 61)');
  if (testInfo.project.name === 'chromium') await page.screenshot({ path: '/tmp/wwa-plan-rail-day-dark.png' });
  await checkDay(390, 80);
  await checkDay(375, 80);
  await checkWeek(1280);
  await checkWeek(375);
});

test('侧栏位置仍能创建，任务可拖放、缩放、完成和打开详情', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  await saveBands(request, [band('0000000000b1', '上班（上午）', 600, 720, 'blue')]);
  const task = await createTask(request, { title: '侧栏回归', dueDate: '2026-10-12', scheduledStart: '2026-10-12T14:00', scheduledEnd: '2026-10-12T15:00' });
  await openPlan(page);
  const day = page.locator('[data-testid="time-band-day"][data-date="2026-10-12"]');
  await page.getByTestId('timeline-scroll').evaluate((node) => { node.scrollTop = 9 * 56; });
  const slot = day.locator('[data-drop-id="slot:2026-10-12:10:00"]');
  const slotBox = await slot.boundingBox();
  if (!slotBox) throw new Error('没有 10:00 时间槽');
  await page.mouse.click(slotBox.x + 12, slotBox.y + slotBox.height / 2);
  const dialog = page.getByRole('dialog', { name: '创建任务', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toBeHidden();

  const block = day.locator(`[data-testid="task-block"][data-task-id="${task.id}"]`);
  await block.getByRole('button', { name: '打开任务：侧栏回归', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(detail).toBeVisible();
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(detail).toBeHidden();

  if (testInfo.project.name !== 'mobile') {
    await page.setViewportSize({ width: 1280, height: 900 });
    await block.scrollIntoViewIfNeeded();
    const handle = block.getByLabel('调整结束：侧栏回归');
    const handleBox = await handle.boundingBox();
    if (!handleBox) throw new Error('没有缩放手柄');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 28, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await (await request.get(`${apiUrl}/api/tasks/${task.id}`)).json()).data.scheduledEnd).toBe('2026-10-12T15:30');

    const target = day.locator('[data-drop-id="slot:2026-10-12:16:00"]');
    await target.scrollIntoViewIfNeeded();
    const from = await block.getByRole('button', { name: '打开任务：侧栏回归', exact: true }).boundingBox();
    const to = await target.boundingBox();
    if (!from || !to) throw new Error('没有拖放区域');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2, { steps: 3 });
    await page.mouse.move(to.x + 12, to.y + to.height / 2, { steps: 20 });
    await page.mouse.up();
    await expect.poll(async () => (await (await request.get(`${apiUrl}/api/tasks/${task.id}`)).json()).data.scheduledStart).toBe('2026-10-12T16:00');
  }

  await block.getByLabel('完成任务：侧栏回归', { exact: true }).click();
  await expect(block.getByLabel('重开任务：侧栏回归')).toBeChecked();
});
