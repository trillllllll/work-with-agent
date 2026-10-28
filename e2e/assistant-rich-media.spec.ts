import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  const saved = await request.patch(`${api}/api/settings`, { data: { model: 'mock', baseUrl: 'http://127.0.0.1:4010/v1', apiKey: 'test-key' } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(() => { (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('真实页面在回复完成前显示文字和图形，切换布局不重复发送，混排和重载一致', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  let requests = 0; page.on('request', (request) => { if (request.url().endsWith('/api/chat') && request.method() === 'POST') requests++; });
  await page.goto('/#/plan'); await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.getByLabel('向 AI 提问').fill('富媒体验收'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('[data-block-type=text]').first()).toContainText('文字流式前缀😀');
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  const conversationId = await page.evaluate(() => localStorage.getItem('dovun.conversationId'));
  await page.getByRole('button', { name: '放大到独立页' }).click();
  await expect(page.locator('[data-block-type=mermaid]')).toHaveAttribute('data-block-status', 'ready');
  await page.getByRole('button', { name: '缩小回原页面' }).click();
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0);
  await expect(page.locator('[data-block-type=text]').last()).toContainText('最后一段');
  await expect(page.getByRole('img', { name: '处理流程', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'SVG 图示', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /每周完成，浏览器验收数据/ })).toBeVisible();
  expect(requests).toBe(1); expect(await page.evaluate(() => localStorage.getItem('dovun.conversationId'))).toBe(conversationId);
  const before = await page.locator('[data-block-id]').evaluateAll((nodes) => nodes.map((node) => ({ id: node.getAttribute('data-block-id'), type: node.getAttribute('data-block-type'), status: node.getAttribute('data-block-status') })));
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.locator('[data-block-id]')).toHaveCount(7);
  expect(await page.locator('[data-block-id]').evaluateAll((nodes) => nodes.map((node) => ({ id: node.getAttribute('data-block-id'), type: node.getAttribute('data-block-type'), status: node.getAttribute('data-block-status') })))).toEqual(before);
  await page.getByRole('button', { name: '放大到独立页' }).click();
  const chart = page.locator('[data-block-type=chart]'); await expect(chart.locator('canvas')).toBeVisible();
  const download = page.waitForEvent('download'); await chart.getByRole('button', { name: '导出 PNG', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('chart.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: `/tmp/wwa-rich-media-${test.info().project.name}.png`, fullPage: true });
});

test('停止后保留已完成块，迟到内容不再出现，历史保持相同未完成状态', async ({ page }) => {
  await page.goto('/#/chat');
  await page.getByLabel('向 AI 提问').fill('富媒体验收停止'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('[data-block-type=mermaid]')).toHaveAttribute('data-block-status', 'ready');
  // mock 发完「中间说明」后停 5 秒。服务端按 100ms 批量下发文字，等这段文字真的到了页面再停止，
  // 否则这个块还停在 pending 类型（尚无文字），停止后变成 pending 错误块，不是文字块。
  await expect(page.locator('[data-block-type=text][data-block-status=pending]')).toContainText('中间说明');
  await page.getByRole('button', { name: '停止生成' }).click();
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0);
  await expect(page.locator('[data-block-type=text]').last()).toHaveAttribute('data-block-status', 'error');
  await expect(page.locator('[data-block-type=text]').last()).toContainText('中间说明');
  await expect(page.getByText('最后一段', { exact: false })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-block-type=mermaid]')).toHaveAttribute('data-block-status', 'ready');
  await expect(page.locator('[data-block-type=text]').last()).toHaveAttribute('data-block-status', 'error');
});


test('四类 Mermaid、四类图表、标准 SVG、图片布局和恶意块隔离', async ({ page, request }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  const conversation = await e2eDatabase.conversation.create({ data: {} });
  const items = [1, 2].map((index) => ({ id: `fixture-image-${index}`, url: `https://images.example.test/${index}.svg`, thumbnail: `https://images.example.test/${index}.svg`, title: `测试图片${index}`, sourceUrl: `https://sources.example.test/${index}`, searchedAt: '2026-10-19T00:00:00Z' }));
  await e2eDatabase.message.create({ data: { conversationId: conversation.id, role: 'tool', toolCallId: 'fixture-search', content: JSON.stringify({ toolName: 'image_search', success: true, data: { searchId: 'fixture-authorized-search', items } }) } });
  await page.addInitScript((id) => localStorage.setItem('dovun.conversationId', id), conversation.id);
  await page.route('https://images.example.test/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40" fill="teal"/></svg>' }));
  await page.goto('/#/chat');
  await page.getByLabel('向 AI 提问').fill('可视化矩阵验收'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('矩阵结束。', { exact: true })).toBeVisible();
  for (const name of ['流程图', '时序图', '状态图', '类图', '标准 SVG']) await expect(page.getByRole('img', { name, exact: true })).toBeVisible();
  for (const name of ['line', 'bar', 'pie', 'scatter']) await expect(page.getByRole('img', { name: `${name}，矩阵验收数据`, exact: true }).locator('canvas')).toBeVisible();
  const images = page.locator('[data-block-type=image_search]'); await expect(images).toHaveCount(3);
  await expect(images.nth(0).getByRole('button', { name: /^查看图片/ })).toHaveCount(1);
  await expect(images.nth(1).getByRole('button', { name: /^查看图片/ })).toHaveCount(2);
  await images.nth(2).getByRole('button', { name: '下一张', exact: true }).click();
  await expect(images.nth(2).getByRole('img')).toHaveAttribute('alt', '测试图片2');
  await images.nth(1).getByRole('button', { name: '查看图片：测试图片1' }).click();
  await expect(page.getByRole('dialog').getByRole('link', { name: '查看图片来源' })).toHaveAttribute('href', 'https://sources.example.test/1');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-block-type=svg][data-block-status=error]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__unsafeExecuted)).toBeUndefined();
  const diagram = page.locator('[data-block-type=mermaid]').first();
  const download = page.waitForEvent('download'); await diagram.getByRole('button', { name: 'SVG', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('diagram.svg');
  await diagram.getByRole('button', { name: '放大查看' }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: '放大图形', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '切换主题' }).click(); await page.getByRole('menuitem', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByRole('img', { name: '流程图', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'line，矩阵验收数据' }).locator('canvas')).toBeVisible();
});

test('刷新进行中的流，恢复轮询失败后重连同一请求，不丢前文或重复发送', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  let sends = 0; page.on('request', (request) => { if (request.url().endsWith('/api/chat') && request.method() === 'POST') sends++; });
  await page.goto('/#/chat');
  await page.getByLabel('向 AI 提问').fill('富媒体验收停止时长用于重连'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('[data-block-type=text]').first()).toContainText('文字流式前缀😀');
  const conversationId = await page.evaluate(() => localStorage.getItem('dovun.conversationId'));
  await page.route('**/api/agent/runs/*/events?*', (route) => route.abort('internetdisconnected'));
  await page.reload();
  await expect(page.locator('[data-block-type=text]').first()).toContainText('文字流式前缀😀');
  await expect(page.getByText('聊天连接中断，可重试恢复本次请求。', { exact: true })).toBeVisible();
  await page.unroute('**/api/agent/runs/*/events?*');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('[data-block-type=text]').last()).toContainText('最后一段', { timeout: 10000 });
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0);
  expect(sends).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('dovun.conversationId'))).toBe(conversationId);
  expect(errors).toEqual([]);
});

test('新会话首帧丢失后刷新，用原请求编号找回，不再发送第二次', async ({ page }) => {
  let sends = 0; page.on('request', (request) => { if (request.url().endsWith('/api/chat') && request.method() === 'POST') sends++; });
  await page.route('**/api/chat', async (route) => {
    try { const response = await route.fetch(); await route.fulfill({ response, body: '' }); } catch { /* The page deliberately reloads before receiving the response. */ }
  });
  await page.goto('/#/chat');
  await page.getByLabel('向 AI 提问').fill('富媒体验收停止首帧恢复'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => e2eDatabase.agentRun.count()).toBe(1);
  const key = await page.evaluate(() => localStorage.getItem('dovun.pendingRequestKey'));
  expect(key).toBeTruthy();
  await page.reload();
  await expect(page.locator('[data-block-type=text]').last()).toContainText('最后一段', { timeout: 10000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dovun.pendingRequestKey'))).toBeNull();
  expect(sends).toBe(1); expect(await e2eDatabase.agentRun.count()).toBe(1);
  const run = await e2eDatabase.agentRun.findFirstOrThrow(); expect(run.requestKey).toBe(key);
});

test('首条请求在到达服务器前断网，刷新后用原编号和原内容重发一次', async ({ page }) => {
  const bodies: string[] = [];
  await page.route('**/api/chat', async (route) => {
    bodies.push(route.request().postData()!);
    if (bodies.length === 1) await route.abort('internetdisconnected');
    else await route.continue();
  });
  await page.goto('/#/chat');
  await page.getByLabel('向 AI 提问').fill('富媒体验收首条离线恢复'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(await e2eDatabase.agentRun.count()).toBe(0);
  const key = await page.evaluate(() => localStorage.getItem('dovun.pendingRequestKey')); expect(key).toBeTruthy();
  await page.reload();
  await expect(page.locator('[data-block-type=text]').last()).toContainText('最后一段', { timeout: 15000 });
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
  expect(await e2eDatabase.agentRun.count()).toBe(1);
  const run = await e2eDatabase.agentRun.findFirstOrThrow(); expect(run.requestKey).toBe(key);
  expect(await e2eDatabase.message.count({ where: { conversationId: run.conversationId, role: 'user' } })).toBe(1);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dovun.pendingRequestBody'))).toBeNull();
  await page.getByLabel('向 AI 提问').fill('下一条可以正常发送');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
});

test('未确认的离线请求阻止切换历史和跨会话调整，不把新输入当成旧请求重发', async ({ page }) => {
  const other = await e2eDatabase.conversation.create({ data: {} });
  await e2eDatabase.message.create({ data: { conversationId: other.id, role: 'user', content: '另一段历史对话' } });
  let sends = 0;
  await page.route('**/api/chat', (route) => { sends++; return route.abort('internetdisconnected'); });
  await page.route('**/api/agent/requests/*', (route) => route.abort('internetdisconnected'));
  await page.goto('/#/chat');
  await page.getByLabel('向 AI 提问').fill('尚未到达服务器'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('聊天连接中断，可重试恢复本次请求。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '历史对话', exact: true }).click();
  await page.getByRole('button', { name: /另一段历史对话/ }).click();
  expect(await page.evaluate(() => localStorage.getItem('dovun.conversationId'))).toBeNull();
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('dovun-adjust-approval', { detail: { approvalId: 'other-approval', conversationId: id } })), other.id);
  expect(await page.evaluate(() => localStorage.getItem('dovun.conversationId'))).toBeNull();
  await page.getByLabel('向 AI 提问').fill('另一条新输入'); await page.getByRole('button', { name: '发送', exact: true }).click();
  expect(sends).toBe(1); await expect(page.getByLabel('向 AI 提问')).toHaveValue('另一条新输入');
  expect(await e2eDatabase.agentRun.count()).toBe(0);
});

test('输入法候选确认不误发送，减少动画模式停用流式光标闪烁', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let sends = 0; page.on('request', (request) => { if (request.url().endsWith('/api/chat') && request.method() === 'POST') sends++; });
  await page.goto('/#/chat');
  const input = page.getByLabel('向 AI 提问'); await input.fill('富媒体验收输入法确认');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: false, bubbles: true });
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: false, bubbles: true });
  await input.dispatchEvent('compositionend');
  expect(sends).toBe(0); await expect(input).toHaveValue('富媒体验收输入法确认');
  await input.press('Enter');
  const text = page.locator('[data-block-type=text]').first(); await expect(text).toContainText('文字流式前缀');
  const caret = text.locator('.streaming-caret'); await expect(caret).toBeVisible();
  expect(await caret.evaluate((element) => getComputedStyle(element, '::after').animationName)).toBe('none');
  await expect(page.getByText('最后一段', { exact: false })).toBeVisible(); expect(sends).toBe(1);
});

test('浏览器无法保存请求恢复数据时保留输入，不发送或锁住对话', async ({ page }) => {
  let sends = 0; page.on('request', (request) => { if (request.url().endsWith('/api/chat') && request.method() === 'POST') sends++; });
  await page.goto('/#/chat');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).__restorePendingStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('dovun.pendingRequest')) throw new DOMException('full', 'QuotaExceededError'); return original.call(this, key, value); };
  });
  const input = page.getByLabel('向 AI 提问'); await input.fill('富媒体验收存储恢复');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('无法保存发送状态，消息尚未发出。请检查本机存储后重试。', { exact: true })).toBeVisible();
  expect(sends).toBe(0); await expect(input).toHaveValue('富媒体验收存储恢复');
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0);
  await page.evaluate(() => (window as any).__restorePendingStorage());
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('最后一段', { exact: false })).toBeVisible(); expect(sends).toBe(1);
});
