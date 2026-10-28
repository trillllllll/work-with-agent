import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.js';
import { e2eDatabase as db, resetE2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  expect((await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } })).ok()).toBe(true);
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => db.$disconnect());

test('思考实时追加、停止保留、完成折叠和刷新恢复', async ({ page }) => {
  await page.goto('/#/chat'); const panel = page.getByTestId('ai-assistant');
  await panel.getByLabel('向 AI 提问').fill('对话思考验收：开始');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  const reasoning = panel.getByTestId('assistant-reasoning');
  await expect(reasoning).toHaveAttribute('data-state', 'streaming');
  await reasoning.locator('summary').click();
  await expect(reasoning).toContainText('核对已经掌握的内容。');
  await expect(reasoning).toContainText('再安排一项练习。');
  await expect(panel.getByText('先完成计数器练习。', { exact: true })).toBeVisible();
  await expect(reasoning).not.toHaveAttribute('open');
  await page.reload(); await reasoning.locator('summary').click();
  await expect(reasoning).toContainText('核对已经掌握的内容。再安排一项练习。');
  await panel.getByLabel('向 AI 提问').fill('对话思考验收：停止');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  const last = panel.getByTestId('assistant-reasoning').last();
  await expect(last).toHaveAttribute('data-state', 'streaming');
  await panel.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(last).toHaveAttribute('data-state', 'interrupted');
  await page.reload(); await last.locator('summary').click();
  await expect(last).toContainText('核对已经掌握的内容。');
  await expect(last).toHaveAttribute('data-state', 'interrupted');
});

test('旧对话来源去重、正文编号打开原文、查询分组和窄屏标题', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const id = randomUUID(), refId = randomUUID(), stamp = '2026-10-28T01:00:00.000Z';
  await db.conversation.createMany({ data: [{ id, createdAt: stamp, updatedAt: stamp }, { id: refId, createdAt: stamp, updatedAt: stamp }] });
  const original = await db.message.create({ data: { conversationId: refId, role: 'assistant', content: '闭包保留对外层变量的引用。', createdAt: stamp } });
  const source = { kind: 'conversation', id: original.id, title: '历史对话 · 2026-10-27T14:08:29.558Z' };
  const reasoning = { type: 'assistant_reasoning', text: '先核对上次学习记录。', startedAt: stamp, endedAt: '2026-10-28T01:00:04.000Z', status: 'completed' };
  await db.message.createMany({ data: [
    { id: `${id}-u`, conversationId: id, role: 'user', content: '我学到哪里了？', createdAt: stamp },
    { id: `${id}-a`, conversationId: id, role: 'assistant', content: '', toolCalls: JSON.stringify([{ id: 'q1', type: 'function', function: { name: 'conversation_search', arguments: '{}' } }]), partsJson: JSON.stringify([reasoning, { type: 'assistant_sources', sources: [source, source] }]), createdAt: '2026-10-28T01:00:01.000Z' },
    { id: `${id}-t`, conversationId: id, role: 'tool', toolCallId: 'q1', content: JSON.stringify({ assistantMessageId: `${id}-a`, toolName: 'conversation_search', success: true, data: { messages: [] } }), createdAt: '2026-10-28T01:00:02.000Z' },
    { id: `${id}-b`, conversationId: id, role: 'assistant', content: '你已经理解闭包。[1](#source-1)', createdAt: '2026-10-28T01:00:03.000Z' },
  ] });
  await page.addInitScript(id => localStorage.setItem('dovun.conversationId', id), id);
  await page.goto('/#/chat'); const panel = page.getByTestId('ai-assistant');
  await expect(panel.getByTestId('assistant-sources')).toHaveCount(1);
  await panel.getByRole('button', { name: /查看来源 1/ }).click();
  const dialog = page.getByRole('dialog', { name: '参考来源', exact: true });
  await expect(dialog).toContainText('闭包保留对外层变量的引用。');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await panel.getByTestId('assistant-sources').locator('summary').click();
  await expect(panel.locator('.assistant-source-row')).toHaveCount(1);
  await expect(panel.locator('.assistant-source-row')).not.toContainText('T14:08');
  await panel.getByRole('button', { name: /查询了 1 项/ }).click();
  await expect(panel.getByRole('button', { name: /查找过往对话/ })).toBeVisible();
  await panel.getByTestId('assistant-reasoning').locator('summary').click();
  await page.screenshot({ path: `/tmp/dovun-chat-${test.info().project.name}.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: `/tmp/dovun-chat-dark-${test.info().project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('上翻后发送回到底部，随后上翻流式输出不抢滚动', async ({ page }) => {
  const id = randomUUID();
  const stamp = '2026-10-28T01:00:00.000Z';
  const filler = '这段较长的历史内容用于把会话撑出足够的滚动高度，确保列表在发送前后都明显超出可视区域。';
  await db.conversation.create({ data: { id, createdAt: stamp, updatedAt: stamp } });
  await db.message.createMany({ data: Array.from({ length: 24 }, (_, index) => ({
    id: `${id}-m${index}`,
    conversationId: id,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `历史消息 ${index}：${filler}`,
    createdAt: stamp,
  })) });
  await page.addInitScript(id => localStorage.setItem('dovun.conversationId', id), id);
  await page.goto('/#/chat');
  const panel = page.getByTestId('ai-assistant');
  const scroller = panel.locator('[data-chat-scroll]');
  await expect(scroller).toBeVisible();
  const distance = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  // The seeded thread must overflow; the initial view is already pinned to the bottom.
  expect(await scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200);
  expect(await distance()).toBeLessThanOrEqual(2);
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await panel.getByLabel('向 AI 提问').fill('对话思考验收：开始');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  // 发送即重新钉住底部：用户消息渲染后立即贴底。
  await expect.poll(async () => distance(), { timeout: 5_000 }).toBeLessThanOrEqual(2);
  await expect(panel.getByTestId('assistant-reasoning')).toHaveAttribute('data-state', 'streaming');
  // 流式期间再次上翻：脱钉后新增内容不再抢滚动。
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await expect(panel.getByText('先完成计数器练习。', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(await distance()).toBeGreaterThan(100);
});
