import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

const labels = ['收集箱', '今天', '规划', '专注', '四象限', '清单', '搜索', '标签', '已归档', '回收站', '变更历史', '设置', 'AI 连接', '待确认', '工作上下文', '资料库', '技能', 'AI 执行', 'Worktree 管理', '定期回顾'];

test('更多页展示 4 个分组、20 个入口与聊天卡片', async ({ page }) => {
  await page.goto('/#/more');
  const nav = page.getByRole('navigation', { name: '工作区导航' });
  await expect(nav).toBeVisible();
  for (const group of ['视图', '整理', '工作', '系统']) {
    await expect(page.getByRole('region', { name: group })).toBeVisible();
  }
  for (const label of labels) {
    await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: '打开聊天' })).toBeVisible();
});

test('入口行触控目标高度不低于 48px', async ({ page }) => {
  await page.goto('/#/more');
  const row = page.getByRole('navigation', { name: '工作区导航' }).getByRole('button', { name: '收集箱', exact: true });
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(48);
});

test('点击入口跳转对应视图', async ({ page }) => {
  await page.goto('/#/more');
  await page.getByRole('navigation', { name: '工作区导航' }).getByRole('button', { name: '标签', exact: true }).click();
  await expect(page).toHaveURL(/#\/tags$/);
});

test('点击设置弹出工作区设置弹窗而非离开底页', async ({ page }) => {
  await page.goto('/#/more');
  await page.getByRole('navigation', { name: '工作区导航' }).getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible();
  // 设置弹窗是模态的，会把底页标成 aria-hidden，getByRole 因此找不到仍留在页面上的导航。
  await expect(page.locator('nav[aria-label="工作区导航"]')).toBeVisible();
});

test('手机视口分组为单列，桌面视口分组为两列', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/more');
  const nav = page.getByRole('navigation', { name: '工作区导航' });
  await expect(nav).toBeVisible();
  const mobileColumns = await nav.evaluate((node) => getComputedStyle(node).gridTemplateColumns);
  expect(mobileColumns.trim().split(/\s+/).length).toBe(1);

  await page.setViewportSize({ width: 1280, height: 800 });
  const desktopColumns = await nav.evaluate((node) => getComputedStyle(node).gridTemplateColumns);
  expect(desktopColumns.trim().split(/\s+/).length).toBe(2);
});

test('手机宽度从更多页点设置后看到分类列表', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/more');
  await page.getByRole('navigation', { name: '工作区导航' }).getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('settings-category-list')).toBeVisible();
  for (const name of ['模型与 AI', '主控与电脑', '技能', '项目', '界面', '数据', '关于', '回收站', '变更历史']) {
    await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page).toHaveURL(/#\/settings$/);
});
