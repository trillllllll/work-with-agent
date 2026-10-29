import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';

async function command(request: APIRequestContext, commands: unknown[]) {
  const response = await request.post(`${base}/api/v1/commands`, { data: { requestId: crypto.randomUUID(), commands } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data.results[0];
}

async function createMaterial(request: APIRequestContext, title: string) {
  return command(request, [{ kind: 'material.create', input: { topicId: null, kind: 'text', title, content: `${title}的正文` } }]) as Promise<{ id: string; revision: number }>;
}

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
  });
});
test.afterAll(() => e2eDatabase.$disconnect());

async function openTask(page: Page, taskId: string) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${taskId}`).click();
  await expect(page.getByTestId('task-materials')).toBeVisible();
}

test('任务详情直接显示资料区，引用可多选且与关联同时出现', async ({ page, request }) => {
  const created = await request.post(`${base}/api/tasks`, { data: { title: '需要资料的任务' } });
  expect(created.ok(), await created.text()).toBe(true);
  const taskId = (await created.json()).data.id as string;
  const first = await createMaterial(request, '可引用甲');
  const second = await createMaterial(request, '可引用乙');
  await openTask(page, taskId);
  await expect(page.getByRole('menuitem', { name: '关联资料', exact: true })).toHaveCount(0);
  await expect(page.getByText('拖入文件，或引用已有资料', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '引用已有资料', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '引用已有资料', exact: true });
  const firstBox = picker.getByRole('checkbox', { name: '可引用甲', exact: true });
  const secondBox = picker.getByRole('checkbox', { name: '可引用乙', exact: true });
  await firstBox.check();
  await secondBox.check();
  await expect(firstBox).toBeChecked();
  await expect(secondBox).toBeChecked();
  await picker.getByRole('button', { name: '插入引用', exact: true }).click();

  await expect(page.getByTestId(`material-reference-${first.id}`)).toBeVisible();
  await expect(page.getByTestId(`material-reference-${second.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-material-${first.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-material-${second.id}`)).toBeVisible();
  await expect(page.getByTestId('task-materials')).toContainText('资料 · 2');

  await page.getByTestId(`task-material-${first.id}`).getByRole('button', { name: '解除关联', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '解除关联', exact: true });
  await expect(confirm).toContainText('正文仍引用');
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByTestId(`material-reference-${first.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-material-${first.id}`)).toBeVisible();

  const description = page.getByLabel('详情', { exact: true });
  const descriptionBox = await description.boundingBox();
  await description.click({ position: { x: Math.max(24, (descriptionBox?.width ?? 240) - 12), y: 18 } });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('引用已经从正文删除');
  await page.getByLabel('任务标题', { exact: true }).click();
  await expect(page.getByTestId(`material-reference-${first.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`material-reference-${second.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`task-material-${first.id}`)).toBeVisible();
  await expect(page.getByTestId(`task-material-${second.id}`)).toBeVisible();
});

async function createTask(request: APIRequestContext, title: string) {
  const created = await request.post(`${base}/api/tasks`, { data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  return (await created.json()).data.id as string;
}

async function uploadIntoTask(page: Page, taskId: string, bytes: Buffer) {
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${taskId}`).click();
  await expect(page.getByTestId('task-materials')).toBeVisible();
  await page.locator('input[aria-label="上传文件"]').setInputFiles({ name: 'same.txt', mimeType: 'text/plain', buffer: bytes });
}

test('同一份文件上传到两个任务时使用已有资料', async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  const taskA = await createTask(request, '上传任务甲');
  const taskB = await createTask(request, '上传任务乙');
  const bytes = Buffer.from('同一份原件字节');
  await uploadIntoTask(page, taskA, bytes);
  await expect(page.getByText('已添加 1 份资料，0 份失败', { exact: true })).toBeVisible({ timeout: 20_000 });
  await uploadIntoTask(page, taskB, bytes);
  await expect(page.getByTestId('library-upload-queue')).toContainText('发现相同原件', { timeout: 20_000 });
  await page.getByRole('button', { name: '使用已有', exact: true }).click();
  await expect.poll(async () => {
    const listed = await request.get(`${base}/api/v1/library/materials?limit=40`);
    const data = (await listed.json()).data;
    if (data?.total !== 1) return '';
    const id = data.items[0].id as string;
    const tasks = await request.get(`${base}/api/v1/library/materials/${id}/tasks?limit=40`);
    return ((await tasks.json()).data.items as Array<{ id: string }>).map((item) => item.id).sort().join(',');
  }, { timeout: 30_000 }).toBe([taskA, taskB].sort().join(','));
});

test('关闭引用框后焦点回到引用已有资料', async ({ page, request }) => {
  const taskId = await createTask(request, '关闭引用框');
  await openTask(page, taskId);
  const trigger = page.getByRole('button', { name: '引用已有资料', exact: true });
  await trigger.click();
  await expect(page.getByRole('dialog', { name: '引用已有资料', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

async function readMaterial(request: APIRequestContext, id: string) {
  const response = await request.get(`${base}/api/v1/library/materials/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as { id: string; revision: number; organizationRevision: number };
}

test('任务资料进入文档工作区再打开另一个任务，未保存正文仍在', async ({ page, request }) => {
  test.setTimeout(60_000);
  const taskA = await createTask(request, '草稿任务甲');
  const taskB = await createTask(request, '目标任务乙');
  const material = await createMaterial(request, '两边都能打开');
  const current = await readMaterial(request, material.id);
  await command(request, [{ kind: 'material.links', targetId: material.id, expectedRevision: current.revision, input: { expectedOrganizationRevision: current.organizationRevision, addTaskIds: [taskA, taskB], removeTaskIds: [], removeInlineReferences: false, expectedTaskRevisions: {} } }]);
  await openTask(page, taskA);
  const description = page.getByLabel('详情', { exact: true });
  await description.click();
  await page.keyboard.insertText('还没保存的草稿甲');
  await expect(description).toContainText('还没保存的草稿甲');
  await page.getByTestId(`task-material-${material.id}`).getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.getByTestId('document-pane')).toBeVisible();
  await page.getByRole('button', { name: '文件信息', exact: true }).click();
  await page.getByTestId('document-pane').getByRole('button', { name: '目标任务乙', exact: true }).click();
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue('目标任务乙');
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${taskA}`).click();
  await expect(page.getByLabel('详情', { exact: true })).toContainText('还没保存的草稿甲');
});

test('编辑中解除关联不会丢掉未保存正文', async ({ page, request }) => {
  test.setTimeout(60_000);
  const taskId = await createTask(request, '解除时还在编辑');
  const material = await createMaterial(request, '仍被引用');
  await openTask(page, taskId);
  await page.getByRole('button', { name: '引用已有资料', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '引用已有资料', exact: true });
  await picker.getByRole('checkbox', { name: '仍被引用', exact: true }).check();
  await picker.getByRole('button', { name: '插入引用', exact: true }).click();
  await expect(page.getByTestId(`material-reference-${material.id}`)).toBeVisible();
  const description = page.getByLabel('详情', { exact: true });
  await description.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('未保存补充甲');
  await expect(description).toContainText('未保存补充甲');
  await expect.poll(async () => description.getAttribute('data-value')).toContain(`wwa-material:${material.id}`);
  await expect.poll(async () => description.getAttribute('data-value')).toContain('未保存补充甲');
  await page.getByTestId(`task-material-${material.id}`).getByRole('button', { name: '解除关联', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '解除关联', exact: true });
  await confirm.getByRole('button', { name: '解除关联', exact: true }).click();
  await expect(page.getByTestId(`material-reference-${material.id}`)).toHaveCount(0);
  await expect(description).toContainText('未保存补充甲');
  await expect.poll(async () => {
    const task = await request.get(`${base}/api/tasks/${taskId}`);
    return (await task.json()).data?.description as string;
  }).toContain('未保存补充甲');
  const saved = await request.get(`${base}/api/tasks/${taskId}`);
  expect((await saved.json()).data.description as string).not.toContain('wwa-material:');
});
