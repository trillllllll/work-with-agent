import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
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
  if (!(await page.getByPlaceholder(composerPlaceholder).isVisible())) await page.getByRole('button', { name: '打开聊天', exact: true }).click();
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
  test('配置模型，验证只读 Tool、写操作批准和拒绝', async ({ page, isMobile, request }) => {
    test.skip(Boolean(isMobile), 'Agent 完整工作流在桌面视口验收');
    const topic = await createTopic(request, 'E2E Agent 主题');
    await page.goto('/#/settings');
    await page.getByLabel('接口地址').fill('http://127.0.0.1:4010/v1');
    await page.getByLabel('模型名称').fill('mock-model');
    await page.getByLabel('API Key', { exact: true }).fill('e2e-key');
    await page.getByRole('button', { name: '测试连接并保存' }).click();
    await expect(page.getByText('设置已保存，连接测试通过。')).toBeVisible();

    await page.goto('/#/board');
    await expect(page.getByRole('heading', { name: 'E2E Agent 主题', exact: true })).toBeVisible();
    await page.goto('/#/chat');
    await send(page, '列出任务');
    await expect(page.getByText('我先读取任务。', { exact: true })).toBeVisible();
    await expect(page.getByTestId('assistant-process').locator(':scope > summary')).toBeVisible();
    await expect(page.getByText('当前任务已读取完成。', { exact: true })).toBeVisible();

    expect(await taskCount(request, topic.id)).toBe(0);
    await send(page, `创建任务 topicId=${topic.id}`);
    const pending = page.locator('[data-testid="approval-card"][data-state="pending"]');
    await expect(pending).toBeVisible();
    await expect(pending.getByRole('status')).toContainText('等待确认');
    expect(await taskCount(request, topic.id)).toBe(0);
    await pending.getByRole('button', { name: '确认修改', exact: true }).click();
    await expect.poll(() => taskCount(request, topic.id)).toBe(1);
    await expect(page.getByText('变更已完成。', { exact: true })).toBeVisible();

    await send(page, `创建任务并拒绝 topicId=${topic.id}`);
    const rejectCard = page.getByTestId('approval-card').last();
    await expect(rejectCard).toHaveAttribute('data-state', 'pending');
    await rejectCard.getByRole('button', { name: '取消', exact: true }).click();
    await expect(rejectCard.getByRole('status')).toContainText('已取消，未修改数据');
    await expect.poll(() => taskCount(request, topic.id)).toBe(1);
  });

  test('成果草稿可放弃或确认，变更历史可撤销', async ({ page, isMobile, request }) => {
    test.skip(Boolean(isMobile), '成果与撤销工作流在桌面视口验收');
    const topic = await createTopic(request, 'E2E 成果主题');
    await configureMock(request);
    await page.goto('/#/board');

    const firstChat = page.waitForResponse((response) => response.url().endsWith('/api/chat') && response.request().method() === 'POST');
    await send(page, `生成成果草稿 第一版 topicId=${topic.id}`);
    const firstStream = await (await firstChat).text();
    expect(firstStream).toContain('"toolName":"query_topics"');
    const firstProposal = await responseData<Array<{ arguments: string }>>(await request.get(`${apiUrl}/api/agent/approvals?status=pending`));
    const originalTopic = await responseData<{ revision: number }>(await request.get(`${apiUrl}/api/topics/${topic.id}`));
    const firstCommand = JSON.parse(firstProposal[0].arguments).operations[0].command;
    expect(firstCommand.kind).toBe('topic.update');
    expect(firstCommand.expectedRevision).toBe(originalTopic.revision);
    expect(firstCommand.input.draftSummary).toBe('E2E 待放弃草稿');
    await page.getByRole('button', { name: '确认修改', exact: true }).click();
    await expect.poll(async () => (await responseData<{ draftSummary: string | null }>(await request.get(`${apiUrl}/api/topics/${topic.id}`))).draftSummary).toBe('E2E 待放弃草稿');
    await expect(page.getByText('E2E 待放弃草稿')).toBeVisible();
    await page.getByRole('button', { name: '放弃草稿' }).click();
    await expect(page.getByText('E2E 待放弃草稿')).toHaveCount(0);

    const secondChat = page.waitForResponse((response) => response.url().endsWith('/api/chat') && response.request().method() === 'POST');
    await send(page, `生成成果草稿 第二版 topicId=${topic.id}`);
    const secondStream = await (await secondChat).text();
    expect(secondStream).toContain('"toolName":"query_topics"');
    const secondProposal = await responseData<Array<{ arguments: string }>>(await request.get(`${apiUrl}/api/agent/approvals?status=pending`));
    const updatedTopic = await responseData<{ revision: number }>(await request.get(`${apiUrl}/api/topics/${topic.id}`));
    expect(updatedTopic.revision).toBeGreaterThan(originalTopic.revision);
    const secondCommand = JSON.parse(secondProposal[0].arguments).operations[0].command;
    expect(secondCommand.kind).toBe('topic.update');
    expect(secondCommand.expectedRevision).toBe(updatedTopic.revision);
    expect(secondCommand.input.draftSummary).toBe('E2E 最终成果');
    await page.getByRole('button', { name: '确认修改', exact: true }).click();
    await expect.poll(async () => (await responseData<{ draftSummary: string | null }>(await request.get(`${apiUrl}/api/topics/${topic.id}`))).draftSummary).toBe('E2E 最终成果');
    await expect(page.getByText('E2E 最终成果')).toBeVisible();
    await page.getByRole('button', { name: '确认成果' }).click();
    await expect(page.getByText('正式成果')).toBeVisible();
    await expect(page.getByText('E2E 最终成果')).toBeVisible();

    const task = await responseData<{ id: string }>(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: topic.id, title: '可撤销任务' } }));
    await request.patch(`${apiUrl}/api/tasks/${task.id}`, { data: { status: 'doing' } });
    await page.goto('/#/changes');
    const updateRecord = page.getByTestId('change-row').filter({ hasText: '可撤销任务' }).filter({ has: page.getByText('更新', { exact: true }) });
    await expect(updateRecord).toBeVisible();
    await updateRecord.getByRole('button', { name: '撤销' }).click();
    await expect(page.getByText('变更已撤销')).toBeVisible();
    await expect.poll(async () => {
      const response = await request.get(`${apiUrl}/api/tasks/${task.id}`);
      return (await response.json()).data.status;
    }).toBe('todo');
    await expect(updateRecord.getByText('已撤销', { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(updateRecord.getByRole('button', { name: '撤销' })).toBeDisabled();
  });

  test('Mock 服务明确报告上游错误和无效响应', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), '模型错误协议在桌面视口验收');
    await page.goto('/#/settings');
    await page.getByLabel('接口地址').fill('http://127.0.0.1:4010/v1');
    await page.getByLabel('API Key', { exact: true }).fill('e2e-key');
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

    const chatHeading = page.getByRole('heading', { level: 2, name: 'Dovun 工作助手' });
    const boardSection = page.getByRole('main');
    await expect(chatHeading).toBeHidden();
    await page.getByRole('button', { name: '打开聊天', exact: true }).click();
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

  test('Dovun 品牌在侧栏，切换 AI 后任务详情草稿还在', async ({ page, isMobile, request }) => {
    test.skip(Boolean(isMobile), '桌面侧栏在桌面视口验收');
    const task = await responseData<{ id: string }>(await request.post(`${apiUrl}/api/tasks`, { data: { title: '检查器任务' } }));
    await page.goto('/#/inbox');

    await expect(page.getByLabel('Dovun', { exact: true })).toBeVisible();
    await expect(page.getByText('dovun', { exact: true })).toHaveCount(1);
    const row = page.getByTestId(`task-row-${task.id}`);
    await row.getByRole('button', { name: '检查器任务', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
    await detail.getByLabel('详情', { exact: true }).fill('检查器草稿');

    await page.getByRole('button', { name: '打开聊天', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '保存未完成的编辑？' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Dovun 工作助手' })).toBeVisible();
    await expect(detail).toBeHidden();
    await page.getByRole('tablist', { name: '工作侧栏' }).getByRole('tab', { name: '任务', exact: true }).click();
    await expect(detail).toBeVisible();
    await expect(detail.getByLabel('详情', { exact: true })).toHaveAttribute('data-value', '检查器草稿');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });

  test('移动端关闭聊天返回收集箱并可重新进入', async ({ page, isMobile }) => {
    test.skip(!isMobile, '聊天栏移动布局在移动视口验收');
    await page.goto('/#/chat');

    const chatHeading = page.getByRole('heading', { level: 2, name: 'Dovun 工作助手' });
    await expect(chatHeading).toBeVisible();
    await expect(page.getByRole('button', { name: '返回当前页面' })).toHaveCount(0);

    await page.getByTestId('mobile-bottom-navigation').getByRole('button', { name: '收集箱', exact: true }).click();
    await expect(page).toHaveURL(/#\/inbox$/);
    await expect(chatHeading).toBeHidden();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await expect(page.getByTestId('mobile-bottom-navigation').getByRole('button', { name: '收集箱', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

    await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
    await expect(chatHeading).toBeVisible();
    // 打开 AI 助手只拉开侧栏，不会 navigate 到 #/chat，因此地址仍是收集箱，并出现「返回当前页面」。
    await expect(page).toHaveURL(/#\/inbox$/);
    await expect(page.getByRole('button', { name: '返回当前页面' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });

  test('移动端底部导航、可选看板和审核按钮均保持在视口内', async ({ page, isMobile, request }) => {
    test.skip(!isMobile, '仅在移动视口验收');
    const topic = await createTopic(request, 'E2E 移动主题');
    await request.post(`${apiUrl}/api/tasks`, { data: { topicId: topic.id, title: '移动端任务' } });
    await configureMock(request);
    await page.goto('/#/board');
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await page.getByRole('button', { name: '看板', exact: true }).click();
    await expect(page.getByRole('heading', { name: '待办', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '移动端任务', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);

    await page.getByRole('button', { name: '打开聊天', exact: true }).click();
    await expect(page.getByPlaceholder(composerPlaceholder)).toBeVisible();
    await send(page, '创建任务');
    const card = page.getByTestId('approval-card');
    const reject = card.getByRole('button', { name: '取消', exact: true });
    const approve = card.getByRole('button', { name: '确认修改', exact: true });
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
