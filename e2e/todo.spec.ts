import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = 'http://127.0.0.1:3015';
async function data(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}
async function tasks(request: APIRequestContext) {
  return data(await request.get(`${apiUrl}/api/tasks?status=all`));
}
async function task(request: APIRequestContext, id: string) {
  return data(await request.get(`${apiUrl}/api/tasks/${id}`));
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test.beforeEach(resetE2eDatabase);
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test.describe('无需模型的基础 Todo（桌面与移动）', () => {
  test('默认收集箱可连续创建、直接完成和重开，刷新后保持数据', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '收集箱', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '全局聊天' })).toBeHidden();
    expect((await data(await request.get(`${apiUrl}/api/settings`))).apiKeyConfigured).toBe(false);
    const capture = page.getByRole('textbox', { name: '收集任务名称', exact: true });
    await capture.fill('只填写标题');
    await capture.press('Enter');
    await expect(capture).toHaveValue('');
    await capture.fill('第二条任务');
    await page.getByRole('button', { name: '收集任务', exact: true }).click();
    await expect.poll(async () => (await tasks(request)).length).toBe(2);
    const created = (await tasks(request)).find((value: any) => value.title === '只填写标题');
    const row = page.getByTestId(`task-row-${created.id}`);
    await row.getByRole('checkbox', { name: '完成任务：只填写标题', exact: true }).click();
    await page.getByText('已完成 · 1', { exact: true }).click();
    await expect(row.getByRole('checkbox', { name: '重开任务：只填写标题', exact: true })).toBeChecked();
    await expect.poll(async () => (await task(request, created.id)).status).toBe('done');
    await row.getByRole('checkbox', { name: '重开任务：只填写标题', exact: true }).click();
    await expect(row.getByRole('checkbox', { name: '完成任务：只填写标题', exact: true })).not.toBeChecked();
    await expect.poll(async () => (await task(request, created.id)).status).toBe('todo');
    await page.reload();
    await expect(page.getByTestId(`task-row-${created.id}`)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    expect(await e2eDatabase.appSetting.count()).toBe(0);
  });

  test('清单只需名称，展开后保存详情、日期、旗标和归属', async ({ page, request }) => {
    await page.goto('/#/topics');
    await page.getByRole('button', { name: '新建清单', exact: true }).first().click();
    const create = page.getByRole('dialog', { name: '新建清单', exact: true });
    await create.getByLabel('清单名称', { exact: true }).fill('日常计划');
    await create.getByRole('button', { name: '保存清单', exact: true }).click();
    await expect(create).toBeHidden();
    const list = (await data(await request.get(`${apiUrl}/api/topics`)))[0];
    const created = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '待整理任务' } }));
    await page.goto('/#/inbox');
    const row = page.getByTestId(`task-row-${created.id}`);
    await row.getByRole('button', { name: '待整理任务', exact: true }).click();
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('任务标题', { exact: true }).fill('修改后的任务');
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('详情', { exact: true }).fill('保留我的说明');
    await expect.poll(async () => (await task(request, created.id)).title).toBe('修改后的任务');
    expect((await task(request, created.id)).description).toBe('');
    let failDescription = true;
    await page.route(`**/api/tasks/${created.id}`, async (route) => {
      const body = route.request().postDataJSON();
      if (route.request().method() === 'PATCH' && failDescription && body?.description === '保留我的说明') {
        failDescription = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ data: null, error: '详情保存失败' }) });
      } else await route.continue();
    });
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('任务标题', { exact: true }).click();
    await expect(page.getByText('详情保存失败', { exact: true }).first()).toBeVisible();
    expect((await task(request, created.id)).description).toBe('');
    await expect(page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('详情', { exact: true })).toHaveValue('保留我的说明');
    await expect(page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('任务标题', { exact: true })).toHaveValue('修改后的任务');
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    const leave = page.getByRole('dialog', { name: '保存未完成的编辑？', exact: true });
    await expect(leave).toBeVisible();
    await leave.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('详情', { exact: true })).toHaveValue('保留我的说明');
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('详情', { exact: true }).click();
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('任务标题', { exact: true }).click();
    await expect.poll(async () => (await task(request, created.id)).description).toBe('保留我的说明');
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('button', { name: '日期', exact: true }).click();
    await page.getByLabel('截止日期', { exact: true }).fill('2028-02-29');
    await expect.poll(async () => (await task(request, created.id)).dueDate).toBe('2028-02-29');
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('button', { name: '旗标：高', exact: true }).click();
    await expect.poll(async () => (await task(request, created.id)).priority).toBe('high');
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await row.getByRole('button', { name: '任务操作：修改后的任务', exact: true }).click();
    await page.getByRole('menuitem', { name: '移动到' }).click();
    await page.getByRole('menuitem', { name: '日常计划', exact: true }).click();
    await expect.poll(async () => (await task(request, created.id)).topicId).toBe(list.id);
    expect(await task(request, created.id)).toMatchObject({ priority: 'high', dueDate: '2028-02-29', description: '保留我的说明' });
    await page.goto('/#/board');
    await page.reload();
    await expect(page.getByTestId(`task-row-${created.id}`)).toContainText('修改后的任务');
  });

  test('中文选字 Enter 不提交，保存失败保留草稿，重试只创建一条', async ({ page, request }) => {
    await page.goto('/#/inbox');
    const capture = page.getByRole('textbox', { name: '收集任务名称', exact: true });
    await capture.fill('中文输入的任务');
    await capture.dispatchEvent('compositionstart');
    await capture.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
    expect(await tasks(request)).toHaveLength(0);
    await capture.dispatchEvent('compositionend');
    let failNextCreate = true;
    await page.route('**/api/tasks', async (route) => {
      if (route.request().method() === 'POST' && failNextCreate) {
        failNextCreate = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ data: null, error: '测试保存失败' }) });
      } else await route.continue();
    });
    await page.getByRole('button', { name: '收集任务', exact: true }).click();
    await expect(page.getByText('测试保存失败', { exact: true }).first()).toBeVisible();
    await expect(capture).toHaveValue('中文输入的任务');
    expect(await tasks(request)).toHaveLength(0);
    await capture.press('Enter');
    await expect(capture).toHaveValue('');
    await capture.press('Enter');
    await expect.poll(async () => (await tasks(request)).length).toBe(1);
    await page.reload();
    await expect(page.getByTestId('task-list')).toContainText('中文输入的任务');
  });

  test('今天单列逾期，搜索和详情修改同一任务并更新日期视图', async ({ page, request }) => {
    await page.goto('/#/inbox');
    const dates = await page.evaluate(() => {
      const today = new Date();
      const format = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      return { today: format(today), yesterday: format(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)) };
    });
    const current = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '今天处理', dueDate: dates.today } }));
    const overdue = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '尚未处理', dueDate: dates.yesterday } }));
    await page.goto('/#/today');
    await expect(page.getByRole('heading', { name: /^逾期/ })).toBeVisible();
    await expect(page.getByTestId(`task-row-${overdue.id}`)).toBeVisible();
    await expect(page.getByTestId(`task-row-${current.id}`)).toBeVisible();
    await page.goto('/#/search');
    await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('今天处理');
    const row = page.getByTestId(`task-row-${current.id}`);
    await row.getByRole('button', { name: /^今天处理/ }).click();
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('详情', { exact: true }).fill('从搜索中修改');
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('button', { name: '日期', exact: true }).click();
    await page.getByRole('button', { name: '清除', exact: true }).click();
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('任务标题', { exact: true }).click();
    await expect.poll(async () => (await task(request, current.id)).dueDate).toBeNull();
    await expect(row).toBeVisible();
    await page.goto('/#/today');
    await expect(page.getByTestId(`task-row-${current.id}`)).toBeHidden();
    await expect(page.getByTestId(`task-row-${overdue.id}`)).toBeVisible();
    expect((await task(request, current.id)).description).toBe('从搜索中修改');
  });

  test('清单排序在刷新与标题编辑后保持，过滤时不提供部分排序', async ({ page, request }) => {
    const list = await data(await request.post(`${apiUrl}/api/topics`, { data: { name: '排序清单' } }));
    const first = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '第一条' } }));
    const second = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '第二条' } }));
    await page.goto('/#/board');
    await page.getByTestId(`task-row-${second.id}`).getByRole('button', { name: '任务操作：第二条', exact: true }).click();
    await page.getByRole('menuitem', { name: '上移任务：第二条', exact: true }).click();
    await expect.poll(async () => (await data(await request.get(`${apiUrl}/api/tasks?topicId=${list.id}&sort=manual`))).map((value: any) => value.id)).toEqual([second.id, first.id]);
    await page.getByTestId(`task-row-${second.id}`).getByRole('button', { name: '第二条', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
    await detail.getByLabel('任务标题', { exact: true }).fill('第二条已编辑');
    await detail.getByLabel('详情', { exact: true }).click();
    await expect.poll(async () => (await task(request, second.id)).title).toBe('第二条已编辑');
    await page.reload();
    await expect(page.getByTestId('task-list').locator('article').first()).toHaveAttribute('data-testid', `task-row-${second.id}`);
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByRole('combobox', { name: '筛选完成状态', exact: true }).selectOption('open');
    await expect(page.getByRole('button', { name: '上移任务：第二条已编辑', exact: true })).toBeHidden();
  });

  test('清单里用指针拖动调整顺序，点击标题仍打开详情', async ({ page, request }) => {
    const list = await data(await request.post(`${apiUrl}/api/topics`, { data: { name: '拖动清单' } }));
    const first = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '第一条' } }));
    const second = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '第二条' } }));
    const third = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '第三条' } }));
    await page.goto('/#/board');
    await expect(page.getByText('上下拖动调整顺序，向右拖成子任务，向左拖回根任务。', { exact: true })).toBeVisible();
    const start = page.getByTestId(`task-row-${third.id}`);
    const target = page.getByTestId(`task-row-${first.id}`);
    await expect(start).toBeVisible();
    const from = await start.boundingBox();
    const to = await target.boundingBox();
    if (!from || !to) throw new Error('任务行没有布局');
    const x = from.x + Math.min(160, from.width * 0.45);
    await page.mouse.move(x, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, from.y + from.height / 2 + 18, { steps: 5 });
    await page.mouse.move(x, to.y + 12, { steps: 24 });
    // dnd-kit calls preventDefault on mousemove, and Playwright then drops mouseup.
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: to.y + 12, button: 'left', buttons: 0, clickCount: 1 });
    await expect.poll(async () => (await data(await request.get(`${apiUrl}/api/tasks?topicId=${list.id}&sort=manual`))).map((value: { id: string }) => value.id)).toEqual([third.id, first.id, second.id]);
    await page.reload();
    await expect(page.getByTestId('task-list').locator('article').first()).toHaveAttribute('data-testid', `task-row-${third.id}`);
    const opened = page.getByTestId(`task-row-${third.id}`);
    await opened.getByRole('button', { name: '任务操作：第三条', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '移动到' })).toBeVisible();
    await page.keyboard.press('Escape');
    await opened.getByRole('button', { name: '第三条', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
    await expect(detail.getByLabel('详情', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await expect(detail).toBeHidden();
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByRole('combobox', { name: '筛选完成状态', exact: true }).selectOption('open');
    await expect(page.locator('.task-drag-handle')).toHaveCount(0);
  });

  test('子任务拖动只在同一父任务下换位', async ({ page, request }) => {
    const parent = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '父任务' } }));
    const first = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '子一', parentId: parent.id } }));
    const second = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '子二', parentId: parent.id } }));
    await page.goto('/#/inbox');
    const list = page.getByTestId('task-list');
    const start = list.getByTestId(`task-row-${second.id}`);
    const target = list.getByTestId(`task-row-${first.id}`);
    await expect(start).toBeVisible();
    const from = await start.boundingBox();
    const to = await target.boundingBox();
    if (!from || !to) throw new Error('子任务行没有布局');
    const x = from.x + Math.min(160, from.width * 0.45);
    await page.mouse.move(x, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, from.y + from.height / 2 - 18, { steps: 5 });
    await page.mouse.move(x, to.y + 8, { steps: 20 });
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: to.y + 8, button: 'left', buttons: 0, clickCount: 1 });
    await expect.poll(async () => (await task(request, parent.id)).children.map((value: { id: string }) => value.id)).toEqual([second.id, first.id]);
    expect((await task(request, second.id)).parentId).toBe(parent.id);
  });

  test('拖动可以向右变成子任务，向左变回根任务', async ({ page, request }) => {
    const list = await data(await request.post(`${apiUrl}/api/topics`, { data: { name: '缩进清单' } }));
    const parent = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '甲' } }));
    const child = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '乙' } }));
    await page.goto('/#/board');
    const childRow = page.getByTestId(`task-row-${child.id}`);
    await expect(childRow).toBeVisible();
    const from = await childRow.boundingBox();
    if (!from) throw new Error('任务行没有布局');
    const x = from.x + Math.min(140, from.width * 0.4);
    const y = from.y + from.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y, { steps: 12 });
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 40, y, button: 'left', buttons: 0, clickCount: 1 });
    await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect.poll(async () => (await task(request, child.id)).parentId).toBe(parent.id);
    const nested = await childRow.boundingBox();
    if (!nested) throw new Error('子任务行没有布局');
    const nx = nested.x + Math.min(140, nested.width * 0.4);
    const ny = nested.y + nested.height / 2;
    await page.mouse.move(nx, ny);
    await page.mouse.down();
    await page.mouse.move(nx - 48, ny, { steps: 12 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nx - 48, y: ny, button: 'left', buttons: 0, clickCount: 1 });
    await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect.poll(async () => (await task(request, child.id)).parentId).toBeNull();
    const grandchild = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '丙', parentId: parent.id } }));
    await page.reload();
    const parentRow = page.getByTestId(`task-row-${parent.id}`);
    await expect(parentRow).toBeVisible();
    const block = await parentRow.boundingBox();
    if (!block) throw new Error('父任务行没有布局');
    const px = block.x + Math.min(140, block.width * 0.4);
    const py = block.y + block.height / 2;
    await page.mouse.move(px, py);
    await page.mouse.down();
    await page.mouse.move(px + 40, py, { steps: 12 });
    const released = await page.context().newCDPSession(page);
    await released.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px + 40, y: py, button: 'left', buttons: 0, clickCount: 1 });
    await expect(page.getByRole('heading', { name: '确认连带修改', exact: true })).toHaveCount(0);
    await expect.poll(async () => (await task(request, parent.id)).parentId).toBeNull();
    expect(grandchild.parentId).toBe(parent.id);
  });

  test('删除父任务后成组恢复，不复活之前已删除的子任务', async ({ page, request }) => {
    const parent = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '家庭任务' } }));
    const earlier = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '早已删除', parentId: parent.id } }));
    await request.delete(`${apiUrl}/api/tasks/${earlier.id}`);
    await page.goto('/#/inbox');
    const parentRow = page.getByTestId(`task-row-${parent.id}`);
    await parentRow.getByRole('button', { name: '任务操作：家庭任务', exact: true }).click();
    await page.getByRole('menuitem', { name: '添加子任务', exact: true }).click();
    const children = page.getByRole('dialog', { name: '子任务', exact: true });
    await children.getByRole('textbox', { name: '子任务名称', exact: true }).fill('一起处理');
    await children.getByRole('button', { name: '添加子任务', exact: true }).click();
    await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect(children.getByRole('textbox', { name: '子任务名称', exact: true })).toHaveValue('');
    const child = (await tasks(request)).find((value: any) => value.title === '一起处理');
    expect(child.parentId).toBe(parent.id);
    await page.keyboard.press('Escape');
    await expect(children).toBeHidden();
    await page.getByTestId(`task-row-${parent.id}`).getByRole('button', { name: '任务操作：家庭任务', exact: true }).click();
    await page.getByRole('menuitem', { name: '删除任务：家庭任务', exact: true }).click();
    await page.getByRole('dialog', { name: '删除任务', exact: true }).getByRole('button', { name: '移入回收站', exact: true }).click();
    await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect(page.getByTestId(`task-row-${parent.id}`)).toBeHidden();
    await page.goto('/#/trash');
    const parentTrash = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '家庭任务', exact: true }) });
    await parentTrash.getByRole('button', { name: '恢复', exact: true }).click();
    await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect.poll(async () => (await tasks(request)).map((value: any) => value.id)).toEqual(expect.arrayContaining([parent.id, child.id]));
    expect((await tasks(request)).map((value: any) => value.id)).not.toContain(earlier.id);
    await page.goto('/#/inbox');
    await expect(page.getByTestId(`task-row-${parent.id}`)).toBeVisible();
    await expect(page.getByTestId(`task-row-${child.id}`)).toBeVisible();
  });

  test('归档清单保留任务归属，恢复后重新显示任务', async ({ page, request }) => {
    const list = await data(await request.post(`${apiUrl}/api/topics`, { data: { name: '保留结构' } }));
    const item = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: list.id, title: '需要保留的任务' } }));
    await page.goto('/#/topics');
    await page.getByRole('button', { name: '编辑清单：保留结构', exact: true }).last().click();
    await page.getByRole('dialog', { name: '编辑清单', exact: true }).getByRole('button', { name: '归档清单', exact: true }).click();
    await page.getByRole('dialog', { name: '归档清单', exact: true }).getByRole('button', { name: '归档清单', exact: true }).click();
    await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '编辑清单', exact: true })).toBeHidden();
    await expect(page).toHaveURL(/#\/inbox$/);
    await expect(page.getByRole('heading', { name: '收集箱', exact: true })).toBeVisible();
    await expect.poll(async () => (await data(await request.get(`${apiUrl}/api/topics`))).length).toBe(0);
    expect((await e2eDatabase.task.findUniqueOrThrow({ where: { id: item.id } })).topicId).toBe(list.id);
    await page.goto('/#/archived');
    await page.getByRole('button', { name: '恢复清单', exact: true }).click();
    await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect.poll(async () => (await data(await request.get(`${apiUrl}/api/topics`))).length).toBe(1);
    await page.goto('/#/board');
    await expect(page.getByTestId(`task-row-${item.id}`)).toBeVisible();
    expect((await task(request, item.id)).topicId).toBe(list.id);
  });

  test('创建标签并分配、清空和删除，始终保留原任务', async ({ page, request }) => {
    const item = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '分类任务' } }));
    await page.goto('/#/tags');
    await page.getByRole('textbox', { name: '标签名称', exact: true }).fill('重要事项');
    await page.getByRole('button', { name: '创建标签', exact: true }).click();
    await expect(page.getByRole('button', { name: '#重要事项', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '把“重要事项”改成蓝', exact: true }).click();
    await expect.poll(async () => (await data(await request.get(`${apiUrl}/api/tags`)))[0].color).toBe('blue');
    const label = (await data(await request.get(`${apiUrl}/api/tags`)))[0];
    await page.goto('/#/inbox');
    const row = page.getByTestId(`task-row-${item.id}`);
    await row.getByRole('button', { name: '分类任务', exact: true }).click();
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('button', { name: '标签', exact: true }).click();
    const tag = page.getByRole('checkbox', { name: '重要事项', exact: true });
    await tag.check();
    await expect.poll(async () => (await task(request, item.id)).tagIds).toEqual([label.id]);
    await tag.uncheck();
    await expect.poll(async () => (await task(request, item.id)).tagIds).toEqual([]);
    await tag.check();
    await expect.poll(async () => (await task(request, item.id)).tagIds).toEqual([label.id]);
    await page.goto('/#/tags');
    await page.getByRole('button', { name: '删除标签：重要事项', exact: true }).click();
    await page.getByRole('dialog', { name: '删除标签', exact: true }).getByRole('button', { name: '删除标签', exact: true }).click();
    await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect(page.getByRole('button', { name: '#重要事项', exact: true })).toBeHidden();
    expect(await task(request, item.id)).toMatchObject({ title: '分类任务', tagIds: [] });
  });

  test('完成父任务先确认，取消保持未完成，重开子任务连带重开父任务', async ({ page, request }) => {
    const parent = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '带孩子的任务' } }));
    const child = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '尚未完成的子任务', parentId: parent.id } }));
    await page.goto('/#/inbox');
    const parentRow = page.getByTestId(`task-row-${parent.id}`);
    const childRow = page.getByTestId(`task-row-${child.id}`);
    // Use click: a declined completion intentionally leaves the checkbox unchecked.
    await parentRow.getByRole('checkbox', { name: '完成任务：带孩子的任务', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '一并完成子任务？', exact: true });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    expect((await task(request, parent.id)).status).toBe('todo');
    expect((await task(request, child.id)).status).toBe('todo');
    await parentRow.getByRole('checkbox', { name: '完成任务：带孩子的任务', exact: true }).click();
    await confirmation.getByRole('button', { name: '一并完成', exact: true }).click();
    await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect.poll(async () => (await task(request, parent.id)).status).toBe('done');
    await expect.poll(async () => (await task(request, child.id)).status).toBe('done');
    await page.getByText('已完成 · 1', { exact: true }).click();
    await childRow.getByRole('checkbox', { name: '重开任务：尚未完成的子任务', exact: true }).click();
    await page.getByRole('button', { name: '确认影响并执行', exact: true }).click();
    await expect(childRow.getByRole('checkbox', { name: '完成任务：尚未完成的子任务', exact: true })).not.toBeChecked();
    await expect.poll(async () => (await task(request, child.id)).status).toBe('todo');
    await expect.poll(async () => (await task(request, parent.id)).status).toBe('todo');
    await expect(parentRow.getByRole('checkbox', { name: '完成任务：带孩子的任务', exact: true })).not.toBeChecked();
    await page.reload();
    await expect(childRow.getByRole('checkbox', { name: '完成任务：尚未完成的子任务', exact: true })).not.toBeChecked();
  });

  test('迟到创建响应不会清空另一清单草稿，等待期间 Enter 不会重复提交', async ({ page, request }) => {
    const firstList = await data(await request.post(`${apiUrl}/api/topics`, { data: { name: '第一清单' } }));
    const secondList = await data(await request.post(`${apiUrl}/api/topics`, { data: { name: '第二清单' } }));
    const captured = gate();
    const releaseResponse = gate();
    let creates = 0;
    await page.route('**/api/tasks', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      creates += 1;
      const response = await route.fetch();
      captured.release();
      await releaseResponse.promise;
      await route.fulfill({ response });
    });
    try {
      await page.goto('/#/topics');
      await page.getByRole('button', { name: '第一清单', exact: true }).last().click();
      const capture = page.getByRole('textbox', { name: '任务名称', exact: true });
      await capture.fill('第一清单迟到任务');
      await capture.press('Enter');
      await captured.promise;
      await capture.press('Enter');
      await capture.press('Enter');
      expect(creates).toBe(1);
      await expect(page.getByRole('button', { name: '正在添加…', exact: true })).toBeDisabled();
      await page.goto('/#/topics');
      await page.getByRole('button', { name: '第二清单', exact: true }).last().click();
      await expect(page.getByRole('heading', { name: '第二清单', exact: true })).toBeVisible();
      await capture.fill('第二清单未提交草稿');
      releaseResponse.release();
      await expect(page.getByText('任务已创建', { exact: true }).first()).toBeVisible();
      await expect(capture).toHaveValue('第二清单未提交草稿');
      await expect(page.getByRole('heading', { name: '第二清单', exact: true })).toBeVisible();
      expect(await data(await request.get(`${apiUrl}/api/tasks?topicId=${secondList.id}`))).toHaveLength(0);
      const created = await data(await request.get(`${apiUrl}/api/tasks?topicId=${firstList.id}`));
      expect(created).toHaveLength(1);
      expect(creates).toBe(1);
      await expect(page.getByTestId(`task-row-${created[0].id}`)).toBeHidden();
      await page.reload();
      await expect(capture).toHaveValue('第二清单未提交草稿');
      await page.goto('/#/topics');
      await page.getByRole('button', { name: '第一清单', exact: true }).last().click();
      await expect(page.getByTestId(`task-row-${created[0].id}`)).toBeVisible();
      await expect(capture).toHaveValue('');
    } finally { releaseResponse.release(); }
  });

  test('同任务按序保存，一个任务失败不会覆盖另一任务的成功修改', async ({ page, request }) => {
    const first = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '顺序任务' } }));
    const other = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '独立任务' } }));
    const started = gate();
    const releaseFirst = gate();
    const receivedStatuses: string[] = [];
    let firstStatus = 0;
    const firstPattern = `**/api/tasks/${first.id}`;
    await page.route(firstPattern, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const body = route.request().postDataJSON();
      receivedStatuses.push(body.status);
      if (body.status !== 'doing') return route.continue();
      started.release();
      await releaseFirst.promise;
      const response = await route.fetch();
      firstStatus = response.status();
      await route.fulfill({ response });
    });
    try {
      await page.goto('/#/inbox');
      await page.getByRole('button', { name: '看板', exact: true }).click();
      await page.getByRole('combobox', { name: '修改状态：顺序任务', exact: true }).click();
      await page.getByRole('option', { name: '进行中', exact: true }).click();
      await started.promise;
      const card = page.getByTestId(`task-card-${first.id}`);
      await card.getByRole('button', { name: '顺序任务', exact: true }).click();
      const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
      await detail.getByLabel('详情', { exact: true }).fill('后续保存');
      await detail.getByLabel('任务标题', { exact: true }).click();
      const status = card.locator('[aria-label="修改状态：顺序任务"]');
      const covered = await status.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return Boolean(top && top !== element && !element.contains(top));
      });
      if (!covered) {
        await status.click();
        await page.getByRole('option', { name: '已完成', exact: true }).click();
      } else {
        await status.evaluate((element) => element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 })));
        const option = page.locator('[role="option"]').filter({ hasText: /^已完成$/ });
        await option.waitFor({ state: 'attached' });
        await option.evaluate((element) => {
          element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', button: 0 }));
          element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
      }
      expect((await task(request, first.id)).status).toBe('todo');
      expect(receivedStatuses).toEqual(['doing']);
      releaseFirst.release();
      await expect.poll(async () => (await task(request, first.id)).description).toBe('后续保存');
      expect(firstStatus).toBe(200);
      expect(receivedStatuses[0]).toBe('doing');
      expect(receivedStatuses).toContain('done');
      expect(receivedStatuses).toHaveLength(3);
      expect((await task(request, first.id)).status).toBe('done');
      await page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    } finally { releaseFirst.release(); }
    await page.unroute(firstPattern);

    const failedStarted = gate();
    const releaseFailure = gate();
    await page.route(firstPattern, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      failedStarted.release();
      await releaseFailure.promise;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ data: null, error: '第一个任务保存失败' }) });
    });
    try {
      await page.getByRole('button', { name: '列表', exact: true }).click();
      await page.getByText('已完成 · 1', { exact: true }).click();
      await page.getByTestId(`task-row-${first.id}`).getByRole('checkbox', { name: '重开任务：顺序任务', exact: true }).click();
      await failedStarted.promise;
      const otherRow = page.getByTestId(`task-row-${other.id}`);
      await otherRow.getByRole('button', { name: '独立任务', exact: true }).click();
      const otherDetail = page.getByRole('dialog', { name: '任务详情', exact: true });
      await otherDetail.getByLabel('详情', { exact: true }).fill('另一任务的成功修改');
      await otherDetail.getByLabel('任务标题', { exact: true }).click();
      await expect.poll(async () => (await task(request, other.id)).description).toBe('另一任务的成功修改');
      await otherDetail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
      releaseFailure.release();
      await expect(page.getByText('第一个任务保存失败', { exact: true }).first()).toBeVisible();
      expect((await task(request, other.id)).description).toBe('另一任务的成功修改');
      expect((await task(request, first.id)).status).toBe('done');
      await expect(page.getByTestId(`task-row-${first.id}`).getByRole('checkbox', { name: '重开任务：顺序任务', exact: true })).toBeChecked();
    } finally { releaseFailure.release(); }
  });

  test('后台同字段修改保留脏稿并要求明确选择后才能覆盖', async ({ page, request }) => {
    const item = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '原始标题' } }));
    await page.goto('/#/inbox');
    const row = page.getByTestId(`task-row-${item.id}`);
    await row.getByRole('button', { name: '原始标题', exact: true }).click();
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('任务标题', { exact: true }).fill('尚未提交的本地标题');
    await data(await request.patch(`${apiUrl}/api/tasks/${item.id}`, { data: { title: '后台已更新的标题' } }));
    await expect(page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('alert')).toContainText('后台已更新标题');
    await expect(page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('任务标题', { exact: true })).toHaveValue('尚未提交的本地标题');
    expect((await task(request, item.id)).title).toBe('后台已更新的标题');
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('checkbox', { name: '保存时使用我的编辑', exact: true }).check();
    await page.getByRole('dialog', { name: '任务详情', exact: true }).getByLabel('详情', { exact: true }).click();
    await expect.poll(async () => (await task(request, item.id)).title).toBe('尚未提交的本地标题');
  });

  test('本地跨午夜后今天任务转为逾期，新日期任务自动进入今天', async ({ page, request }) => {
    const previousDay = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '跨日之前', dueDate: '2026-09-20' } }));
    const nextDay = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '跨日之后', dueDate: '2026-09-21' } }));
    // Fix only Date; keep query-notification timers and the real date-refresh
    // interval running so the test exercises the application's normal refresh.
    await page.clock.setFixedTime(new Date(2026, 8, 20, 23, 59, 58));
    await page.goto('/#/today');
    const today = page.locator('section').filter({ has: page.getByRole('heading', { name: /^今天 ·/ }) });
    const overdue = page.locator('section').filter({ has: page.getByRole('heading', { name: /^逾期 ·/ }) });
    await expect(today.getByTestId(`task-row-${previousDay.id}`)).toBeVisible();
    await expect(page.getByTestId(`task-row-${nextDay.id}`)).toBeHidden();
    await page.clock.setFixedTime(new Date(2026, 8, 21, 0, 0, 1));
    await expect(overdue.getByTestId(`task-row-${previousDay.id}`)).toBeVisible();
    await expect(today.getByTestId(`task-row-${nextDay.id}`)).toBeVisible();
    await expect(today.getByTestId(`task-row-${previousDay.id}`)).toBeHidden();
    expect((await task(request, previousDay.id)).dueDate).toBe('2026-09-20');
    expect((await task(request, nextDay.id)).dueDate).toBe('2026-09-21');
  });

  test('分类之间互不可见，标签只缩小当前分类', async ({ page, request }) => {
    const topic = await data(await request.post(`${apiUrl}/api/topics`, { data: { name: '隔离主题' } }));
    const inboxTask = await data(await request.post(`${apiUrl}/api/tasks`, { data: { title: '收集箱专属' } }));
    const topicTask = await data(await request.post(`${apiUrl}/api/tasks`, { data: { topicId: topic.id, title: '主题专属' } }));
    const tag = await data(await request.post(`${apiUrl}/api/tags`, { data: { name: '跨类标签' } }));
    await request.patch(`${apiUrl}/api/tasks/${inboxTask.id}`, { data: { tagIds: [tag.id] } });
    await request.patch(`${apiUrl}/api/tasks/${topicTask.id}`, { data: { tagIds: [tag.id] } });

    await page.goto('/#/inbox');
    await expect(page.getByRole('heading', { name: '收集箱', exact: true })).toBeVisible();
    await expect(page.getByText('这是一个分类，这里只显示放在收集箱里的任务。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '收集箱', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId(`task-row-${inboxTask.id}`)).toBeVisible();
    await expect(page.getByTestId(`task-row-${topicTask.id}`)).toHaveCount(0);
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByRole('combobox', { name: '筛选标签', exact: true }).selectOption(tag.id);
    await expect(page.getByTestId(`task-row-${inboxTask.id}`)).toBeVisible();
    await expect(page.getByTestId(`task-row-${topicTask.id}`)).toHaveCount(0);

    await page.goto('/#/board');
    await expect(page.getByTestId(`task-row-${topicTask.id}`)).toBeVisible();
    await expect(page.getByTestId(`task-row-${inboxTask.id}`)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '收集箱', exact: true })).not.toHaveAttribute('aria-current', 'page');

    await page.goto('/#/search');
    const inboxRow = page.getByTestId(`task-row-${inboxTask.id}`);
    await expect(inboxRow.getByText('收集箱', { exact: true })).toBeVisible();
    await expect(inboxRow.getByText('#跨类标签', { exact: true })).toBeVisible();
    await expect(inboxRow.locator('.task-place-chip + .task-tag-chip, .task-place-chip ~ .task-tag-chip').first()).toHaveAttribute('data-color', 'violet');
    await expect(page.getByTestId(`task-row-${topicTask.id}`).getByText('隔离主题', { exact: true })).toBeVisible();

    await page.goto('/#/tags');
    await expect(page.getByText('选择一个标签后，按分类查看带有该标签的任务。', { exact: true })).toBeVisible();
    await expect(page.getByTestId(`task-row-${inboxTask.id}`)).toHaveCount(0);
    await page.getByRole('button', { name: '#跨类标签', exact: true }).click();
    const inboxSection = page.getByRole('region', { name: '收集箱', exact: true });
    const topicSection = page.getByRole('region', { name: '隔离主题', exact: true });
    await expect(inboxSection.getByTestId(`task-row-${inboxTask.id}`)).toBeVisible();
    await expect(inboxSection.getByTestId(`task-row-${topicTask.id}`)).toHaveCount(0);
    await expect(topicSection.getByTestId(`task-row-${topicTask.id}`)).toBeVisible();
    await expect(topicSection.getByTestId(`task-row-${inboxTask.id}`)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });
});
