import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import type { Locator } from '@playwright/test';
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

const longDescription = [
  '这个任务今天肯定得收口，本地完成了。',
  '明天才能上测试，设计测试环境的数据的流程。',
  '现在的问题是。',
  '放开mock',
  'mock没问题',
  '回填没问题，多组件的回填也受开关的管理。',
  '只有加号的问题了。这个只能上正式测。测服不知道为什么有问题',
  '补充一行，把正文撑过详情可视高度。',
  '再补充一行，把正文撑过详情可视高度。',
  '继续补充，避免最后一行盖住资料。',
  '资料标题必须落在正文底边下面。',
  '窄窗口也要能把整段滚出来。',
].join('\n\n');

async function openDetail(page: Page, request: APIRequestContext, title: string, description: string) {
  const created = await request.post(`${api}/api/tasks`, { data: { title, description } });
  expect(created.ok()).toBe(true);
  const task = (await created.json()).data;
  const existing = page.getByRole('dialog', { name: '任务详情', exact: true });
  if (await existing.isVisible()) {
    await existing.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await expect(existing).toBeHidden();
  }
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(detail).toBeVisible();
  return detail;
}

async function expectProseAboveMaterials(detail: Locator) {
  const prose = detail.locator('[data-task-editor-prose]');
  const materials = detail.getByTestId('task-materials');
  await expect(prose).toBeVisible();
  await expect(materials).toBeVisible();
  const fit = await prose.evaluate((node) => ({
    overflow: node.scrollHeight - node.clientHeight,
    proseBottom: node.getBoundingClientRect().bottom,
    materialsTop: node.closest('[role="dialog"]')?.querySelector('[data-testid="task-materials"]')?.getBoundingClientRect().top ?? 0,
  }));
  expect(fit.overflow).toBeLessThanOrEqual(1);
  expect(fit.proseBottom).toBeLessThanOrEqual(fit.materialsTop + 1);
}

test('长正文撑开编辑器，不盖住资料', async ({ page, request }) => {
  for (const viewport of [{ width: 1400, height: 900 }, { width: 800, height: 700 }]) {
    await page.setViewportSize(viewport);
    const detail = await openDetail(page, request, '长正文高度', longDescription);
    await expectProseAboveMaterials(detail);
    if (viewport.width < 1024) {
      const scrolled = await detail.evaluate((node) => {
        const scroller = node.querySelector('.overflow-y-auto');
        if (!(scroller instanceof HTMLElement)) return false;
        return scroller.scrollHeight > scroller.clientHeight + 1;
      });
      expect(scrolled).toBe(true);
    }
  }
});

test('短正文仍铺满详情剩余高度', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const detail = await openDetail(page, request, '短正文高度', '只有一行');
  await expectProseAboveMaterials(detail);
  const metrics = await detail.evaluate((node) => {
    const prose = node.querySelector('[data-task-editor-prose]');
    const focus = [...node.querySelectorAll('button')].find((button) => button.textContent?.includes('开始专注'));
    if (!(prose instanceof HTMLElement) || !(focus instanceof HTMLElement)) return null;
    const dialogBox = node.getBoundingClientRect();
    const focusBox = focus.getBoundingClientRect();
    return {
      proseHeight: prose.getBoundingClientRect().height,
      bottomGap: dialogBox.bottom - focusBox.bottom,
    };
  });
  expect(metrics).not.toBeNull();
  expect(metrics!.proseHeight).toBeGreaterThan(160);
  expect(metrics!.bottomGap).toBeGreaterThanOrEqual(0);
  expect(metrics!.bottomGap).toBeLessThan(48);

  const prose = detail.locator('[data-task-editor-prose]');
  const height = metrics!.proseHeight;
  await prose.click({ position: { x: 24, y: height - 12 } });
  await expect(prose).toBeFocused();
});
