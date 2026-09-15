import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = 'http://127.0.0.1:3001';
const composerPlaceholder = '例如：创建任务：整理 API 文档';

async function responseData<T>(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as T;
}

async function createTopic(request: APIRequestContext, name: string) {
  const response = await request.post(`${apiUrl}/api/topics`, { data: { name, isExploration: true } });
  return responseData<{ id: string }>(response);
}

async function configureMock(request: APIRequestContext, model = 'mock-model') {
  const response = await request.patch(`${apiUrl}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model, apiKey: 'e2e-key' } });
  expect(response.ok(), await response.text()).toBe(true);
}

async function taskCount(request: APIRequestContext, topicId: string) {
  const response = await request.get(`${apiUrl}/api/tasks?topicId=${encodeURIComponent(topicId)}`);
  return (await responseData<unknown[]>(response)).length;
}

async function send(page: Page, message: string) {
  await page.getByPlaceholder(composerPlaceholder).fill(message);
  await page.getByRole('button', { name: '发送' }).click();
}

test.beforeEach(async () => {
  await resetE2eDatabase();
});

test.afterAll(async () => {
  await e2eDatabase.$disconnect();
});

test.describe('Agent 工作室 MVP', () => {
  test('收集箱可快速收集任务并归入已有主题', async ({ page, isMobile, request }) => {
    test.skip(Boolean(isMobile), '收集箱桌面整理流程在桌面视口验收');
    const topic = await createTopic(request, 'E2E 收集主题');
    const task = await responseData<{ id: string }>(await request.post(`${apiUrl}/api/tasks`, { data: { title: '待整理收集项', description: '待归类背景' } }));
    await page.goto('/#/inbox');
    await expect(page.getByRole('heading', { name: '收集箱' })).toBeVisible();
    const taskCard = page.getByRole('article').filter({ hasText: '待整理收集项' });
    await expect(taskCard).toBeVisible();
    await taskCard.getByRole('combobox', { name: '归入主题：待整理收集项' }).click();
    await page.getByRole('option', { name: 'E2E 收集主题' }).click();
    await expect(taskCard).toBeHidden();
    expect((await responseData<Array<{ id: string; topicId: string | null }>>(await request.get(`${apiUrl}/api/tasks?inbox=true`))).some((item) => item.id === task.id)).toBe(false);
    await page.goto('/#/board');
    await expect(page.getByRole('button', { name: '待整理收集项', exact: true })).toBeVisible();
    expect((await responseData<{ topicId: string }>(await request.get(`${apiUrl}/api/tasks/${task.id}`))).topicId).toBe(topic.id);
  });

  test('创建探索主题并完成任务状态、回收站和永久删除流程', async ({ page, isMobile, request }) => {
    test.skip(Boolean(isMobile), '核心管理流程在桌面视口验收，移动端使用独立响应式用例');
    await page.goto('/#/topics');
    await page.getByRole('button', { name: '新建主题' }).click();
    await page.getByLabel('主题名称').fill('E2E 探索主题');
    await expect(page.getByLabel('当前仍在探索')).toBeChecked();
    await page.getByRole('button', { name: '保存主题' }).click();
    await expect(page.getByRole('heading', { name: 'E2E 探索主题' })).toBeVisible();

    await page.getByRole('button', { name: '新建任务' }).click();
    await page.getByLabel('任务名称').fill('E2E 任务');
    await page.getByRole('button', { name: '保存任务' }).click();
    const taskCard = () => page.getByRole('button', { name: 'E2E 任务', exact: true }).locator('xpath=ancestor::article');
    await expect(taskCard()).toBeVisible();
    await taskCard().getByRole('combobox', { name: '修改状态：E2E 任务' }).click();
    await page.getByRole('option', { name: '进行中' }).click();
    await expect(taskCard().getByRole('combobox', { name: '修改状态：E2E 任务' })).toContainText('进行中');
    await taskCard().getByRole('combobox', { name: '修改状态：E2E 任务' }).click();
    await page.getByRole('option', { name: '已完成' }).click();
    await expect(taskCard().getByRole('combobox', { name: '修改状态：E2E 任务' })).toContainText('已完成');

    await taskCard().getByRole('button', { name: '删除任务：E2E 任务' }).click();
    await page.getByRole('button', { name: '确认' }).click();
    await page.goto('/#/trash');
    await expect(page.getByRole('heading', { name: 'E2E 任务' })).toBeVisible();
    await page.getByRole('button', { name: '恢复' }).click();
    await page.goto('/#/board');
    await expect(taskCard()).toBeVisible();

    await taskCard().getByRole('button', { name: '删除任务：E2E 任务' }).click();
    await page.getByRole('button', { name: '确认' }).click();
    await page.goto('/#/trash');
    await page.getByRole('button', { name: '永久删除' }).click();
    await page.getByRole('button', { name: '确认' }).click();
    await expect(page.getByText('回收站为空')).toBeVisible();
    expect(await responseData<unknown[]>(await request.get(`${apiUrl}/api/trash/tasks`))).toHaveLength(0);
  });

  test('配置模型，验证只读 Tool、写操作批准和拒绝', async ({ page, isMobile, request }) => {
    test.skip(Boolean(isMobile), 'Agent 完整工作流在桌面视口验收');
    const topic = await createTopic(request, 'E2E Agent 主题');
    await page.goto('/#/settings');
    await page.getByLabel('接口地址').fill('http://127.0.0.1:4010/v1');
    await page.getByLabel('模型名称').fill('mock-model');
    await page.getByLabel('API Key').fill('e2e-key');
    await page.getByRole('button', { name: '测试连接并保存' }).click();
    await expect(page.getByText('设置已保存，连接测试通过。')).toBeVisible();

    await page.goto('/#/chat');
    await send(page, '列出任务');
    await expect(page.getByText('我先读取任务。', { exact: true })).toBeVisible();
    await expect(page.getByText('Tool', { exact: true }).last().locator('..')).toContainText('[]');
    await expect(page.getByText('当前任务已读取完成。', { exact: true })).toBeVisible();

    expect(await taskCount(request, topic.id)).toBe(0);
    await send(page, '创建任务');
    await expect(page.getByText('需要审核')).toBeVisible();
    expect(await taskCount(request, topic.id)).toBe(0);
    await page.getByRole('button', { name: '批准执行' }).click();
    await expect.poll(() => taskCount(request, topic.id)).toBe(1);
    await expect(page.getByText(/变更已完成|Mock 模型回复/)).toBeVisible();

    await send(page, '创建任务并拒绝');
    await expect(page.getByText('需要审核')).toBeVisible();
    await page.getByRole('button', { name: '拒绝' }).click();
    await expect(page.getByText('变更已拒绝，数据未修改。')).toBeVisible();
    await expect.poll(() => taskCount(request, topic.id)).toBe(1);
  });

  test('成果草稿可放弃或确认，变更历史可撤销', async ({ page, isMobile, request }) => {
    test.skip(Boolean(isMobile), '成果与撤销工作流在桌面视口验收');
    const topic = await createTopic(request, 'E2E 成果主题');
    await configureMock(request);
    await page.goto('/#/board');

    await send(page, '生成成果草稿 第一版');
    await page.getByRole('button', { name: '批准执行' }).click();
    await expect(page.getByText('E2E 待放弃草稿')).toBeVisible();
    await page.getByRole('button', { name: '放弃草稿' }).click();
    await expect(page.getByText('E2E 待放弃草稿')).toHaveCount(0);

    await send(page, '生成成果草稿 第二版');
    await page.getByRole('button', { name: '批准执行' }).click();
    await expect(page.getByText('E2E 最终成果')).toBeVisible();
    await page.getByRole('button', { name: '确认成果' }).click();
    await expect(page.getByText('正式成果')).toBeVisible();
    await expect(page.getByText('E2E 最终成果')).toBeVisible();

    const task = await responseData<{ id: string }>(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: topic.id, title: '可撤销任务' } }));
    await request.patch(`${apiUrl}/api/tasks/${task.id}`, { data: { status: 'doing' } });
    await page.goto('/#/changes');
    const updateRecord = page.getByText('更新', { exact: true }).first().locator('xpath=ancestor::article');
    await expect(updateRecord).toContainText('可撤销任务');
    await updateRecord.getByRole('button', { name: '撤销' }).click();
    await expect(page.getByText('变更已撤销')).toBeVisible();
    await expect.poll(async () => {
      const response = await request.get(`${apiUrl}/api/tasks/${task.id}`);
      return (await response.json()).data.status;
    }).toBe('todo');
  });

  test('受控执行生成脱敏且不可撤销的审计记录', async ({ page, isMobile, request }) => {
    test.skip(Boolean(isMobile), '执行审计在桌面视口验收');
    await createTopic(request, 'E2E 执行审计主题');
    await configureMock(request);
    await page.goto('/#/chat');
    await send(page, '读取受控文件');
    await expect(page.getByText('需要审核')).toBeVisible();
    await page.getByRole('button', { name: '批准执行' }).click();

    await page.goto('/#/changes');
    await page.getByRole('combobox', { name: '筛选对象类型' }).click();
    await page.getByRole('option', { name: '受控执行' }).click();
    await expect(page.getByText('execute_file · 成功')).toBeVisible();
    await expect(page.getByText('不可撤销')).toBeVisible();
    await expect(page.getByText(/受控执行 ·/)).toBeVisible();
    const records = await responseData<Array<{ source: string; conversationId: string; approvalId: string; requestId: string; afterSnapshot: string }>>(await request.get(`${apiUrl}/api/changes?entityType=execution`));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: 'agent', requestId: records[0].approvalId });
    expect(records[0].conversationId).toBeTruthy();
    expect(records[0].afterSnapshot).not.toContain('e2e-key');
  });

  test('Mock 服务明确报告上游错误和无效响应', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), '模型错误协议在桌面视口验收');
    await page.goto('/#/settings');
    await page.getByLabel('接口地址').fill('http://127.0.0.1:4010/v1');
    await page.getByLabel('API Key').fill('e2e-key');
    await page.getByLabel('模型名称').fill('mock-upstream');
    await page.getByRole('button', { name: '测试连接并保存' }).click();
    await expect(page.getByText('模型服务错误：502')).toBeVisible();

    await page.getByLabel('模型名称').fill('mock-invalid');
    await page.getByRole('button', { name: '测试连接并保存' }).click();
    await expect(page.getByText('模型服务返回了无效的连接测试结果')).toBeVisible();
  });

  test('桌面端聊天栏可关闭并从看板重新打开', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), '聊天栏桌面布局在桌面视口验收');
    await page.goto('/#/board');

    const chatHeading = page.getByRole('heading', { name: '全局聊天' });
    const boardSection = page.locator('section').first();
    await expect(chatHeading).toBeVisible();
    await expect(page.getByRole('button', { name: '关闭聊天' })).toBeVisible();
    const composer = page.getByPlaceholder(composerPlaceholder);
    await composer.fill('关闭后仍然保留');
    const boardWidthBeforeClose = (await boardSection.boundingBox())?.width;
    expect(boardWidthBeforeClose).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

    await page.getByRole('button', { name: '关闭聊天' }).click();
    await expect(chatHeading).toBeHidden();
    await expect(page.getByRole('button', { name: '打开聊天' })).toBeVisible();
    const boardWidthAfterClose = (await boardSection.boundingBox())?.width;
    expect(boardWidthAfterClose).toBeGreaterThan(boardWidthBeforeClose!);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

    await page.getByRole('button', { name: '打开聊天' }).click();
    await expect(chatHeading).toBeVisible();
    await expect(page.getByRole('button', { name: '关闭聊天' })).toBeVisible();
    await expect(composer).toHaveValue('关闭后仍然保留');
  });

  test('移动端关闭聊天返回看板并可从底部导航重新进入', async ({ page, isMobile }) => {
    test.skip(!isMobile, '聊天栏移动布局在移动视口验收');
    await page.goto('/#/chat');

    const chatHeading = page.getByRole('heading', { name: '全局聊天' });
    await expect(chatHeading).toBeVisible();
    await expect(page.getByRole('button', { name: '关闭聊天' })).toBeVisible();

    await page.getByRole('button', { name: '关闭聊天' }).click();
    await expect(page).toHaveURL(/#\/(?:board)?$/);
    await expect(chatHeading).toBeHidden();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await expect(page.getByRole('button', { name: '看板' })).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

    await page.getByRole('button', { name: '聊天' }).click();
    await expect(page).toHaveURL(/#\/chat$/);
    await expect(chatHeading).toBeVisible();
    await expect(page.getByRole('button', { name: '关闭聊天' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });

  test('移动端底部导航、横向看板和审核按钮均保持在视口内', async ({ page, isMobile, request }) => {
    test.skip(!isMobile, '仅在移动视口验收');
    const topic = await createTopic(request, 'E2E 移动主题');
    await request.post(`${apiUrl}/api/tasks`, { data: { topicId: topic.id, title: '移动端任务' } });
    await configureMock(request);
    await page.goto('/#/board');
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    const board = page.locator('.snap-x');
    await expect(board).toBeVisible();
    expect(await board.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

    await page.getByRole('button', { name: '聊天' }).click();
    await send(page, '创建任务');
    const reject = page.getByRole('button', { name: '拒绝' });
    const approve = page.getByRole('button', { name: '批准执行' });
    await expect(reject).toBeVisible();
    await expect(approve).toBeVisible();
    const viewportWidth = page.viewportSize()!.width;
    for (const button of [reject, approve]) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await reject.click();
  });
});
