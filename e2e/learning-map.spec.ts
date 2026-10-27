import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const title = '版本校验与笔记的持久保存';
let mapId: string, nodeId: string;
async function command(request: APIRequestContext, commands: unknown[]) {
  const response = await request.post(`${api}/api/v1/commands`,{ data: { requestId: randomUUID(),commands } });
  expect(response.ok(),await response.text()).toBe(true);
  return (await response.json()).data.results;
}
async function outline(page: Page) { await page.getByRole('button', { name: '知识目录',exact: true }).click(); }
async function openNote(page: Page) { await outline(page); await page.getByRole('button', { name: new RegExp(title) }).click(); await expect(page.getByTestId('learning-note-editor').getByRole('textbox')).toBeVisible(); }
async function closeAssistant(page: Page,isMobile: boolean) { if (isMobile) await page.getByTestId('ai-assistant').getByRole('button',{ name: '返回当前页面',exact: true }).click(); }
test.beforeEach(async ({ page,request }) => {
  await resetE2eDatabase();
  await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1',model: 'mock-model',apiKey: 'e2e-key' } });
  const rows = await command(request,[
    { kind: 'learning.map.create',clientRef: 'map',input: { title: '真实学习主题',goal: '理解机制，再用实践校验模型。' } },
    { kind: 'learning.node.create',clientRef: 'group',input: { mapId: { $ref: 'map' },parentId: null,kind: 'topic',title: '知识建模',detail: '',sortOrder: 0 } },
    { kind: 'learning.node.create',input: { mapId: { $ref: 'map' },parentId: { $ref: 'group' },kind: 'item',title,detail: '# 我的模型\n\n真实笔记正文。',status: 'learning',sortOrder: 0 } },
    { kind: 'learning.node.create',input: { mapId: { $ref: 'map' },parentId: { $ref: 'group' },kind: 'item',title: '独立验证与反馈',detail: '',status: 'review',sortOrder: 1 } },
    { kind: 'learning.node.create',input: { mapId: { $ref: 'map' },parentId: null,kind: 'topic',title: '主动提取',detail: '',sortOrder: 1 } },
  ]);
  mapId = rows[0].id; nodeId = rows[2].id;
  await page.addInitScript(() => { localStorage.setItem('dovun.theme','light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/learning');
});
test.afterAll(() => e2eDatabase.$disconnect());

test('real notes preserve drafts, save four-state mastery and protect concurrent AI edits', async ({ page,request },testInfo) => {
  await openNote(page);
  const editor = page.getByTestId('learning-note-editor').getByRole('textbox');
  await editor.fill('人工编辑的模型，仍需实践检验。');
  await page.getByRole('combobox',{ name: '掌握情况',exact: true }).click();
  await page.getByRole('option',{ name: '↻ 需巩固',exact: true }).click();
  await page.getByRole('button',{ name: '返回地图',exact: true }).click();
  await openNote(page);
  await expect(editor).toContainText('人工编辑的模型');
  await page.getByRole('button',{ name: '保存',exact: true }).click();
  await expect.poll(async () => (await e2eDatabase.learningNode.findUniqueOrThrow({ where: { id: nodeId } })).status).toBe('review');
  await expect(editor).toContainText('人工编辑的模型');
  const saved = await e2eDatabase.learningNode.findUniqueOrThrow({ where: { id: nodeId } });
  await editor.fill('本地尚未保存的新正文');
  await command(request,[{ kind: 'learning.node.update',targetId: nodeId,expectedRevision: saved.revision,input: { status: 'done',title: '远端修改后的标题' } }]);
  await page.getByRole('button',{ name: '返回地图',exact: true }).click();
  // Reopening the page refetches from the real server while retaining the local draft.
  await page.reload();
  await outline(page); await page.getByRole('button',{ name: /远端修改后的标题/ }).click();
  await expect(page.getByRole('alert')).toContainText('这篇笔记已被其他操作更新');
  await expect(editor).toContainText('本地尚未保存的新正文');
  await page.getByRole('button',{ name: '保留我的修改并合并',exact: true }).click();
  await expect(page.getByRole('textbox',{ name: '笔记标题',exact: true })).toHaveValue('远端修改后的标题');
  await expect(page.getByRole('combobox',{ name: '掌握情况',exact: true })).toContainText('已掌握');
  await page.getByRole('button',{ name: '保存',exact: true }).click();
  await expect.poll(async () => (await e2eDatabase.learningNode.findUniqueOrThrow({ where: { id: nodeId } })).detail).toContain('本地尚未保存的新正文');
  await page.screenshot({ path: testInfo.outputPath('real-note.png'),fullPage: true });
});

test('ECharts tiles really collapse, zoom, open notes and preserve the view; both themes fit', async ({ page,isMobile },testInfo) => {
  const errors: string[] = []; page.on('pageerror',error => errors.push(error.message));
  if (isMobile) await expect(page.getByRole('button',{ name: new RegExp(title) })).toBeVisible();
  await page.getByRole('button',{ name: '地图',exact: true }).click();
  const graph = page.getByTestId('echarts-tree');
  await expect(graph).toHaveAttribute('data-chart-ready','true');
  await expect(graph.locator('svg')).toBeVisible();
  const groupText = graph.locator('text').filter({ hasText: '知识建' }).first();
  await groupText.click();
  await expect(graph).toHaveAttribute('data-collapsed',/true/);
  await groupText.click();
  await expect(graph.locator('text').filter({ hasText: title.slice(0,5) }).first()).toBeVisible();
  if (!isMobile) {
    await graph.hover(); await page.mouse.wheel(0,-120);
    await expect.poll(() => graph.getAttribute('data-zoom')).not.toBe('1');
  }
  const zoom = await graph.getAttribute('data-zoom');
  await graph.locator('text').filter({ hasText: title.slice(0,5) }).first().click();
  await expect(page.getByRole('textbox',{ name: '笔记标题',exact: true })).toHaveValue(title);
  await page.getByRole('button',{ name: '返回地图',exact: true }).click();
  await expect(graph).toHaveAttribute('data-zoom',zoom!);
  await page.getByRole('button',{ name: '适应画布',exact: true }).click();
  await expect(graph).toHaveAttribute('data-zoom','1');
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => { localStorage.setItem('dovun.theme',theme); window.dispatchEvent(new StorageEvent('storage', { key: 'dovun.theme',newValue: theme })); },theme);
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /light/);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`map-${theme}.png`),fullPage: true });
  }
  expect(errors).toEqual([]);
});

test('explicit composer context anchors a real AI read/edit proposal and clears on a new conversation', async ({ page,isMobile }) => {
  await openNote(page);
  // Opening a note does not open or bind the assistant.
  await page.getByRole('button',{ name: '加入对话上下文',exact: true }).click();
  const panel = page.getByTestId('ai-assistant');
  await expect(panel.getByRole('heading',{ name: '学习助手',exact: true })).toBeVisible();
  // Use the existing attachment marker; exact translated label is asserted by title.
  const marker = panel.getByRole('button',{ name: new RegExp('移除.*'+title) });
  await expect(marker).toBeVisible();
  const sent = page.waitForRequest(request => request.url().endsWith('/api/chat') && request.method() === 'POST');
  await panel.getByRole('textbox',{ name: '向 AI 提问' }).fill('笔记真实编辑验收：补充应用边界并设为需巩固');
  await panel.getByRole('button',{ name: '发送',exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.context.attachments[0]).toMatchObject({ learningMapId: mapId,learningNodeId: nodeId,learningRevision: 1,unsaved: false });
  expect(body.context.attachments[0].taskId).toBeUndefined();
  await expect(panel.getByRole('button',{ name: '确认修改',exact: true })).toBeVisible({ timeout: 20000 });
  expect((await e2eDatabase.learningNode.findUniqueOrThrow({ where: { id: nodeId } })).detail).not.toContain('AI 补充');
  await panel.getByRole('button',{ name: '确认修改',exact: true }).click();
  await expect.poll(async () => (await e2eDatabase.learningNode.findUniqueOrThrow({ where: { id: nodeId } })).detail).toContain('AI 补充');
  await expect(panel.getByText('知识笔记已更新。',{ exact: true })).toBeVisible({ timeout: 20000 });
  await closeAssistant(page,isMobile);
  await expect(page.getByTestId('learning-note-editor').getByRole('textbox')).toContainText('AI 补充');
  await page.getByRole('button',{ name: '加入对话上下文',exact: true }).click();
  await expect(marker).toBeVisible(); await marker.click(); await expect(marker).toHaveCount(0);
  await closeAssistant(page,isMobile);
  await page.getByRole('button',{ name: '加入对话上下文',exact: true }).click();
  await panel.getByRole('button',{ name: '新对话',exact: true }).click();
  await expect(marker).toHaveCount(0);
});

test('manual topic, group and note creation use real commands and confirmed deletion', async ({ page },testInfo) => {
  await page.getByRole('button',{ name: '新建主题',exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox',{ name: '名称',exact: true }).fill('人工新主题');
  await dialog.getByRole('textbox',{ name: '主题说明',exact: true }).fill('可以继续维护的笔记');
  await dialog.getByRole('button',{ name: '保存',exact: true }).click();
  await expect(page.getByRole('combobox',{ name: '学习主题',exact: true })).toContainText('人工新主题');
  await expect(page.getByRole('button',{ name: '撤销',exact: true })).toHaveCount(0);
  await page.getByRole('button',{ name: '新建知识点 / 分组',exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox',{ name: '名称',exact: true }).fill('人工分组');
  await dialog.getByRole('combobox',{ name: '节点类型',exact: true }).click();
  await page.getByRole('option',{ name: '结构分组',exact: true }).click();
  await dialog.getByRole('button',{ name: '保存',exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button',{ name: '新建知识点 / 分组',exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox',{ name: '名称',exact: true }).fill('新知识点');
  await dialog.getByRole('combobox',{ name: '所属分组',exact: true }).click();
  await page.getByRole('option',{ name: '人工分组',exact: true }).click();
  await dialog.getByRole('button',{ name: '保存',exact: true }).click();
  await expect(page.getByRole('textbox',{ name: '笔记标题',exact: true })).toHaveValue('新知识点');
  await page.getByTestId('learning-note-editor').getByRole('textbox').fill('新知识点的长期笔记');
  await page.getByRole('button',{ name: '保存',exact: true }).click();
  await expect.poll(() => e2eDatabase.learningNode.count({ where: { title: '新知识点',detail: { contains: '长期笔记' } } })).toBe(1);
  await page.getByRole('button',{ name: '返回地图',exact: true }).click();
  await outline(page);
  await page.getByRole('button',{ name: '编辑分组：人工分组',exact: true }).click();
  await page.getByRole('dialog').getByRole('button',{ name: '删除分组',exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('下级 1 个节点');
  expect(await e2eDatabase.learningNode.count({ where: { title: '新知识点',deletedAt: null } })).toBe(1);
  await page.getByRole('dialog').getByRole('button',{ name: '确认',exact: true }).click();
  await expect.poll(() => e2eDatabase.learningNode.count({ where: { title: '新知识点',deletedAt: null } })).toBe(0);
  await page.getByRole('combobox',{ name: '学习主题',exact: true }).click();
  await page.getByRole('option',{ name: '真实学习主题',exact: true }).click();
  await expect(page.getByText('理解机制，再用实践校验模型。',{ exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('manual-crud.png'),fullPage: true });
});

test('deep hierarchies retain separated tile columns and long titles in a scrolling canvas', async ({ page,request,isMobile }) => {
  const chain: unknown[] = [{ kind: 'learning.map.create',clientRef: 'deep',input: { title: '深层结构',goal: '' } }];
  for (let i=0;i<5;i++) chain.push({ kind: 'learning.node.create',clientRef: `level${i}`,input: { mapId: { $ref: 'deep' },parentId: i ? { $ref: `level${i-1}` } : null,kind: 'topic',title: `层级${i}`,detail: '',sortOrder: 0 } });
  const longTitle = '边界与验证'.repeat(50);
  chain.push({ kind: 'learning.node.create',input: { mapId: { $ref: 'deep' },parentId: { $ref: 'level4' },kind: 'item',title: longTitle,detail: '',sortOrder: 0 } });
  await command(request,chain);
  await page.reload();
  await page.getByRole('combobox',{ name: '学习主题',exact: true }).click();
  await page.getByRole('option',{ name: '深层结构',exact: true }).click();
  await page.getByRole('button',{ name: '地图',exact: true }).click();
  const graph = page.getByTestId('echarts-tree');
  await expect(graph).toHaveAttribute('data-chart-ready','true');
  const positions = await graph.locator('text').evaluateAll(elements => elements.filter(el => /^▾ 层级\d$/.test(el.textContent ?? '')).map(el => el.getBoundingClientRect().x));
  expect(positions.length).toBe(5);
  for (let i=1;i<positions.length;i++) expect(Math.abs(positions[i]-positions[i-1])).toBeGreaterThan(120);
  expect((await graph.locator('text').allTextContents()).join('')).toContain(longTitle);
  const scrollable = await graph.evaluate(element => element.parentElement!.scrollWidth > element.parentElement!.clientWidth);
  expect(scrollable).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (!isMobile) {
    const width = await graph.evaluate(element => element.parentElement!.clientWidth);
    await page.getByRole('button',{ name: '问学习助手',exact: true }).click();
    await expect.poll(() => graph.evaluate(element => element.parentElement!.clientWidth)).toBeLessThan(width);
    await page.getByTestId('ai-assistant').getByRole('button',{ name: '关闭聊天',exact: true }).click();
    await expect.poll(() => graph.evaluate(element => element.parentElement!.clientWidth)).toBe(width);
  }
});

test('a long map title stays inside the real chart with an asymmetric forest', async ({ page,request }) => {
  const chain: unknown[] = [
    { kind: 'learning.map.create',clientRef: 'longmap',input: { title: 'LongTitle '.repeat(19),goal: '' } },
    { kind: 'learning.node.create',clientRef: 'asymmetric',input: { mapId: { $ref: 'longmap' },parentId: null,kind: 'topic',title: 'Understand asynchronous processing and concurrency control',detail: '',sortOrder: 0 } },
    { kind: 'learning.node.create',input: { mapId: { $ref: 'longmap' },parentId: null,kind: 'item',title: 'Root note',detail: '',sortOrder: 1 } },
  ];
  for (let i=0;i<4;i++) chain.push({ kind: 'learning.node.create',input: { mapId: { $ref: 'longmap' },parentId: { $ref: 'asymmetric' },kind: 'item',title: `Note ${i}`,detail: '',sortOrder: i } });
  const rows = await command(request,chain);
  await page.reload();
  await page.getByRole('combobox',{ name: '学习主题',exact: true }).click();
  await page.getByRole('option',{ name: 'LongTitle '.repeat(19).trim(),exact: true }).click();
  await page.getByRole('button',{ name: '地图',exact: true }).click();
  // Desktop shows the whole forest. Phone can focus the single group, also using exact text measurement.
  const graph = page.getByTestId('echarts-tree');
  await expect(graph).toHaveAttribute('data-chart-ready','true');
  const clipping = await graph.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll('text')].some(text => { const box = text.getBoundingClientRect(); return box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1; });
  });
  expect(clipping).toBe(false);
  expect(rows[0].title.length).toBeLessThanOrEqual(200);
});
