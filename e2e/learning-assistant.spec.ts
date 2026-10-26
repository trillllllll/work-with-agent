import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const panel = (page: Page) => page.getByTestId('ai-assistant');

async function open(page: Page) { await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click(); await expect(panel(page)).toBeVisible(); }

async function switchToStudy(page: Page) {
  await panel(page).getByRole('button', { name: '切换助手', exact: true }).click();
  await page.getByRole('menuitem', { name: '学习助手', exact: true }).click();
  await expect(panel(page).getByRole('heading', { name: '学习助手' })).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  const response = await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  expect(response.ok()).toBe(true);
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('study assistant keeps its own session and writes learning maps through approval', async ({ page, isMobile }) => {
  await page.goto('/#/inbox');
  await open(page);
  await switchToStudy(page);

  // 手机上助手全屏；先收起再看学习地图空态。
  if (isMobile) await panel(page).getByRole('button', { name: '返回当前页面', exact: true }).click();
  await page.evaluate(() => { location.hash = '/learning'; });
  await expect(page.getByRole('heading', { name: '还没有学习地图' })).toBeVisible();
  await page.getByRole('button', { name: '问学习助手', exact: true }).click();
  await expect(panel(page)).toBeVisible();

  const sent = page.waitForRequest((request) => request.url().endsWith('/api/chat') && request.method() === 'POST');
  await panel(page).getByRole('textbox', { name: '向 AI 提问' }).fill('学习地图验收：整理一张Rust学习地图');
  await panel(page).getByRole('button', { name: '发送', exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.identityId).toBe('study');
  expect(body.context.page).toBe('learning');

  // 学习域写入必须走确认卡。
  await expect(page.getByRole('button', { name: '确认修改', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '确认修改', exact: true }).click();
  await expect(panel(page).getByText('学习地图已创建，可以到学习地图页查看。', { exact: true })).toBeVisible({ timeout: 20_000 });

  // 地图落地后学习地图页展示目标、统计与图谱。手机上面板全屏，先收起再看页面。
  if (isMobile) await panel(page).getByRole('button', { name: '返回当前页面', exact: true }).click();
  await expect(page.getByRole('heading', { name: '学习地图', exact: true })).toBeVisible();
  await expect(page.getByText('掌握 Rust 基础')).toBeVisible();
  await expect(page.getByText('主题: 1')).toBeVisible();
  await expect(page.getByRole('img', { name: '学习地图结构图，颜色代表掌握度' })).toBeVisible();

  // 会话历史按身份隔离：列表请求带上 identityId=study，且能看到本会话。
  if (isMobile) await open(page);
  const historyRequest = page.waitForRequest((request) => request.url().includes('/api/conversations?identityId=study'));
  await panel(page).getByRole('button', { name: '历史对话', exact: true }).click();
  expect((await historyRequest).url()).toContain('identityId=study');
  await expect(panel(page).getByText('学习地图验收', { exact: false }).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // 切回工作助手后标题恢复，且开始新会话。
  await panel(page).getByRole('button', { name: '切换助手', exact: true }).click();
  await page.getByRole('menuitem', { name: '工作助手', exact: true }).click();
  await expect(panel(page).getByRole('heading', { name: 'Dovun 工作助手', level: 2 })).toBeVisible();

  // 全局提案入口可以跳回另一位助手的会话，身份须随服务端会话一起恢复。
  const studyConversation = await e2eDatabase.conversation.findFirstOrThrow({ where: { identityId: 'study' } });
  const approval = await e2eDatabase.approval.findFirstOrThrow({ where: { conversationId: studyConversation.id } });
  await page.evaluate(({ approvalId, conversationId }) => {
    window.dispatchEvent(new CustomEvent('dovun-adjust-approval', { detail: { approvalId, conversationId, title: '调整学习地图' } }));
  }, { approvalId: approval.id, conversationId: studyConversation.id });
  await expect(panel(page).getByRole('heading', { name: '学习助手', exact: true })).toBeVisible();
  const adjusted = page.waitForRequest((request) => request.url().endsWith('/api/chat') && request.method() === 'POST');
  await panel(page).getByRole('textbox', { name: '向 AI 提问' }).fill('继续聊学习计划');
  await panel(page).getByRole('button', { name: '发送', exact: true }).click();
  const adjustedBody = (await adjusted).postDataJSON();
  expect(adjustedBody.identityId).toBe('study');
  expect(adjustedBody.conversationId).toBe(studyConversation.id);

  // 即使浏览器保存的身份过期，重新打开会话也以服务端归属为准。
  await expect.poll(() => e2eDatabase.agentRun.count({ where: { conversationId: studyConversation.id, state: { in: ['queued', 'running'] } } }), { timeout: 20_000 }).toBe(0);
  await page.evaluate(() => localStorage.setItem('dovun.assistantIdentity', 'work'));
  await page.reload();
  await open(page);
  await expect(panel(page).getByRole('heading', { name: '学习助手', exact: true })).toBeVisible();
});
