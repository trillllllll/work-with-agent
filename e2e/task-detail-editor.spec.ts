import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('详情里显示子任务进度、勾选并回车新增', async ({ page, request }) => {
  const parent = (await (await request.post(`${apiUrl}/api/tasks`, { data: { title: '父任务' } })).json()).data;
  const mk = (title: string) => request.post(`${apiUrl}/api/tasks`, { data: { title, topicId: null, parentId: parent.id } });
  await mk('子一'); await mk('子二');
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${parent.id}`).getByRole('button', { name: '父任务', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(detail.getByLabel('子任务', { exact: true })).toBeVisible();
  await expect(detail.getByText('0/2', { exact: true })).toBeVisible();
  await detail.getByRole('checkbox', { name: '完成任务：子一', exact: true }).click();
  await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
  await expect(detail.getByRole('checkbox', { name: '重开任务：子一', exact: true })).toBeChecked();
  await expect(detail.getByText('1/2', { exact: true })).toBeVisible();
  await detail.getByLabel('子任务名称', { exact: true }).fill('子三');
  await detail.getByLabel('子任务名称', { exact: true }).press('Enter');
  await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
  await expect(detail.getByRole('button', { name: '子三', exact: true })).toBeVisible();
  await expect(detail.getByLabel('子任务名称', { exact: true })).toHaveValue('');
});

test('标题旁的勾选框完成任务并划线，取消子任务确认会回滚', async ({ page, request }) => {
  const parent = (await (await request.post(`${apiUrl}/api/tasks`, { data: { title: '父任务' } })).json()).data;
  await request.post(`${apiUrl}/api/tasks`, { data: { title: '子一', topicId: null, parentId: parent.id } });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${parent.id}`).getByRole('button', { name: '父任务', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await detail.getByRole('checkbox', { name: '完成任务：父任务', exact: true }).click();
  const confirmDialog = page.getByRole('dialog', { name: '一并完成子任务？', exact: true });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(detail.getByRole('checkbox', { name: '完成任务：父任务', exact: true })).not.toBeChecked();
  await detail.getByRole('checkbox', { name: '完成任务：父任务', exact: true }).click();
  await confirmDialog.getByRole('button', { name: '一并完成', exact: true }).click();
  await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
  await expect(detail.getByRole('checkbox', { name: '重开任务：父任务', exact: true })).toBeChecked();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveCSS('text-decoration-line', 'line-through');
});

test('信息行显示当前值', async ({ page, request }) => {
  const created = await request.post(`${apiUrl}/api/tasks`, { data: { title: '有日期', dueDate: '2031-01-02' } });
  expect(created.ok(), await created.text()).toBe(true);
  const task = (await created.json()).data as { id: string };
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '有日期', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(detail.getByRole('button', { name: '安排时间', exact: true })).toContainText('2031-01-02');
  await expect(detail.getByRole('button', { name: '预计时长', exact: true })).toContainText('设置');
});

test('详情显示所属清单，无清单时显示收集箱', async ({ page, request }) => {
  const topic = (await (await request.post(`${apiUrl}/api/topics`, { data: { name: '发布准备' } })).json()).data as { id: string };
  const inTopic = (await (await request.post(`${apiUrl}/api/tasks`, { data: { title: '清单内任务', topicId: topic.id } })).json()).data as { id: string };
  const loose = (await (await request.post(`${apiUrl}/api/tasks`, { data: { title: '无清单任务' } })).json()).data as { id: string };
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/board');
  await page.reload();
  await page.getByTestId(`task-row-${inTopic.id}`).getByRole('button', { name: '清单内任务', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(detail.getByTestId('task-topic-row')).toContainText('所属清单');
  await expect(detail.getByTestId('task-topic-row').locator('.task-place-chip')).toHaveText('发布准备');
  await page.getByRole('button', { name: '关闭工作侧栏', exact: true }).click();
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${loose.id}`).getByRole('button', { name: '无清单任务', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '任务详情', exact: true }).getByTestId('task-topic-row').locator('.task-place-chip')).toHaveText('收集箱');
});

test('详情里修改所属清单，子任务一同移动', async ({ page, request }) => {
  const listA = (await (await request.post(`${apiUrl}/api/topics`, { data: { name: '清单甲' } })).json()).data as { id: string };
  const listB = (await (await request.post(`${apiUrl}/api/topics`, { data: { name: '清单乙' } })).json()).data as { id: string };
  const task = (await (await request.post(`${apiUrl}/api/tasks`, { data: { title: '搬家的任务' } })).json()).data as { id: string };
  const sub = (await (await request.post(`${apiUrl}/api/tasks`, { data: { title: '跟随的子任务', parentId: task.id } })).json()).data as { id: string };
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '搬家的任务', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await detail.getByTestId('task-topic-row').click();
  const picker = page.getByRole('dialog', { name: '移动到清单', exact: true });
  await expect(picker.getByRole('button', { name: '收集箱', exact: true })).toBeDisabled();
  await picker.getByRole('button', { name: '清单乙', exact: true }).click();
  await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
  await expect(detail.getByTestId('task-topic-row').locator('.task-place-chip')).toHaveText('清单乙');
  await expect.poll(async () => ((await (await request.get(`${apiUrl}/api/tasks/${task.id}`)).json()).data as { topicId: string | null }).topicId).toBe(listB.id);
  await expect.poll(async () => ((await (await request.get(`${apiUrl}/api/tasks/${sub.id}`)).json()).data as { topicId: string | null }).topicId).toBe(listB.id);
  await detail.getByTestId('task-topic-row').click();
  await picker.getByRole('button', { name: '清单甲', exact: true }).click();
  await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
  await expect(detail.getByTestId('task-topic-row').locator('.task-place-chip')).toHaveText('清单甲');
  await expect.poll(async () => ((await (await request.get(`${apiUrl}/api/tasks/${task.id}`)).json()).data as { topicId: string | null }).topicId).toBe(listA.id);
  await detail.getByTestId('task-topic-row').click();
  await picker.getByRole('button', { name: '收集箱', exact: true }).click();
  await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
  await expect(detail.getByTestId('task-topic-row').locator('.task-place-chip')).toHaveText('收集箱');
  await expect.poll(async () => ((await (await request.get(`${apiUrl}/api/tasks/${task.id}`)).json()).data as { topicId: string | null }).topicId).toBeNull();
});

test('窄屏多清单选择器保持在视口内，末尾清单可滚动选择', async ({ page, request }) => {
  let lastTopicId = '';
  for (let index = 1; index <= 30; index += 1) {
    const response = await request.post(`${apiUrl}/api/topics`, { data: { name: `目录清单${index}` } });
    expect(response.ok(), await response.text()).toBe(true);
    lastTopicId = ((await response.json()).data as { id: string }).id;
  }
  const task = (await (await request.post(`${apiUrl}/api/tasks`, { data: { title: '选择末尾清单' } })).json()).data as { id: string };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '选择末尾清单', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await detail.getByTestId('task-topic-row').click();
  const picker = page.getByRole('dialog', { name: '移动到清单', exact: true });
  await expect(picker).toBeVisible();
  await expect.poll(async () => picker.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  })).toBe(true);
  const last = picker.getByRole('button', { name: '目录清单30', exact: true });
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(detail.getByTestId('task-topic-row').locator('.task-place-chip')).toHaveText('目录清单30');
  await expect.poll(async () => ((await (await request.get(`${apiUrl}/api/tasks/${task.id}`)).json()).data as { topicId: string | null }).topicId).toBe(lastTopicId);
});

test('选中文本浮出格式条，加粗后立即保持格式', async ({ page, request }) => {
  const created = await request.post(`${apiUrl}/api/tasks`, { data: { title: '写一句' } });
  expect(created.ok(), await created.text()).toBe(true);
  const task = (await created.json()).data as { id: string };
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '写一句', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  const body = detail.getByLabel('详情', { exact: true });
  await body.fill('hello world');
  await body.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  const bar = page.getByRole('toolbar', { name: '格式', exact: true });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: '加粗', exact: true }).click();
  // 加粗后无需失焦，排版结果立即可见。
  await expect(body.locator('strong')).toContainText('hello world');
  await expect(body).toHaveAttribute('data-value', '**hello world**');
  // 格式条可能盖住标题，点详情里的空白收起选区，不点标题。
  await detail.locator('section[aria-label="子任务"]').click({ position: { x: 8, y: 8 } });
  await expect(detail.locator('strong')).toContainText('hello world');
});

test('连续输入逐字回显，停顿后才提交一次', async ({ page, request }) => {
  const created = await request.post(`${apiUrl}/api/tasks`, { data: { title: 'T' } });
  expect(created.ok(), await created.text()).toBe(true);
  const task = (await created.json()).data as { id: string };
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: 'T', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  const patches: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'PATCH' && req.url().includes(`/api/tasks/${task.id}`)) patches.push(req.postData() ?? '');
  });
  const title = detail.getByLabel('任务标题', { exact: true });
  await title.click();
  await title.press('End');
  await title.pressSequentially('ABCD', { delay: 150 });
  // 防抖期内零请求，且每个字符必须立即回显（不等待保存状态变化）。
  expect(patches).toHaveLength(0);
  await expect(title).toHaveValue('TABCD', { timeout: 1000 });
  const body = detail.getByLabel('详情', { exact: true });
  await body.click();
  await body.pressSequentially('EFGH', { delay: 150 });
  expect(patches).toHaveLength(0);
  await expect(body).toContainText('EFGH', { timeout: 1000 });
  await expect.poll(() => patches.length, { timeout: 8000 }).toBe(1);
  const payload = JSON.parse(patches[0]) as { title?: string; description?: string };
  expect(payload.title).toBe('TABCD');
  expect(payload.description).toContain('EFGH');
});
