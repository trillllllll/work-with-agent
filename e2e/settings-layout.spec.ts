import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const shots = process.env.SETTINGS_SHOTS_DIR;

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

/** Acceptance screenshots: desktop ones from the Desktop Chrome project, phone ones from the Pixel 7 project. */
async function screenshot(page: Page, name: string) {
  if (!shots) return;
  if (test.info().project.name !== (name.startsWith('desktop') ? 'chromium' : 'mobile')) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/${name}-light.png` });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/${name}-dark.png` });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
}

test.describe('桌面', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });

  test('左侧分类导航切换右侧内容，地址和刷新保持分类', async ({ page }) => {
    await page.goto('/#/settings');
    const dialog = page.getByRole('dialog', { name: '设置' });
    const nav = dialog.getByRole('navigation', { name: '设置分类' });
    await expect(nav).toBeVisible();
    // 不带分类时默认显示模型与 AI，地址不改写。
    await expect(dialog.getByLabel('接口地址')).toBeVisible();
    await expect(nav.getByRole('button', { name: /模型与 AI/ })).toHaveAttribute('aria-current', 'page');
    await expect(page).toHaveURL(/#\/settings$/);
    await screenshot(page, 'desktop-model');

    await nav.getByRole('button', { name: /^数据/ }).click();
    await expect(page).toHaveURL(/#\/settings\/data$/);
    await expect(dialog.getByRole('heading', { name: '备份与恢复' })).toBeVisible();
    await expect(dialog.getByLabel('接口地址')).toHaveCount(0);
    await expect(dialog.getByTestId('mobile-navigation-settings')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('dialog').getByRole('heading', { name: '备份与恢复' })).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /^数据/ })).toHaveAttribute('aria-current', 'page');

    await page.getByRole('dialog').getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /^界面/ }).click();
    await expect(page).toHaveURL(/#\/settings\/ui$/);
    await expect(page.getByTestId('mobile-navigation-settings')).toBeVisible();
    await expect(page.getByTestId('language-settings')).toBeVisible();
    await expect(page.getByRole('dialog').getByLabel('接口地址')).toHaveCount(0);

    // 浏览器后退回到上一个分类。
    await page.goBack();
    await expect(page).toHaveURL(/#\/settings\/data$/);
    await expect(page.getByRole('dialog').getByRole('heading', { name: '备份与恢复' })).toBeVisible();
  });

  test('头部只有一行：标签、AI 助手和关闭', async ({ page }) => {
    await page.goto('/#/settings/local');
    const dialog = page.getByRole('dialog', { name: '设置' });
    await expect(dialog.getByRole('region', { name: '主控编排设置' })).toBeVisible();
    const tabs = dialog.getByRole('navigation', { name: '工作区设置导航' });
    const assistant = dialog.getByRole('button', { name: 'AI 助手', exact: true });
    const close = dialog.getByRole('button', { name: '关闭', exact: true });
    const boxes = await Promise.all([tabs, assistant, close].map((item) => item.boundingBox()));
    for (const box of boxes) expect(box).not.toBeNull();
    const centers = boxes.map((box) => box!.y + box!.height / 2);
    for (const center of centers) expect(Math.abs(center - centers[0])).toBeLessThan(4);
    const header = await dialog.locator('header').first().boundingBox();
    expect(header!.height).toBeLessThan(72);
    await screenshot(page, 'desktop-local');
    await dialog.getByRole('region', { name: '主控编排设置' }).scrollIntoViewIfNeeded();
    await screenshot(page, 'desktop-local-orchestration');

    await tabs.getByRole('button', { name: '回收站', exact: true }).click();
    await expect(page).toHaveURL(/#\/trash$/);
    await expect(page.getByRole('dialog', { name: '回收站' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('编排设置使用 WWA 的下拉和开关组件', async ({ page }) => {
    await page.goto('/#/settings/local');
    const section = page.getByRole('region', { name: '主控编排设置' });
    await expect(section).toBeVisible();
    // Radix 只留一个 aria-hidden 的原生 select 给表单用，页面上没有可见的原生控件。
    await expect(section.locator('select:not([aria-hidden="true"]), input[type=checkbox]:not([aria-hidden="true"])')).toHaveCount(0);
    const notify = section.getByRole('switch', { name: '编排待验收或暂停时发系统通知' });
    await expect(notify).toBeVisible();
    const provider = section.getByRole('combobox', { name: '默认 AI' });
    await expect(provider).toHaveText(/Codex/);
    await provider.click();
    await page.getByRole('option', { name: 'Claude' }).click();
    await expect(provider).toHaveText(/Claude/);
  });

  test('技能分类显示统计并能打开技能页', async ({ page }) => {
    await page.goto('/#/settings/skills');
    const dialog = page.getByRole('dialog', { name: '设置' });
    await expect(dialog.getByTestId('settings-skills-stats')).toContainText(/共 \d+ 个技能，\d+ 个已启用/);
    await expect(dialog.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /^技能/ })).toContainText(/\d+ 个技能 · \d+ 个已启用/);
    await dialog.getByRole('button', { name: '管理技能 →' }).click();
    await expect(page).toHaveURL(/#\/skills$/);
  });

  test('未知分类按 #/settings 处理，旧链接仍可用', async ({ page }) => {
    await page.goto('/#/settings/nope');
    await expect(page.getByRole('dialog').getByLabel('接口地址')).toBeVisible();
    await expect(page).toHaveURL(/#\/settings\/nope$/);
    await page.goto('/#/changes');
    await expect(page.getByRole('dialog', { name: '变更历史' })).toBeVisible();
  });
});

test.describe('手机', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('分类列表 → 详情 → 返回，焦点回到原来那一项', async ({ page }) => {
    await page.goto('/#/settings');
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible();
    // 详情页的弹窗名称是分类名，所以这里不按名称找弹窗。
    const dialog = page.getByRole('dialog');
    const list = dialog.getByTestId('settings-category-list');
    await expect(list).toBeVisible();
    await expect(dialog.getByLabel('接口地址')).toHaveCount(0);
    await expect(dialog.getByRole('navigation', { name: '工作区设置导航' })).toHaveCount(0);
    await screenshot(page, 'mobile-list');

    await list.getByRole('button', { name: '模型与 AI', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/model$/);
    await expect(dialog.getByLabel('接口地址')).toBeVisible();
    const back = dialog.getByRole('button', { name: '返回设置' });
    await expect(back).toBeFocused();
    await expect(back).toContainText('模型与 AI');
    const header = await dialog.locator('header').first().boundingBox();
    expect(header!.height).toBeLessThanOrEqual(60);
    await screenshot(page, 'mobile-model');

    await back.click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(dialog.getByRole('button', { name: '模型与 AI', exact: true })).toBeFocused();
  });

  test('直接打开分类地址，刷新后仍在详情页', async ({ page }) => {
    await page.goto('/#/settings/model');
    await expect(page.getByRole('dialog').getByLabel('接口地址')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('dialog').getByLabel('接口地址')).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button', { name: '返回设置' })).toContainText('模型与 AI');
  });

  test('回收站从列表进入，返回后回到列表', async ({ page }) => {
    await page.goto('/#/settings');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '回收站', exact: true }).click();
    await expect(page).toHaveURL(/#\/trash$/);
    await expect(page.getByRole('dialog', { name: '回收站' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '返回设置' }).click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByRole('dialog').getByTestId('settings-category-list')).toBeVisible();
  });

  test('AI 助手按钮不遮挡头部，最后一个控件能滚到按钮上方', async ({ page }) => {
    await page.goto('/#/settings/data');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '备份与恢复' })).toBeVisible();
    const fab = dialog.getByTestId('workspace-assistant-fab');
    await expect(fab).toBeVisible();
    await expect(fab).toHaveAccessibleName('AI 助手');
    const header = (await dialog.locator('header').first().boundingBox())!;
    const pill = (await fab.boundingBox())!;
    expect(pill.y).toBeGreaterThan(header.y + header.height);

    for (const category of ['model', 'local', 'ui']) {
      await page.goto(`/#/settings/${category}`);
      const scroller = page.getByTestId('workspace-modal-scroller');
      await expect(page.getByTestId('settings-category')).toHaveAttribute('data-category', category);
      await page.waitForTimeout(300);
      await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      const lastButton = page.getByTestId('settings-category').getByRole('button').last();
      const box = (await lastButton.boundingBox())!;
      const pillBox = (await page.getByTestId('workspace-assistant-fab').boundingBox())!;
      expect(box.y + box.height, category).toBeLessThanOrEqual(pillBox.y);
    }
  });

  test('底栏设置每项一行，没有上移下移按钮', async ({ page }) => {
    await page.goto('/#/settings/ui');
    const panel = page.getByTestId('mobile-navigation-settings');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: /^上移|^下移/ })).toHaveCount(0);
    const row = panel.getByTestId('mobile-navigation-row-inbox');
    const handle = (await row.getByRole('button', { name: '拖动收集箱' }).boundingBox())!;
    const name = (await row.getByText('收集箱', { exact: true }).boundingBox())!;
    const toggle = (await row.getByRole('switch').boundingBox())!;
    const center = (box: { y: number; height: number }) => box.y + box.height / 2;
    expect(Math.abs(center(handle) - center(name))).toBeLessThan(6);
    expect(Math.abs(center(toggle) - center(name))).toBeLessThan(6);
    expect((await row.boundingBox())!.height).toBeLessThan(64);
    await screenshot(page, 'mobile-ui');
  });
});
