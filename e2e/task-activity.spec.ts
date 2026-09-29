import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = 'http://127.0.0.1:3015';
const detailText = `需要完整保留的说明${'。'.repeat(80)}`;

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

async function measure(page: Page) {
  const dialog = page.getByRole('dialog', { name: '任务动态', exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((node) => node.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
  return dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      width: rect.width,
      left: rect.left,
      right: window.innerWidth - rect.right,
      top: rect.top,
      bottom: window.innerHeight - rect.bottom,
      viewport: window.innerWidth,
      scrollOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

test('详情和行菜单都能看到标题与详情改动，对话框留有边距', async ({ page, request }) => {
  const created = await request.post(`${apiUrl}/api/tasks`, { data: { title: '待整理任务' } });
  expect(created.ok(), await created.text()).toBe(true);
  const task = (await created.json()).data as { id: string };

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '待整理任务', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await detail.getByLabel('任务标题', { exact: true }).fill('改过的标题');
  await detail.getByLabel('详情', { exact: true }).fill(detailText);
  await detail.getByRole('button', { name: '任务动态', exact: true }).click();

  const activity = page.getByRole('dialog', { name: '任务动态', exact: true });
  await expect(activity.getByText(/你 ·/).first()).toBeVisible();
  await expect(activity.getByText('创建了任务', { exact: true })).toBeVisible();
  await expect(activity.getByText('把标题从 「待整理任务」 改成 「改过的标题」')).toBeVisible();
  await expect(activity.getByText('把详情从 「空」')).toBeVisible();
  await activity.getByRole('button', { name: '展开', exact: true }).click();
  await expect(activity.getByText(detailText)).toBeVisible();
  const desktop = await measure(page);
  expect(desktop.width).toBeLessThanOrEqual(512);
  expect(desktop.left).toBeGreaterThan(24);
  expect(desktop.right).toBeGreaterThan(24);
  expect(desktop.top).toBeGreaterThan(16);
  expect(desktop.bottom).toBeGreaterThan(16);
  await activity.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(activity).toBeHidden();

  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '任务操作：改过的标题', exact: true }).click();
  await page.getByRole('menuitem', { name: '任务动态', exact: true }).click();
  const fromMenu = page.getByRole('dialog', { name: '任务动态', exact: true });
  await expect(fromMenu.getByText('把标题从 「待整理任务」 改成 「改过的标题」')).toBeVisible();
  await fromMenu.getByRole('button', { name: '展开', exact: true }).click();
  await expect(fromMenu.getByText(detailText)).toBeVisible();
  await fromMenu.getByRole('button', { name: 'Close', exact: true }).click();

  await page.setViewportSize({ width: 390, height: 800 });
  await detail.getByRole('button', { name: '任务动态', exact: true }).click();
  const phone = await measure(page);
  expect(phone.width).toBeLessThan(phone.viewport - 40);
  expect(phone.left).toBeGreaterThan(16);
  expect(phone.right).toBeGreaterThan(16);
  expect(phone.top).toBeGreaterThan(16);
  expect(phone.bottom).toBeGreaterThan(16);
  expect(phone.scrollOverflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole('dialog', { name: '任务动态', exact: true }).getByText('把标题从 「待整理任务」 改成 「改过的标题」')).toBeVisible();
  await page.getByRole('dialog', { name: '任务动态', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '任务操作：改过的标题', exact: true }).click();
  await page.getByRole('menuitem', { name: '任务动态', exact: true }).click();
  const menuDialog = page.getByRole('dialog', { name: '任务动态', exact: true });
  await expect(menuDialog.getByText('把标题从 「待整理任务」 改成 「改过的标题」')).toBeVisible();
  await menuDialog.getByRole('button', { name: '展开', exact: true }).click();
  await expect(menuDialog.getByText(detailText)).toBeVisible();
  const menuBox = await measure(page);
  expect(menuBox.left).toBeGreaterThan(16);
  expect(menuBox.right).toBeGreaterThan(16);
});
