import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = 'http://127.0.0.1:3015';
const dueDate = '2026-09-24';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

async function openDatedTask(page: Page, taskId: string) {
  const row = page.getByTestId(`task-row-${taskId}`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '窄窗日期', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(detail).toBeVisible();
  return { row, detail };
}

test('窄窗口打开任务后列表仍可读，日期仍显示', async ({ page, request }) => {
  const created = await request.post(`${apiUrl}/api/tasks`, { data: { title: '窄窗日期', dueDate } });
  expect(created.ok(), await created.text()).toBe(true);
  const task = (await created.json()).data;

  for (const width of [578, 700, 1200]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/#/inbox');
    const { row, detail } = await openDatedTask(page, task.id);
    const metrics = await row.evaluate((node) => {
      const time = node.querySelector('time');
      const main = node.closest('main');
      const timeStyle = time ? getComputedStyle(time) : null;
      return {
        rowWidth: node.getBoundingClientRect().width,
        mainWidth: main?.getBoundingClientRect().width ?? 0,
        dateShown: Boolean(time && timeStyle && timeStyle.display !== 'none' && timeStyle.visibility !== 'hidden'),
        dateText: time?.textContent ?? '',
        scrollOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(metrics.dateShown, `${width}px 应显示截止日期`).toBe(true);
    expect(metrics.dateText).toContain(dueDate);
    expect(metrics.rowWidth, `${width}px 任务行宽度`).toBeGreaterThan(240);
    expect(metrics.mainWidth, `${width}px 列表栏宽度`).toBeGreaterThan(width >= 1024 ? 360 : 240);
    expect(metrics.scrollOverflow).toBeLessThanOrEqual(1);
    if (width < 1024) {
      const box = await detail.boundingBox();
      expect(box?.width ?? width).toBeLessThan(width - 40);
    }
    await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await expect(detail).toBeHidden();
  }
});

test('缩放跨过 1024px 时，正在输入的标题和详情还在', async ({ page, request }) => {
  const created = await request.post(`${apiUrl}/api/tasks`, { data: { title: '原来的标题', description: '原来的详情' } });
  expect(created.ok(), await created.text()).toBe(true);
  const task = (await created.json()).data as { id: string };
  const saved = async () => {
    const response = await request.get(`${apiUrl}/api/tasks/${task.id}`);
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data as { title: string; description: string };
  };
  const detail = () => page.getByRole('dialog', { name: '任务详情', exact: true });
  const showAt = async (width: number) => {
    await page.setViewportSize({ width, height: 800 });
    await expect(detail()).toBeVisible();
    await expect(page.getByRole('dialog', { name: '保存未完成的编辑？' })).toHaveCount(0);
    if (width < 1024) await expect.poll(async () => (await detail().boundingBox())?.width ?? width).toBeLessThan(width - 40);
    else await expect.poll(async () => (await detail().boundingBox())?.x ?? 0).toBeGreaterThan(700);
    return detail();
  };

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '原来的标题', exact: true }).click();
  await detail().getByLabel('任务标题', { exact: true }).fill('还没保存的标题');
  for (const width of [800, 1200]) {
    const pane = await showAt(width);
    await expect(pane.getByLabel('任务标题', { exact: true })).toHaveValue('还没保存的标题');
    await expect(pane.getByLabel('任务标题', { exact: true })).toBeFocused();
    await expect(pane.getByLabel('详情', { exact: true })).toContainText('原来的详情');
    expect(await saved()).toMatchObject({ title: '原来的标题', description: '原来的详情' });
  }

  await detail().getByLabel('详情', { exact: true }).fill('还没保存的详情');
  await expect.poll(async () => (await saved()).title).toBe('还没保存的标题');
  expect((await saved()).description).toBe('原来的详情');
  for (const width of [800, 1200]) {
    const pane = await showAt(width);
    await expect(pane.getByLabel('任务标题', { exact: true })).toHaveValue('还没保存的标题');
    await expect(pane.getByLabel('详情', { exact: true })).toHaveAttribute('data-value', '还没保存的详情');
    await expect(pane.getByLabel('详情', { exact: true })).toBeFocused();
    expect((await saved()).description).toBe('原来的详情');
  }
  expect(await page.evaluate(() => ({
    overflow: document.body.style.overflow,
    pointerEvents: document.body.style.pointerEvents,
    scrollLocked: document.body.hasAttribute('data-scroll-locked'),
  }))).toEqual({ overflow: '', pointerEvents: '', scrollLocked: false });

  await page.setViewportSize({ width: 800, height: 800 });
  await page.reload();
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '还没保存的标题', exact: true }).click();
  await detail().getByLabel('详情', { exact: true }).fill('从窄屏接着写');
  for (const width of [1200, 800]) {
    const pane = await showAt(width);
    await expect(pane.getByLabel('详情', { exact: true })).toHaveAttribute('data-value', '从窄屏接着写');
    await expect(pane.getByLabel('详情', { exact: true })).toBeFocused();
    expect((await saved()).description).toBe('原来的详情');
  }
  await expect(page.getByRole('dialog', { name: '保存未完成的编辑？' })).toHaveCount(0);
});
