import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const panel = (page: Page) => page.getByTestId('ai-assistant');
async function open(page: Page) { await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click(); await expect(panel(page)).toBeVisible(); }
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
  await panel(page).getByTestId('assistant-context-trigger').click();
  await page.getByRole('button', { name: '固定当前上下文', exact: true }).click();
  await panel(page).getByTestId('assistant-context-trigger').click();
  await page.evaluate(() => { location.hash = '/settings'; });
  await expect(panel(page)).toBeVisible();
  const fixed = await ask(page, 'AI验收固定规划');
  expect(fixed.context.page).toBe('plan');
  await panel(page).getByTestId('assistant-context-trigger').click();
  await page.getByRole('button', { name: '跟随页面', exact: true }).click();
  await panel(page).getByTestId('assistant-context-trigger').click();
  const settings = await ask(page, 'AI验收设置');
  expect(settings.context.page).toBe('settings');
  if (isMobile) { const box = await panel(page).boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0); expect((await page.locator('.assistant-workspace-open').boundingBox())!.width).toBe(page.viewportSize()!.width); await page.screenshot({ path: '/tmp/wwa-ai-mobile-settings.png' }); }
  expect(JSON.stringify(settings.context)).not.toContain('e2e-key');
  await panel(page).getByRole('button', { name: '规划与时间段', exact: true }).first().click();
  await expect(page.getByRole('region', { name: '来源原文' })).toContainText('应用版本');
  if (isMobile) { await open(page); }
  await expect(panel(page)).toBeVisible();
  await page.reload();
  await open(page);
  await expect(panel(page).getByRole('button', { name: '规划与时间段', exact: true }).first()).toBeVisible();
  await expect(panel(page).getByTestId('context-summary').first()).toContainText('收集箱');
  if (!isMobile) {
    await panel(page).getByRole('button', { name: '关闭聊天', exact: true }).click();
    await page.keyboard.press('Control+Shift+L');
    await expect(panel(page).getByRole('textbox', { name: '向 AI 提问' })).toBeFocused();
  }
});

test('task and AI coexist, manual draft attachment, selection and mobile return preserve editor', async ({ page, request, isMobile }) => {
  const task = (await (await request.post(`${api}/api/tasks`, { data: { title: '并排任务', description: '已保存的正文', topicId: null } })).json()).data;
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '并排任务', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '任务详情', exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: '带上当前草稿', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  if (isMobile) { await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: '/tmp/wwa-ai-390.png' }); }
  if (!isMobile) await expect(page.getByRole('textbox', { name: '详情', exact: true })).toBeVisible();
  await expect(page.getByTestId('assistant-context')).toContainText('未保存');
  const sent = await ask(page, 'AI验收当前草稿');
  expect(sent.context.taskId).toBe(task.id);
  expect(sent.context.attachments[0].text).toContain('已保存的正文');
  await expect(page.getByTestId('assistant-context').getByRole('button', { name: /^移除/ })).toHaveCount(0);
  await panel(page).getByRole('button', { name: isMobile ? '返回当前页面' : '关闭聊天', exact: true }).click();
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
    expect(box?.width).toBeGreaterThanOrEqual(width === 1440 ? 426 : 346);
    expect(box?.width).toBeLessThanOrEqual(width === 1440 ? 440 : 360);
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
  await panel(page).getByRole('button', { name: '规划与时间段', exact: true }).first().click();
  if (isMobile) await open(page);
  const source = await ask(page, 'AI验收来源原文');
  expect(source.context.page).toBe('plan');
  expect(source.context.scope).toEqual({ kind: 'all' });
  expect(source.context.taskFilter).toBeNull();
  expect(source.context.pageState.status).toBeUndefined();
});

test('material draft is opt-in and survives assistant close', async ({ page, isMobile }) => {
  await page.goto('/#/library');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('menuitem', { name: '文本', exact: true }).click();
  const composer = page.getByRole('dialog', { name: '添加文本', exact: true });
  await composer.getByRole('textbox', { name: '文本标题', exact: true }).fill('尚未保存的资料');
  await composer.getByRole('textbox', { name: '文本内容', exact: true }).fill('只存在于编辑器中的文字');
  await composer.getByRole('button', { name: 'AI 助手', exact: true }).click();
  const plain = await ask(page, 'AI验收没有附加草稿');
  expect(plain.context.attachments).toEqual([]);
  if (!isMobile) await expect(composer).toBeVisible();
  await panel(page).getByRole('button', { name: isMobile ? '返回当前页面' : '关闭聊天', exact: true }).click();
  await expect(composer.getByRole('textbox', { name: '文本内容', exact: true })).toHaveValue('只存在于编辑器中的文字');
  await composer.getByRole('button', { name: '带上当前草稿', exact: true }).click();
  const attached = await ask(page, 'AI验收资料草稿');
  expect(attached.context.attachments[0]).toMatchObject({ unsaved: true, text: '尚未保存的资料\n\n只存在于编辑器中的文字' });
});

test('explicit multiselection is carried instead of a nearby sample', async ({ page, request }) => {
  const tasks = [];
  for (const title of ['范围甲', '范围乙', '范围丙']) tasks.push((await (await request.post(`${api}/api/tasks`, { data: { title, topicId: null } })).json()).data);
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '选入 AI 上下文：范围甲', exact: true }).click();
  await page.getByRole('button', { name: '选入 AI 上下文：范围乙', exact: true }).click();
  await open(page);
  const body = await ask(page, 'AI验收这些任务');
  expect(body.context.selectedTaskIds.sort()).toEqual([tasks[0].id, tasks[1].id].sort());
});


test('in-flight request stays on A while navigation changes the next message to B', async ({ page, request }) => {
  const a = (await (await request.post(`${api}/api/tasks`, { data: { title: '任务 A', topicId: null } })).json()).data;
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '任务 A', exact: true }).click();
  await page.getByRole('button', { name: 'AI 助手', exact: true }).last().click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/chat', async (route) => { await gate; await route.continue(); });
  const pending = page.waitForRequest((req) => req.url().endsWith('/api/chat'));
  await panel(page).getByRole('textbox', { name: '向 AI 提问' }).fill('AI验收任务 A 冻结');
  await panel(page).getByRole('button', { name: '发送', exact: true }).click();
  const original = (await pending).postDataJSON();
  expect(original.context.taskId).toBe(a.id);
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
