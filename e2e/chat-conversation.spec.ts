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
  await panel.getByTestId('assistant-process').locator(':scope > summary').click();
  await reasoning.locator('summary').click();
  await expect(reasoning).toContainText('核对已经掌握的内容。');
  await expect(reasoning).toContainText('再安排一项练习。');
  await expect(panel.getByText('先完成计数器练习。', { exact: true })).toBeVisible();
  await expect(reasoning).not.toHaveAttribute('open');
  await page.reload(); await panel.getByTestId('assistant-process').locator(':scope > summary').click(); await reasoning.locator('summary').click();
  await expect(reasoning).toContainText('核对已经掌握的内容。再安排一项练习。');
  await panel.getByLabel('向 AI 提问').fill('对话思考验收：停止');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  const last = panel.getByTestId('assistant-reasoning').last();
  await expect(last).toHaveAttribute('data-state', 'streaming');
  await panel.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(last).toHaveAttribute('data-state', 'interrupted');
  await page.reload(); await panel.getByTestId('assistant-process').last().locator(':scope > summary').click(); await last.locator('summary').click();
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
  await panel.getByTestId('assistant-process').locator(':scope > summary').click();
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

test('多轮工具与思考合为一条过程，失败收起可见且下一次请求独立', async ({ page }, info) => {
  const reasoning = { text: '先核对任务，再核对清单。', startedAt: '2026-10-29T01:00:00Z', endedAt: '2026-10-29T01:00:01Z', status: 'completed' };
  const round = (id: string, count: number) => ({ id, role: 'assistant', runId: 'first', content: '', status: 'completed', reasoning,
    toolCalls: JSON.stringify(Array.from({length:count}, (_,i) => ({id:`${id}-${i}`,function:{name:'list_tasks',arguments:'{}'}}))) });
  const results = (id: string, count: number) => Array.from({length:count},(_,i) => ({ id:`result-${id}-${i}`,role:'tool',toolCallId:`${id}-${i}`,content:JSON.stringify({assistantMessageId:id,toolName:'list_tasks',success:i !== 1,data:i !== 1 ? [] : undefined,error:i === 1 ? '查询超时' : undefined}) }));
  await page.route('**/api/conversations/process-history/snapshot', route => route.fulfill({json:{data:{messages:[
    {id:'u',role:'user',content:'整理今天的任务'},round('a',3),...results('a',3),round('b',2),...results('b',2),
    {id:'answer',role:'assistant',runId:'first',content:'已整理可用结果。',status:'completed'},
    {id:'u2',role:'user',content:'再看一下明天'},
    {id:'next',role:'assistant',runId:'second',content:'明天没有待办。',status:'completed',reasoning},
  ],approvals:[],watermarks:{},activeRun:null}}}));
  await page.addInitScript(() => localStorage.setItem('dovun.conversationId','process-history'));
  await page.goto('/#/chat');
  const panel = page.getByTestId('ai-assistant');
  const processes = panel.getByTestId('assistant-process');
  await expect(processes).toHaveCount(2);
  const first = processes.first();
  await expect(first).not.toHaveAttribute('open');
  await expect(first.locator(':scope > summary')).toContainText('有 2 项查询失败');
  await expect(first.locator(':scope > summary')).toContainText('查询 5 项 · 思考 2 次');
  await expect(panel.getByText('已整理可用结果。',{exact:true})).toBeVisible();
  await expect(panel.getByText('明天没有待办。',{exact:true})).toBeVisible();
  await first.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('open');
  await expect(first.getByTestId('assistant-reasoning')).toHaveCount(2);
  await expect(first.locator('.assistant-process-step')).toHaveCount(5);
  await first.getByTestId('assistant-reasoning').first().locator('summary').click();
  await expect(first.getByText(reasoning.text,{exact:true}).first()).toBeVisible();
  await page.screenshot({path:`/tmp/dovun-process-live-${info.project.name}.png`,fullPage:true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(processes).toHaveCount(2);
  await expect(first).not.toHaveAttribute('open');
  await expect(first.locator(':scope > summary')).toContainText('有 2 项查询失败');
});

test('消息已完成但整轮仍在执行工具时，显示当前查询而不是中断', async ({ page }) => {
  await page.route('**/api/conversations/process-active/snapshot', route => route.fulfill({json:{data:{
    messages:[{id:'active-message',runId:'active-process',role:'assistant',status:'completed',content:''}],
    approvals:[],watermarks:{},activeRun:{id:'active-process',state:'running'},
  }}}));
  await page.route('**/api/agent/runs/active-process/events?*', route => route.fulfill({json:{data: new URL(route.request().url()).searchParams.get('after') === '0' ? [{seq:1,type:'tool_call',data:{type:'tool_call',messageId:'active-message',toolCallId:'active-tool',toolName:'list_tasks',arguments:{}}}] : []}}));
  await page.route('**/api/agent/runs/active-process', route => route.fulfill({json:{data:{state:'running'}}}));
  await page.addInitScript(() => localStorage.setItem('dovun.conversationId','process-active'));
  await page.goto('/#/chat');
  const process = page.getByTestId('assistant-process');
  await expect(process).toHaveAttribute('data-state','streaming');
  await expect(process.locator(':scope > summary')).toContainText('查询任务');
  await expect(process.locator(':scope > summary')).not.toContainText('中断');
});
