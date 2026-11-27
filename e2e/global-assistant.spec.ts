import { assistantMenuItem, assistantInputTools } from './assistant-toolbar.js';
import { test, expect, type Page } from './fixtures.js';
import { randomUUID } from 'node:crypto';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const panel = (page: Page) => page.getByTestId('ai-assistant');
async function open(page: Page) { await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click(); await expect(panel(page)).toBeVisible(); }
// Sources sit in a collapsed "N 个参考来源" list under the reply.
async function openPlanSource(page: Page) {
  const sources = panel(page).getByTestId('assistant-sources').last();
  if (!(await sources.evaluate((node) => (node as HTMLDetailsElement).open))) await sources.locator('summary').click();
  await sources.locator('.assistant-source-row').filter({ hasText: '规划与时间段' }).first().click();
}
async function ask(page: Page, text: string) {
  const sent = page.waitForRequest((request) => request.url().endsWith('/api/chat') && request.method() === 'POST');
  await panel(page).getByRole('textbox', { name: '向 AI 提问' }).fill(text);
  await panel(page).getByRole('button', { name: '发送', exact: true }).click();
  const body = (await sent).postDataJSON();
  await expect(panel(page).getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await expect(panel(page).getByText('AI验收完成，已读取当前页面与功能说明。', { exact: true }).last()).toBeVisible();
  await expect(panel(page).getByText('处理中…')).toHaveCount(0);
  return body;
}
test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  const response = await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  expect(response.ok()).toBe(true);
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('all pages share one assistant; workspace modal, shortcuts, sources and history', async ({ page, isMobile }) => {
  await page.goto('/#/inbox');
  await open(page);
  const first = await ask(page, 'AI验收第一页');
  expect(first.context.schemaVersion).toBe(3);
  expect(first.context.page).toBe('inbox');
  await panel(page).getByRole('textbox', { name: '向 AI 提问' }).fill('切页保留输入');
  await page.evaluate(() => { location.hash = '/plan'; });
  await expect(page.getByTestId('assistant-context')).toContainText('规划');
  await expect(panel(page).getByRole('textbox', { name: '向 AI 提问' })).toHaveValue('切页保留输入');
  const second = await ask(page, 'AI验收规划页');
  expect(second.conversationId).toBeTruthy();
  expect(second.context.pageState.dateFrom).toBeTruthy();
  expect(second.context.taskFilter.scheduledFrom).toBe(second.context.pageState.dateFrom);
  await assistantInputTools(page);
  await page.getByTestId('assistant-context-trigger').click();
  await page.getByRole('button', { name: '固定当前参考范围', exact: true }).click();
  await page.getByTestId('assistant-context-trigger').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { location.hash = '/settings'; });
  if (isMobile) {
    // 手机上进入工作区弹窗会收起助手（否则助手盖住弹窗内容），用弹窗内的 AI 助手按钮重新打开。
    await expect(panel(page)).toBeHidden();
    await page.getByTestId('workspace-assistant-fab').click();
  }
  await expect(panel(page)).toBeVisible();
  const fixed = await ask(page, 'AI验收固定规划');
  expect(fixed.context.page).toBe('plan');
  await assistantInputTools(page);
  await page.getByTestId('assistant-context-trigger').click();
  await page.getByRole('button', { name: '清除参考', exact: true }).click();
  await expect(page.getByText('未添加页面参考', { exact: true }).last()).toBeVisible();
  await page.getByTestId('assistant-context-trigger').click();
  await page.keyboard.press('Escape');
  const cleared = await ask(page, 'AI验收清除参考');
  expect(cleared.context).toMatchObject({ page: 'chat', scope: { kind: 'all' }, mode: 'cleared', taskFilter: null, selectedTaskIds: [], selectedMaterialIds: [], attachments: [] });
  await assistantInputTools(page);
  await page.getByTestId('assistant-context-trigger').click();
  await page.getByRole('button', { name: '固定当前参考范围', exact: true }).click();
  await page.getByTestId('assistant-context-trigger').click();
  await page.keyboard.press('Escape');
  const settings = await ask(page, 'AI验收设置');
  expect(settings.context.page).toBe('settings');
  if (isMobile) { const box = await panel(page).boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0); expect((await page.locator('.assistant-workspace-open').boundingBox())!.width).toBe(page.viewportSize()!.width); await page.screenshot({ path: '/tmp/wwa-ai-mobile-settings.png' }); }
  expect(JSON.stringify(settings.context)).not.toContain('e2e-key');
  await openPlanSource(page);
  const sourceDialog = page.getByRole('dialog', { name: '参考来源', exact: true });
  await expect(sourceDialog).toContainText('应用版本');
  await page.keyboard.press('Escape');
  await expect(sourceDialog).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await page.reload();
  // The reload lands on the settings modal; its header has its own assistant entry.
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId('assistant-sources').last()).toContainText('1 个参考来源');
  await panel(page).getByRole('button', { name: '查看本条消息的参考范围', exact: true }).first().click();
  await expect(page.getByTestId('context-summary')).toContainText('收集箱');
  await page.keyboard.press('Escape');
  if (!isMobile) {
    await (await assistantMenuItem(page, '关闭聊天')).click();
    await page.keyboard.press('Control+Shift+L');
    await expect(panel(page).getByRole('textbox', { name: '向 AI 提问' })).toBeFocused();
  }
});

test('task and AI switch, manual draft attachment and return preserve editor', async ({ page, request, isMobile }) => {
  const task = (await (await request.post(`${api}/api/tasks`, { data: { title: '并排任务', description: '已保存的正文', topicId: null } })).json()).data;
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '并排任务', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '任务详情', exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: '带上当前草稿', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  if (isMobile) { await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: '/tmp/wwa-ai-390.png' }); }
  await expect(page.getByRole('textbox', { name: '详情', exact: true })).toBeHidden();
  await expect((await assistantInputTools(page)).getByText(/未保存草稿/)).toBeVisible();
  await page.keyboard.press('Escape');
  const sent = await ask(page, 'AI验收当前草稿');
  expect(sent.context.taskId).toBe(task.id);
  expect(sent.context.attachments[0].text).toContain('已保存的正文');
  await expect((await assistantInputTools(page)).getByRole('button', { name: /^移除/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '详情', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '详情', exact: true })).toContainText('已保存的正文');
});

test('a valid 300-character task title can chat without clipping the attached draft', async ({ page, request }) => {
  const title = '长'.repeat(300);
  const description = '正文必须保持完整';
  const created = await request.post(api + '/api/tasks', { data: { title, description, topicId: null } });
  expect(created.ok()).toBe(true);
  const task = (await created.json()).data;
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(page.getByRole('dialog', { name: '任务详情', exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: '带上当前草稿', exact: true }).click();
  const sent = await ask(page, 'AI验收长标题');
  expect(sent.context.taskId).toBe(task.id);
  expect(sent.context.label).toBe(('任务 · ' + title).slice(0, 300));
  expect(sent.context.attachments[0].title).toBe(title);
  expect(sent.context.attachments[0].text).toBe(title + '\n\n' + description);
  expect((await (await request.get(api + '/api/tasks/' + task.id)).json()).data.title).toBe(title);
});

test('desktop widths and theme remain usable with current content visible', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop layout sizes');
  await page.goto('/#/inbox');
  await open(page);
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(panel(page)).toBeVisible();
    const box = await panel(page).boundingBox();
    // --dovun-work-width in workbench.css: 400px from 1440, 380px below.
    expect(box?.width).toBeGreaterThanOrEqual(width === 1440 ? 394 : 374);
    expect(box?.width).toBeLessThanOrEqual(width === 1440 ? 400 : 380);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/wwa-ai-${width}-light.png` });
  }
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.getByRole('menuitem', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/wwa-ai-1024-dark.png' });
});


test('knowledge scope and actual memory filters reach the request', async ({ page, isMobile }) => {
  await e2eDatabase.memory.create({ data: { kind: 'fact', title: '之前的决定', content: '历史样本', status: 'retired', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
  await page.goto('/#/knowledge/memories?topicId=inbox');
  await page.getByRole('group', { name: '记忆状态' }).getByRole('button', { name: '历史', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索记忆', exact: true }).fill('之前的决定');
  await page.waitForTimeout(450);
  await open(page);
  const body = await ask(page, 'AI验收知识筛选');
  expect(body.context.scope).toEqual({ kind: 'inbox' });
  expect(body.context.section).toBe('memories');
  expect(body.context.pageState).toMatchObject({ status: 'history', query: '之前的决定' });
  // Opening a source shows it in a dialog and leaves the page alone; the next page gets its own scope.
  await openPlanSource(page);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { location.hash = '/plan'; });
  await expect(page.getByTestId('assistant-context')).toContainText('规划');
  const source = await ask(page, 'AI验收来源原文');
  expect(source.context.page).toBe('plan');
  expect(source.context.scope).toEqual({ kind: 'all' });
  expect(source.context.taskFilter.scheduledFrom).toBe(source.context.pageState.dateFrom);
  expect(source.context.pageState.status).toBeUndefined();
});

test('task lists use page context without AI selection controls', async ({ page, request }) => {
  for (const title of ['范围甲', '范围乙', '范围丙']) {
    await request.post(`${api}/api/tasks`, { data: { title, topicId: null } });
  }
  await page.goto('/#/inbox');
  await expect(page.getByRole('button', { name: /^选入 AI 上下文/ })).toHaveCount(0);
  await open(page);
  const body = await ask(page, 'AI验收这些任务');
  expect(body.context.selectedTaskIds).toEqual([]);
  expect(body.context.scope).toEqual({ kind: 'inbox' });
});


test('in-flight request stays on A while navigation changes the next message to B', async ({ page, request }) => {
  const a = (await (await request.post(`${api}/api/tasks`, { data: { title: '任务 A', topicId: null } })).json()).data;
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '任务 A', exact: true }).click();
  await page.getByRole('button', { name: '问 AI', exact: true }).click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/chat', async (route) => { await gate; await route.continue(); });
  const pending = page.waitForRequest((req) => req.url().endsWith('/api/chat'));
  await panel(page).getByRole('textbox', { name: '向 AI 提问' }).fill('AI验收任务 A 冻结');
  await panel(page).getByRole('button', { name: '发送', exact: true }).click();
  const original = (await pending).postDataJSON();
  expect(original.context.taskId).toBe(a.id);
  // 问 AI does not opt in to the task draft; nothing unsaved goes to the model.
  expect(original.context.attachments).toEqual([]);
  await page.evaluate(() => { location.hash = '/plan'; });
  await expect(page.getByTestId('assistant-context')).toContainText('规划');
  release();
  await expect(panel(page).getByText('AI验收完成，已读取当前页面与功能说明。', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('处理中…')).toHaveCount(0);
  await page.unroute('**/api/chat');
  const next = await ask(page, 'AI验收新的规划范围');
  expect(next.context.taskId).toBeNull();
  expect(next.context.page).toBe('plan');
  const history = await (await request.get(`${api}/api/conversations/${next.conversationId}/messages`)).json();
  const turns = history.data.filter((row: any) => row.role === 'user');
  expect(turns[0].context.taskId).toBe(a.id);
  expect(turns[1].context.page).toBe('plan');
});

test('every route shares input and mobile visual viewport keeps the composer visible', async ({ page, isMobile }) => {
  await page.goto('/#/inbox');
  await open(page);
  await panel(page).getByRole('textbox', { name: '向 AI 提问' }).fill('全局草稿');
  for (const name of ['today', 'search', 'tags', 'quadrant', 'plan', 'library', 'knowledge', 'connections', 'runs', 'reviews', 'proposals', 'settings', 'trash', 'changes', 'focus', 'topics', 'archived', 'inbox']) {
    await page.evaluate((name) => { location.hash = `/${name}`; }, name);
    if (isMobile && ['settings', 'trash', 'changes'].includes(name) && !(await panel(page).isVisible())) {
      // 手机上进入工作区弹窗会收起助手，用弹窗内的 AI 助手按钮重新打开后继续校验草稿。
      await page.getByTestId('workspace-assistant-fab').click();
    }
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('textbox', { name: '向 AI 提问' })).toHaveValue('全局草稿');
  }
  if (isMobile) {
    // Browser emulation of a keyboard shrinking the visual viewport; real IME is a separate device check.
    await page.evaluate(() => { Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 500 }); window.visualViewport!.dispatchEvent(new Event('resize')); });
    const input = panel(page).getByRole('textbox', { name: '向 AI 提问' });
    await input.focus();
    expect((await input.boundingBox())!.y + (await input.boundingBox())!.height).toBeLessThanOrEqual(500);
  }
});

test('mobile page swipe opens navigation mid-gesture and ignores cancelled short swipes', async ({ page, isMobile }) => {
  test.skip(!isMobile, '全页面滑动是手机手势');
  await page.goto('/#/inbox');
  await expect(page.getByRole('button', { name: '主导航', exact: true })).toBeVisible();
  const drawer = page.locator('.assistant-navigation-sheet');
  await expect(drawer).toHaveCount(0);
  const session = await page.context().newCDPSession(page);
  const touchDrag = async (start: { x: number; y: number }, dx: number, dy: number) => {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start.x, y: start.y, id: 0 }] });
    const steps = 10;
    for (let index = 1; index <= steps; index += 1) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (dx * index) / steps, y: start.y + (dy * index) / steps, id: 0 }] });
    }
  };
  try {
    // 从左缘向右滑：途中（尚未松手）就应打开抽屉。
    await touchDrag({ x: 8, y: 360 }, 96, 6);
    await expect(drawer).toBeVisible();
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.getByRole('button', { name: '返回页面', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    // 被取消的短滑动不再降低阈值误开菜单。
    await touchDrag({ x: 8, y: 360 }, 30, 6);
    await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(drawer).toHaveCount(0);
    // cancel 时位移不足（近纵向）不开抽屉。
    await touchDrag({ x: 8, y: 360 }, 12, 60);
    await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(drawer).toHaveCount(0);
    // 纵向滑动归页面滚动，不打开抽屉。
    await touchDrag({ x: 8, y: 360 }, 6, 120);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(drawer).toHaveCount(0);
    // 页面中间也能打开，不再受左侧起点限制。
    await touchDrag({ x: 160, y: 360 }, 96, 6);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(drawer).toBeVisible();
  } finally {
    await session.detach();
  }
});

for (const route of ['inbox', 'chat']) test(`mobile full-page swipes open navigation without stealing scrolling or editing (${route})`, async ({ page, request, isMobile }) => {
  test.skip(!isMobile, '全页面滑动是手机手势');
  if (route === 'inbox') for (let index = 0; index < 20; index += 1) {
    const response = await request.post(`${api}/api/tasks`, { data: { title: `手机滑动回归 ${index + 1}` } });
    expect(response.ok()).toBe(true);
  }
  const session = await page.context().newCDPSession(page);
  const drawer = page.locator('.assistant-navigation-sheet');
  const touchDrag = async (x: number, y: number, dx: number, dy: number) => {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
    for (let step = 1; step <= 10; step += 1) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 10, y: y + dy * step / 10, id: 0 }] });
    }
  };
  const release = () => session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  try {
    // CDP delivers browser touch input; Android's OS back gesture still needs a real-device check.
    await page.goto(`/#/${route}`);
    if (route === 'chat') {
      await expect(await assistantMenuItem(page, '主导航')).toBeVisible();
      await page.keyboard.press('Escape');
    } else await expect(page.getByRole('button', { name: '主导航', exact: true })).toBeVisible();
    if (route === 'inbox') {
      await test.step('the populated task list still scrolls vertically', async () => {
        const scroller = page.locator('main.app-main');
        await expect(page.getByTestId('task-list').locator('article[data-testid]')).toHaveCount(20);
        await touchDrag(64, 600, 6, -240);
        await release();
        await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(80);
        await expect(drawer).toHaveCount(0);
        await scroller.evaluate(node => { node.scrollTop = 0; });
      });
    }
    await test.step(`${route}: start inside the page, away from the system edge`, async () => {
      for (const x of [64, 160, 280]) {
        await touchDrag(x, 360, 96, 6);
        await expect(drawer).toBeVisible();
        await release();
        await page.getByRole('button', { name: '返回页面', exact: true }).click();
        await expect(drawer).toHaveCount(0);
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
    });
    await test.step(`${route}: vertical, leftward, short and diagonal swipes do not open navigation`, async () => {
      for (const [x, dx, dy] of [[160, 6, 120], [160, -80, 6], [160, 30, 6], [160, 60, 120]]) {
        await touchDrag(x, 360, dx, dy);
        await release();
        await expect(drawer).toHaveCount(0);
      }
    });
    if (route === 'chat') {
      await test.step('swiping in the composer preserves the draft', async () => {
        const input = panel(page).getByRole('textbox', { name: '向 AI 提问' });
        const draft = '保留中的手机草稿';
        await input.fill(draft);
        const bounds = (await input.boundingBox())!;
        const x = bounds.x + bounds.width / 2;
        await touchDrag(x, bounds.y + bounds.height / 2, 96, 6);
        await release();
        await expect(drawer).toHaveCount(0);
        await expect(input).toHaveValue(draft);
      });
    }
  } finally {
    await session.detach();
  }
});

test('mobile full-page swipe yields to a held task drag', async ({ page, request, isMobile }) => {
  test.skip(!isMobile, '手机长按拖动应保留给任务排序');
  const topicResponse = await request.post(`${api}/api/topics`, { data: { name: '手机拖动回归' } });
  expect(topicResponse.ok()).toBe(true);
  const topic = (await topicResponse.json()).data;
  const ids: string[] = [];
  for (const title of ['拖动目标', '长按拖动任务']) {
    const response = await request.post(`${api}/api/tasks`, { data: { title, topicId: topic.id } });
    expect(response.ok()).toBe(true);
    ids.push((await response.json()).data.id);
  }
  await page.addInitScript(id => localStorage.setItem('dovun.selectedTopic', id), topic.id);
  await page.goto('/#/board');
  const title = page.getByTestId(`task-row-${ids[1]}`).locator('.task-inline-title');
  await expect(title).toBeVisible();
  const bounds = (await title.boundingBox())!;
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  expect(x).toBeGreaterThan(96);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
    await expect(page.locator('.task-drag-overlay')).toBeVisible();
    for (let step = 1; step <= 10; step += 1) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + step * 6, y, id: 0 }] });
    }
    await expect(page.locator('.task-drag-overlay')).toBeVisible();
    await expect(page.locator('.assistant-navigation-sheet')).toHaveCount(0);
    await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(page.locator('.task-drag-overlay')).toHaveCount(0);
    await expect(page.locator('.assistant-navigation-sheet')).toHaveCount(0);
  } finally {
    await session.detach();
  }
});

test('mobile full-page swipe leaves the knowledge canvas in control', async ({ page, isMobile }) => {
  test.skip(!isMobile, '画布拖动不应打开手机导航');
  await page.goto('/#/knowledge/graph');
  const canvas = page.getByLabel('知识关系图');
  await canvas.scrollIntoViewIfNeeded();
  const bounds = (await canvas.boundingBox())!;
  const x = bounds.x + bounds.width / 2, y = bounds.y + 80;
  expect(x).toBeGreaterThan(96);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 80, y, id: 0 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('.assistant-navigation-sheet')).toHaveCount(0);
    await expect(canvas).toBeVisible();
  } finally {
    await session.detach();
  }
});

async function mobileSwipeSession(page: Page) {
  const session = await page.context().newCDPSession(page);
  const swipe = async (x: number, y: number, dx = 96, dy = 4) => {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
    for (let step = 1; step <= 10; step += 1) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 10, y: y + dy * step / 10, id: 0 }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  return { session, swipe };
}

test('mobile full-page navigation works across routes and above workspace pages', async ({ page, isMobile }) => {
  test.skip(!isMobile, '手机全页面导航');
  const { session, swipe } = await mobileSwipeSession(page);
  const drawer = page.locator('.assistant-navigation-sheet');
  try {
    for (const route of ['inbox', 'today', 'search', 'tags', 'quadrant', 'plan', 'library', 'knowledge', 'connections', 'runs', 'reviews', 'proposals', 'settings', 'trash', 'changes', 'focus', 'topics', 'archived', 'learning', 'skills', 'worktrees']) {
      await test.step(route, async () => {
        await page.goto(`/#/${route}`);
        await expect(page.locator('main.app-main')).toBeAttached();
        if (['settings', 'trash', 'changes'].includes(route)) await expect(page.getByTestId('workspace-modal-scroller')).toBeVisible();
        await swipe(180, 30);
        await expect(drawer).toBeVisible();
        await drawer.getByRole('button', { name: '返回页面', exact: true }).click();
        await expect(drawer).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`#/${route}(?:$|[/?])`));
      });
    }
    await page.goto('/#/settings');
    await expect(page.getByTestId('workspace-modal-scroller')).toBeVisible();
    await swipe(180, 30);
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: '收集箱', exact: true }).click();
    await expect(page).toHaveURL(/#\/inbox$/);
    await expect(page.getByTestId('workspace-modal-scroller')).toHaveCount(0);
  } finally { await session.detach(); }
});

test('mobile full-page swipe preserves native horizontal calendar scrolling', async ({ page, isMobile }) => {
  test.skip(!isMobile, '手机横向滚动');
  await page.addInitScript(() => localStorage.setItem('dovun.plan.mode', 'week'));
  await page.goto('/#/plan');
  const calendar = page.getByTestId('calendar-horizontal-scroll');
  await expect(calendar).toBeVisible();
  await calendar.evaluate(node => { node.scrollLeft = 180; });
  const before = await calendar.evaluate(node => node.scrollLeft);
  expect(before).toBeGreaterThan(100);
  const bounds = (await calendar.boundingBox())!;
  const { session, swipe } = await mobileSwipeSession(page);
  try {
    await swipe(160, bounds.y + 80);
    await expect.poll(() => calendar.evaluate(node => node.scrollLeft)).toBeLessThan(before - 40);
    await expect(page.locator('.assistant-navigation-sheet')).toHaveCount(0);
    await calendar.evaluate(node => { node.scrollLeft = 0; });
    await swipe(160, bounds.y + 80);
    await expect(page.locator('.assistant-navigation-sheet')).toHaveCount(0);
  } finally { await session.detach(); }
});

test('mobile full-page swipe preserves SVG map panning without horizontal overflow', async ({ page, request, isMobile }) => {
  test.skip(!isMobile, '手机 SVG 地图平移');
  const response = await request.post(`${api}/api/v1/commands`, { data: { requestId: randomUUID(), commands: [
    { kind: 'learning.map.create', clientRef: 'map', input: { title: '手势回归地图', goal: '' } },
    { kind: 'learning.node.create', input: { mapId: { $ref: 'map' }, parentId: null, kind: 'topic', title: '可平移分组', detail: '', sortOrder: 0 } },
  ] } });
  expect(response.ok()).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/learning');
  await page.getByRole('button', { name: '地图', exact: true }).click();
  const graph = page.getByTestId('echarts-tree');
  await expect(graph).toHaveAttribute('data-chart-ready', 'true');
  await expect(graph.locator('svg')).toBeVisible();
  await graph.scrollIntoViewIfNeeded();
  expect(await graph.evaluate(node => node.parentElement!.scrollWidth <= node.parentElement!.clientWidth + 1)).toBe(true);
  await expect.poll(() => graph.getAttribute('data-center')).toBeTruthy();
  const before = await graph.getAttribute('data-center');
  const bounds = (await graph.boundingBox())!;
  const { session, swipe } = await mobileSwipeSession(page);
  try {
    await swipe(bounds.x + 120, bounds.y + bounds.height / 2);
    await expect(page.locator('.assistant-navigation-sheet')).toHaveCount(0);
    await expect.poll(() => graph.getAttribute('data-center')).not.toBe(before);
  } finally { await session.detach(); }
});

test('mobile full-page swipe preserves selection, multitouch and scroll direction', async ({ page, isMobile }) => {
  test.skip(!isMobile, '手机触摸竞争');
  await page.goto('/#/chat');
  await expect(panel(page)).toBeVisible();
  const { session, swipe } = await mobileSwipeSession(page);
  const drawer = page.locator('.assistant-navigation-sheet');
  try {
    await panel(page).evaluate(node => {
      const text = node.querySelector('h1, h2, p')!;
      const range = document.createRange(); range.selectNodeContents(text);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(false);
    await swipe(160, 360);
    await expect(drawer).toHaveCount(0);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y: 360, id: 0 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y: 360, id: 0 }, { x: 220, y: 400, id: 1 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 256, y: 360, id: 0 }, { x: 316, y: 400, id: 1 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(drawer).toHaveCount(0);
    // A vertical gesture that later bends right must remain a scroll gesture.
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y: 360, id: 0 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 164, y: 400, id: 0 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 280, y: 400, id: 0 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(drawer).toHaveCount(0);
  } finally { await session.detach(); }
});

test('mobile full-page navigation preserves the task editor draft', async ({ page, request, isMobile }) => {
  test.skip(!isMobile, '手机任务详情导航');
  const response = await request.post(`${api}/api/tasks`, { data: { title: '全页面手势任务' } });
  expect(response.ok()).toBe(true);
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '全页面手势任务', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(detail).toBeVisible();
  const title = detail.locator('textarea').first();
  await title.fill('全页面手势保留的草稿');
  const bounds = (await detail.locator('.dovun-detail-tabs').boundingBox())!;
  const { session, swipe } = await mobileSwipeSession(page);
  try {
    await swipe(180, bounds.y + bounds.height / 2);
    const drawer = page.locator('.assistant-navigation-sheet');
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: '返回页面', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(title).toHaveValue('全页面手势保留的草稿');
  } finally { await session.detach(); }
});

test('desktop touch swipes leave navigation unchanged', async ({ page, isMobile }) => {
  test.skip(isMobile, '桌面不启用手机手势');
  await page.goto('/#/inbox');
  await expect(page.locator('.app-sidebar')).toBeVisible();
  const { session, swipe } = await mobileSwipeSession(page);
  try {
    await swipe(500, 360);
    await expect(page.locator('.assistant-navigation-sheet')).toHaveCount(0);
  } finally { await session.detach(); }
});
