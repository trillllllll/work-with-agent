import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = 'http://127.0.0.1:3015';

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
  await expect(detail.getByRole('button', { name: '日期', exact: true })).toContainText('2031-01-02');
  await expect(detail.getByRole('button', { name: '时段', exact: true })).toContainText('设置');
});

test('选中文本浮出格式条，加粗后 blur 渲染', async ({ page, request }) => {
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
  const bar = detail.getByRole('toolbar', { name: '格式', exact: true });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(body).toHaveAttribute('data-value', '**hello world**');
  await detail.getByLabel('任务标题', { exact: true }).click();
  await expect(detail.locator('strong')).toContainText('hello world');
});
