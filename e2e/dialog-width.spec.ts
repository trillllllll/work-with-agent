import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = 'http://127.0.0.1:3015';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

async function measure(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((node) => node.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
  return dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      width: rect.width,
      left: rect.left,
      right: window.innerWidth - rect.right,
      top: rect.top,
      bottom: window.innerHeight - rect.bottom,
      viewport: window.innerWidth,
      maxWidth: style.maxWidth,
      scrollOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

test('弹窗宽度留出边距，不铺满窗口', async ({ page, request }) => {
  const created = await request.post(`${apiUrl}/api/tasks`, { data: { title: '宽度检查' } });
  expect(created.ok(), await created.text()).toBe(true);
  const task = (await created.json()).data;

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/topics');
  await page.getByRole('button', { name: '新建清单', exact: true }).first().click();
  const create = page.getByRole('dialog', { name: '新建清单', exact: true });
  await create.getByLabel('清单名称', { exact: true }).fill('临时清单');
  await create.getByRole('button', { name: '取消', exact: true }).click();
  await expect(create).toBeHidden();
  await page.getByRole('button', { name: '新建清单', exact: true }).first().click();
  const reopened = page.getByRole('dialog', { name: '新建清单', exact: true });
  await reopened.getByLabel('清单名称', { exact: true }).fill('宽度清单');
  const desktopForm = await measure(page, '新建清单');
  expect(desktopForm.width).toBeLessThanOrEqual(512);
  expect(desktopForm.left).toBeGreaterThan(24);
  expect(desktopForm.right).toBeGreaterThan(24);
  await reopened.getByRole('button', { name: '保存清单', exact: true }).click();
  await expect(reopened).toBeHidden();
  await expect(page.getByRole('heading', { name: '宽度清单', exact: true })).toBeVisible();

  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '任务操作：宽度检查', exact: true }).click();
  await page.getByRole('menuitem', { name: '删除任务：宽度检查', exact: true }).click();
  const confirm = await measure(page, '删除任务');
  expect(confirm.width).toBeLessThanOrEqual(512);
  expect(confirm.left).toBeGreaterThan(24);
  expect(confirm.viewport - confirm.width).toBeGreaterThan(48);
  await page.getByRole('dialog', { name: '删除任务', exact: true }).getByRole('button', { name: '取消', exact: true }).click();

  await page.goto('/#/settings');
  const settings = await measure(page, '设置');
  expect(settings.width).toBeLessThanOrEqual(1120);
  expect(settings.width).toBeGreaterThan(settings.viewport * 0.7);
  expect(settings.width).toBeLessThan(settings.viewport * 0.85);
  expect(settings.left).toBeGreaterThan(16);

  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto('/#/topics');
  await page.getByRole('button', { name: '新建清单', exact: true }).click();
  const narrowForm = await measure(page, '新建清单');
  expect(narrowForm.width).toBeLessThan(narrowForm.viewport - 40);
  expect(narrowForm.top).toBeGreaterThan(16);
  expect(narrowForm.bottom).toBeGreaterThan(16);
  expect(narrowForm.scrollOverflow).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');

  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '宽度检查', exact: true }).click();
  const detail = await measure(page, '任务详情');
  expect(detail.width).toBeLessThanOrEqual(672);
  expect(detail.width).toBeLessThan(detail.viewport - 40);
  expect(detail.left).toBeGreaterThan(16);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/#/topics');
  await page.getByRole('button', { name: '新建清单', exact: true }).click();
  const phoneForm = await measure(page, '新建清单');
  expect(phoneForm.width).toBeLessThanOrEqual(phoneForm.viewport - 47);
  expect(phoneForm.width).toBeGreaterThan(phoneForm.viewport - 56);
  expect(phoneForm.left).toBeGreaterThan(16);
  expect(phoneForm.scrollOverflow).toBeLessThanOrEqual(1);
});
