import { createHash } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = 'http://127.0.0.1:3015';
const dash = '—';

test.use({ timezoneId: 'Asia/Shanghai' });

type Pair = { value: number; previous: number };
type Rate = { value: number | null; previous: number | null };
type Overview = {
  range: { from: string; to: string; tz: string; today: string };
  tasks: { completed: Pair; overdue: number; created: Pair } | { error: { code: string; message: string } };
  focus: { minutes: Pair } | { error: { code: string; message: string } };
  plan: { onPlanRate: Rate } | { error: { code: string; message: string } };
  ai: { proposals: { adoptionRate: Rate }; dispatch: { rounds: Pair } } | { error: { code: string; message: string } };
};

function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function addDays(iso: string, days: number) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function compactDuration(minutes: number) {
  const safe = Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
  if (safe < 60) return `${Math.round(safe)}m`;
  const hours = Math.round((safe / 60) * 10) / 10;
  return `${Number.isInteger(hours) ? String(hours) : hours.toFixed(1)}h`;
}

function percentText(rate: number | null) {
  if (rate == null || !Number.isFinite(rate)) return dash;
  return `${Math.round(rate * 100)}%`;
}

function isSectionError(value: object): value is { error: { code: string; message: string } } {
  return 'error' in value && typeof (value as { error?: { code?: unknown } }).error?.code === 'string';
}

async function bodyOf(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body;
}

async function createTask(request: APIRequestContext, title: string, extra: Record<string, unknown> = {}) {
  return (await bodyOf(await request.post(`${apiUrl}/api/tasks`, { data: { title, ...extra } }))).data as { id: string; title: string };
}

async function patchTask(request: APIRequestContext, id: string, data: Record<string, unknown>) {
  return bodyOf(await request.patch(`${apiUrl}/api/tasks/${id}`, { data }));
}

async function focusOn(date: string, minutes: number) {
  await e2eDatabase.focusSession.create({
    data: {
      kind: 'focus',
      startedAt: `${date}T09:00`,
      endedAt: `${date}T09:${String(minutes).padStart(2, '0')}`,
      durationMinutes: minutes,
      plannedMinutes: 25,
      completed: true,
      createdAt: new Date().toISOString(),
    },
  });
}

function kpi(page: Page, id: string) {
  return page.getByTestId(`stats-kpi-${id}`).locator('p.text-2xl');
}

async function expectKpis(page: Page, data: Overview) {
  if (isSectionError(data.tasks) || isSectionError(data.focus) || isSectionError(data.plan) || isSectionError(data.ai)) {
    throw new Error(`统计分区返回了错误 ${JSON.stringify(data)}`);
  }
  await expect(kpi(page, 'completed')).toHaveText(String(data.tasks.completed.value));
  await expect(kpi(page, 'overdue')).toHaveText(String(data.tasks.overdue));
  await expect(kpi(page, 'focus')).toHaveText(compactDuration(data.focus.minutes.value));
  await expect(kpi(page, 'onplan')).toHaveText(percentText(data.plan.onPlanRate.value));
  await expect(kpi(page, 'adoption')).toHaveText(percentText(data.ai.proposals.adoptionRate.value));
  await expect(kpi(page, 'dispatch')).toHaveText(String(data.ai.dispatch.rounds.value));
}

async function openStats(page: Page) {
  const response = page.waitForResponse((item) => item.url().includes('/api/stats/overview') && item.ok());
  await page.goto('/#/stats');
  const payload = (await (await response).json()).data as Overview;
  await expect(page.getByTestId('stats-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: '统计', exact: true })).toBeVisible();
  return payload;
}

async function fetchOverview(request: APIRequestContext, from: string, to: string, tz: string) {
  const response = await request.get(`${apiUrl}/api/stats/overview?${new URLSearchParams({ from, to, tz })}`);
  return (await bodyOf(response)).data as Overview;
}

async function browserRanges(page: Page) {
  return page.evaluate(() => {
    const format = (date: Date) => {
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${date.getFullYear()}-${month}-${day}`;
    };
    const today = new Date();
    const back = (days: number) => {
      const date = new Date(today);
      date.setDate(today.getDate() - days);
      return format(date);
    };
    return {
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      today: format(today),
      d7: { from: back(6), to: format(today) },
      d30: { from: back(29), to: format(today) },
    };
  });
}

function desktopOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== 'chromium', '只在桌面项目检查侧栏');
}

function mobileOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== 'mobile', '只在手机项目检查更多页和单列');
}

test.beforeEach(async ({ page }) => {
  await e2eDatabase.focusSession.deleteMany();
  await resetE2eDatabase();
  await e2eDatabase.focusSession.deleteMany();
  await e2eDatabase.planTimeBand.deleteMany();
  await page.addInitScript(() => {
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
  });
});

test.afterAll(async () => {
  await e2eDatabase.$disconnect();
});

test('桌面侧栏在专注下面出现统计，首屏只请求一次总览', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.goto('/#/inbox');
  await expect(page.getByRole('heading', { name: '收集箱', exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: '主导航' });
  const names = await nav.getByRole('button').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') || node.textContent || ''));
  const focusAt = names.indexOf('专注');
  expect(focusAt, names.join(',')).toBeGreaterThanOrEqual(0);
  expect(names[focusAt + 1]).toBe('统计');

  const counts = { overview: 0, tasks: 0 };
  const overviewUrls: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/stats/overview') {
      counts.overview += 1;
      overviewUrls.push(request.url());
    }
    if (path === '/api/tasks' || path.startsWith('/api/tasks/')) counts.tasks += 1;
  });
  await nav.getByRole('button', { name: '统计', exact: true }).click();
  await expect(page).toHaveURL(/#\/stats$/);
  await expect(page.getByTestId('stats-page')).toBeVisible();
  await expect(kpi(page, 'completed')).toBeVisible();
  expect(counts.overview, overviewUrls.join('\n')).toBe(1);
  expect(overviewUrls[0]).toContain('tz=Asia%2FShanghai');
  expect(counts.tasks).toBe(0);
});

test('7 天、30 天和自定义区间的数字卡与接口一致，URL 带上 range', async ({ page, request }) => {
  test.setTimeout(60_000);
  const today = shanghaiToday();
  await focusOn(today, 25);
  await focusOn(addDays(today, -1), 25);
  await focusOn(addDays(today, -2), 25);
  await focusOn(addDays(today, -20), 40);
  await openStats(page);
  const ranges = await browserRanges(page);
  expect(ranges.tz).toBe('Asia/Shanghai');

  await page.getByTestId('stats-range-7d').click();
  await expect(page).toHaveURL(/#\/stats\?range=7d$/);
  const week = await fetchOverview(request, ranges.d7.from, ranges.d7.to, ranges.tz);
  await expectKpis(page, week);

  await page.getByTestId('stats-range-30d').click();
  await expect(page).toHaveURL(/#\/stats\?range=30d$/);
  const month = await fetchOverview(request, ranges.d30.from, ranges.d30.to, ranges.tz);
  expect(isSectionError(week.focus) || isSectionError(month.focus)).toBe(false);
  if (!isSectionError(week.focus) && !isSectionError(month.focus)) expect(month.focus.minutes.value).not.toBe(week.focus.minutes.value);
  await expectKpis(page, month);

  const customFrom = addDays(today, -20);
  await page.getByTestId('stats-range-custom').click();
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover).toBeVisible();
  await popover.getByLabel('开始').fill(customFrom);
  await popover.getByLabel('结束').fill(customFrom);
  await expect(page).toHaveURL(new RegExp(`#/stats\\?range=custom&from=${customFrom}&to=${customFrom}$`));
  await expectKpis(page, await fetchOverview(request, customFrom, customFrom, ranges.tz));
});

test('完成一条任务后完成数加一，改标题后不变，撤销完成后减一', async ({ page, request }) => {
  test.setTimeout(60_000);
  const created = await createTask(request, '统计完成项');
  await openStats(page);
  await expect(kpi(page, 'completed')).toHaveText('0');

  const completed = await patchTask(request, created.id, { status: 'done' });
  await page.reload();
  await expect(kpi(page, 'completed')).toHaveText('1');

  await patchTask(request, created.id, { title: '统计完成项（已改名）' });
  await page.reload();
  await expect(kpi(page, 'completed')).toHaveText('1');

  // 改标题之后，完成那次不再是最新快照。撤销接口只接受最新变更，所以用另一条仍可撤销的完成来验证减一。
  const other = await createTask(request, '可撤销的完成');
  const otherDone = await patchTask(request, other.id, { status: 'done' });
  await page.reload();
  await expect(kpi(page, 'completed')).toHaveText('2');
  const changeId = otherDone.meta?.changeId as string;
  expect(changeId).toBeTruthy();
  const undone = await request.post(`${apiUrl}/api/changes/${changeId}/undo`, { data: {} });
  expect(undone.ok(), await undone.text()).toBe(true);
  await page.reload();
  await expect(kpi(page, 'completed')).toHaveText('1');
});

test('逾期数等于今天页，点击逾期卡回到今天', async ({ page, request }) => {
  await createTask(request, '早就该做完', { dueDate: '2020-01-01' });
  await createTask(request, '今天不用算逾期', { dueDate: shanghaiToday() });
  await page.goto('/#/today');
  const heading = page.getByRole('heading', { name: /^逾期 · \d+$/ });
  await expect(heading).toBeVisible();
  const count = ((await heading.innerText()).split('·')[1] ?? '').trim();
  expect(Number(count)).toBeGreaterThan(0);

  await page.goto('/#/stats');
  await expect(kpi(page, 'overdue')).toHaveText(count);
  await page.getByTestId('stats-kpi-overdue').click();
  await expect(page).toHaveURL(/#\/today$/);
  await expect(page.getByRole('heading', { name: /^逾期 · \d+$/ })).toHaveText(`逾期 · ${count}`);
});

test('派发卡跳到运行页的同一自定义区间', async ({ page, request }) => {
  const today = shanghaiToday();
  const task = await createTask(request, '派发来源任务');
  const startedAt = new Date(`${today}T12:00:00+08:00`).toISOString();
  await e2eDatabase.orchestration.create({
    data: {
      taskId: task.id,
      round: 1,
      status: 'accepted',
      projectId: 'e2e-stats-project',
      integrationBranch: 'orch/e2e-stats',
      createdAt: startedAt,
      updatedAt: startedAt,
      startedAt,
    },
  });
  await openStats(page);
  await page.getByTestId('stats-range-7d').click();
  await expect(page).toHaveURL(/range=7d/);
  const rounds = (await kpi(page, 'dispatch').innerText()).trim();
  expect(Number(rounds)).toBeGreaterThan(0);
  await page.getByTestId('stats-kpi-dispatch').click();
  await expect(page).toHaveURL(/#\/runs\?tab=stats&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  const hash = new URL(page.url()).hash;
  const params = new URLSearchParams(hash.slice(hash.indexOf('?') + 1));
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  expect(from <= today && today <= to).toBe(true);
  await expect(page.getByTestId('dispatch-stats').getByLabel('从')).toHaveValue(from);
  await expect(page.getByTestId('dispatch-stats').getByLabel('到')).toHaveValue(to);
  await expect(page.getByTestId('stats-card-rounds').locator('p.text-2xl')).toHaveText(rounds);
});

test('空工作区显示引导，数据不足时不画趋势', async ({ page, request }) => {
  await page.goto('/#/stats');
  await expect(page.getByTestId('stats-empty')).toBeVisible();
  await expect(page.getByTestId('stats-empty')).toContainText('从这里开始记录');
  await expect(page.getByRole('button', { name: '打开收集箱', exact: true })).toBeVisible();
  await expect(page.getByTestId('stats-sparse')).toHaveCount(0);
  await expect(page.getByTestId('stats-chart-bar')).toHaveCount(0);

  const created = await createTask(request, '只完成了一天');
  await patchTask(request, created.id, { status: 'done' });
  await page.reload();
  await expect(page.getByTestId('stats-empty')).toHaveCount(0);
  const tasks = page.getByTestId('stats-section-tasks');
  await expect(tasks.getByTestId('stats-sparse')).toHaveText('数据不足');
  await expect(tasks.getByTestId('stats-chart-bar')).toHaveCount(0);
  await expect(page.getByTestId('stats-page').locator('[data-testid="stats-sparse"]').first()).toBeVisible();
});

test('只有 AI 分区失败时显示错误和重试，其他三块正常', async ({ page, request }) => {
  await createTask(request, '分区错误时任务仍在');
  await focusOn(shanghaiToday(), 25);
  const csrf = createHash('sha256').update('csrf:wwa-e2e-owner-session').digest('hex');
  await page.route('**/api/stats/overview*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    // 在路由回调里再用 Playwright 的 request / route.fetch 会把响应体提前释放。
    const upstream = await fetch(route.request().url(), {
      headers: { cookie: 'wwa_session=wwa-e2e-owner-session', origin: 'http://127.0.0.1:5175', 'x-csrf-token': csrf },
    });
    const json = await upstream.json() as { data: { ai: unknown } };
    json.data.ai = { error: { code: 'X', message: 'boom' } };
    await route.fulfill({ status: upstream.status, contentType: 'application/json', body: JSON.stringify(json) });
  });
  await page.goto('/#/stats');
  const ai = page.getByTestId('stats-section-ai');
  await expect(ai.getByRole('alert')).toContainText('boom');
  await expect(ai.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  for (const id of ['tasks', 'focus', 'plan']) {
    const section = page.getByTestId(`stats-section-${id}`);
    await expect(section).toBeVisible();
    await expect(section.getByTestId('stats-section-error')).toHaveCount(0);
  }
  await expect(kpi(page, 'completed')).toHaveText('0');
  await expect(kpi(page, 'focus')).not.toHaveText(dash);
  await expect(kpi(page, 'adoption')).toHaveText(dash);
  await ai.getByRole('button', { name: '重试', exact: true }).click();
  await expect(ai.getByRole('alert')).toContainText('boom');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('悬停或点按柱子出现 tooltip', async ({ page }, testInfo) => {
  const today = shanghaiToday();
  for (const offset of [0, -1, -2]) await focusOn(addDays(today, offset), 25);
  await openStats(page);
  const hit = page.getByTestId('stats-section-focus').locator(`[data-testid="stats-bar-hit"][data-date="${today}"]`);
  await hit.scrollIntoViewIfNeeded();
  const label = await hit.getAttribute('aria-label');
  expect(label).toContain('25 分钟');
  if (testInfo.project.name === 'mobile') await hit.tap();
  else await hit.hover();
  // Radix 打开时 data-state 是 delayed-open / instant-open，可访问性树里的角色是 tooltip。
  const tooltip = page.getByRole('tooltip', { name: label ?? '', exact: true });
  await expect(tooltip).toBeVisible();
});

test('手机从更多进入统计，单列且页面没有横向溢出', async ({ page }, testInfo) => {
  mobileOnly(testInfo);
  const today = shanghaiToday();
  for (const offset of [0, -1, -2]) await focusOn(addDays(today, offset), 25);
  await page.goto('/#/inbox');
  await page.getByTestId('mobile-bottom-navigation').locator('[data-view="more"]').click();
  await expect(page).toHaveURL(/#\/more$/);
  await page.getByRole('navigation', { name: '工作区导航' }).getByRole('button', { name: '统计', exact: true }).click();
  await expect(page).toHaveURL(/#\/stats$/);
  await expect(page.getByTestId('stats-page')).toBeVisible();

  for (const id of ['tasks', 'focus', 'plan', 'ai']) {
    const columns = await page.getByTestId(`stats-section-${id}`).locator('.grid').first().evaluate((node) => getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length);
    expect(columns, id).toBe(1);
  }
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await overflow()).toBe(true);

  await page.getByTestId('stats-range-30d').click();
  await expect(page.getByTestId('stats-section-focus').getByTestId('stats-chart-bar')).toBeVisible();
  expect(await overflow()).toBe(true);
});

test('深色主题下统计页没有控制台错误', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.stack || error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    errors.push(`console: ${message.text()} @ ${location.url}:${location.lineNumber}:${location.columnNumber}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem('agent-studio.theme', 'dark');
    document.documentElement?.classList.add('dark');
  });
  await page.goto('/#/stats');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(page.getByTestId('stats-page')).toBeVisible();
  await page.getByTestId('stats-range-30d').click();
  await expect(page.getByTestId('stats-page')).toBeVisible();
  const contrast = await page.getByRole('heading', { name: '统计', exact: true }).evaluate((node) => {
    const color = getComputedStyle(node).color;
    let current: Element | null = node;
    let background = 'rgba(0, 0, 0, 0)';
    while (current) {
      const next = getComputedStyle(current).backgroundColor;
      if (next && next !== 'rgba(0, 0, 0, 0)' && next !== 'transparent') {
        background = next;
        break;
      }
      current = current.parentElement;
    }
    return { color, background };
  });
  expect(contrast.color).not.toBe(contrast.background);
  expect(errors, errors.join('\n')).toEqual([]);
});
