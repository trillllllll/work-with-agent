import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = 'http://127.0.0.1:3015';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    (window as any).__REACT_GRAB_DISABLED__ = true;
  });
  await page.setViewportSize({ width: 1400, height: 900 });
});

test.afterAll(async () => {
  await e2eDatabase.$disconnect();
});

test('打开和聚焦带格式正文不产生写入，也不显示源码', async ({ page, request }) => {
  const created = await request.post(`${api}/api/tasks`, {
    data: {
      title: '格式任务',
      description: '**hello**',
    },
  });
  expect(created.ok()).toBe(true);
  const task = (await created.json()).data;

  const writes: string[] = [];
  page.on('request', (req) => {
    if (
      req.method() === 'PATCH' &&
      new URL(req.url()).pathname === `/api/tasks/${task.id}`
    ) {
      writes.push(req.postData() ?? '');
    }
  });

  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).click();

  const body = page.getByRole('textbox', {
    name: '详情', exact: true,
  });
  await expect(body.locator('strong')).toHaveText('hello');

  await page.clock.install();
  await body.locator('strong').click();
  await page.clock.fastForward(1600);

  await expect(body.locator('strong')).toHaveText('hello');
  await expect(body).not.toContainText('**');
  expect(writes).toEqual([]);

  const after = (await (
    await request.get(`${api}/api/tasks/${task.id}`)
  ).json()).data;

  expect(after.description).toBe('**hello**');
  expect(after.revision).toBe(task.revision);
});

test('正文输入800ms后自动保存，不要求失焦', async ({ page, request }) => {
  const created = await request.post(`${api}/api/tasks`, {
    data: { title: '自动保存' },
  });
  const task = (await created.json()).data;

  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).click();

  const body = page.getByRole('textbox', {
    name: '详情', exact: true,
  });
  await body.fill('hello');

  await expect.poll(async () => {
    const response = await request.get(`${api}/api/tasks/${task.id}`);
    return (await response.json()).data.description;
  }).toBe('hello');

  await expect(body).toBeFocused();
  await expect(page.getByText('任务已更新', { exact: true }))
    .toHaveCount(0);
});

test('正文具有固定字号、行高和深浅色文字颜色', async ({ page, request }) => {
  const created = await request.post(`${api}/api/tasks`, {
    data: { title: '视觉断言', description: '正文' },
  });
  const task = (await created.json()).data;

  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).click();

  const body = page.getByRole('textbox', {
    name: '详情', exact: true,
  });

  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
  });
  await expect(body).toHaveCSS('font-size', '14px');
  await expect(body).toHaveCSS('line-height', '24px');
  await expect(body).toHaveCSS('color', 'rgb(18, 18, 18)');

  await page.evaluate(() => {
    document.documentElement.classList.add('dark');
  });
  await expect(body).toHaveCSS('color', 'rgb(240, 240, 240)');
});

test('勾选正文中的勾选项只更新正文，不创建子任务', async ({ page, request }) => {
  const created = await request.post(`${api}/api/tasks`, {
    data: { title: '勾选任务', description: '- [ ] 未完成事项\n' },
  });
  const task = (await created.json()).data;

  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });

  const checkbox = detail.locator('ul[data-type="taskList"] input[type="checkbox"]').first();
  await checkbox.click();

  await expect.poll(async () => {
    const response = await request.get(`${api}/api/tasks/${task.id}`);
    return (await response.json()).data.description;
  }).toBe('- [x] 未完成事项');
});
