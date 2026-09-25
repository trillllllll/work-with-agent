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
