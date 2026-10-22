import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

async function openComposer(page: Page, kind: '文本' | '链接') {
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('menuitem', { name: kind, exact: true }).click();
  return page.getByRole('dialog', { name: `添加${kind}`, exact: true });
}

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    localStorage.setItem('agent-studio.theme', 'light');
    (window as any).__REACT_GRAB_DISABLED__ = true;
  });
  await page.goto('/#/library');
});
test.afterAll(() => e2eDatabase.$disconnect());

test('text preview renders tables, preserves the draft and cancels without saving', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const composer = await openComposer(page, '文本');
  await expect(composer.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await composer.getByRole('button', { name: '预览', exact: true }).click();
  await expect(composer.getByText('正文还是空的', { exact: true })).toBeVisible();
  await composer.getByRole('button', { name: '编辑', exact: true }).click();
  const markdown = '# 资料草稿\n\n| 项目 | 状态 |\n| --- | --- |\n| 弹窗 | 待确认 |\n\n' + '很长的正文，需要在输入区内部滚动。\n\n'.repeat(100);
  await composer.getByRole('textbox', { name: '文本标题', exact: true }).fill('预览后取消');
  const body = composer.getByRole('textbox', { name: '文本内容', exact: true });
  await body.fill(markdown);
  const editBox = (await composer.boundingBox())!;
  expect(await body.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await composer.getByRole('button', { name: '预览', exact: true }).click();
  await expect(composer.getByRole('table')).toContainText('待确认');
  expect((await composer.boundingBox())!.height).toBeCloseTo(editBox.height, 0);
  await page.keyboard.press('Escape');
  await expect(composer).toBeVisible();
  const overlay = page.locator('[data-library-composer-overlay]');
  await expect(overlay).toBeVisible();
  await overlay.click({ position: { x: 4, y: 4 } });
  await expect(composer).toBeVisible();
  await page.screenshot({ path: `/tmp/wwa-composer-${testInfo.project.name}-preview.png`, animations: 'disabled' });
  await composer.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(body).toHaveValue(markdown);
  await composer.getByRole('button', { name: '取消', exact: true }).click();
  await expect(composer).toHaveCount(0);
  expect(await e2eDatabase.material.count()).toBe(0);
  const reopened = await openComposer(page, '文本');
  await reopened.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(reopened).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('link uses one line and both link and empty text retain the existing save contract', async ({ page }) => {
  const link = await openComposer(page, '链接');
  await expect(link.getByRole('button', { name: '预览', exact: true })).toHaveCount(0);
  const address = link.getByRole('textbox', { name: '链接地址', exact: true });
  expect(await address.evaluate((node) => node.tagName)).toBe('INPUT');
  await link.getByRole('textbox', { name: '链接标题', exact: true }).fill('   ');
  await expect(link.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await link.getByRole('textbox', { name: '链接标题', exact: true }).fill('  参考链接  ');
  await address.fill('  https://example.com/reference  ');
  await link.getByRole('button', { name: '保存', exact: true }).click();
  await expect(link).toHaveCount(0);
  expect(await e2eDatabase.material.findFirst({ where: { title: '参考链接' }, include: { versions: true } })).toMatchObject({ kind: 'link', uri: 'https://example.com/reference', versions: [{ content: '' }] });
  const text = await openComposer(page, '文本');
  await text.getByRole('textbox', { name: '文本标题', exact: true }).fill('空正文');
  await text.getByRole('button', { name: '保存', exact: true }).click();
  await expect(text).toHaveCount(0);
  expect(await e2eDatabase.material.findFirst({ where: { title: '空正文' }, include: { versions: true } })).toMatchObject({ kind: 'text', versions: [{ content: '' }] });
});

test('composer fits the viewport and leaves the desktop assistant usable in both themes', async ({ page, isMobile }, testInfo) => {
  const composer = await openComposer(page, '文本');
  await composer.getByRole('textbox', { name: '文本标题', exact: true }).fill('保留中的草稿');
  for (const width of isMobile ? [390, 360] : [1440, 1024]) {
    await page.setViewportSize({ width, height: isMobile ? 640 : 900 });
    await expect.poll(async () => {
      const box = (await composer.boundingBox())!;
      return Math.abs(box.x + box.width / 2 - width / 2) < 1
        && box.x >= 23 && box.y >= 23
        && box.x + box.width <= width - 23
        && box.y + box.height <= page.viewportSize()!.height - 23;
    }).toBe(true);
    const box = (await composer.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(20);
    expect(box.y).toBeGreaterThanOrEqual(20);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 20);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height - 20);
    await composer.getByRole('button', { name: 'AI 助手', exact: true }).click();
    const assistant = page.getByTestId('ai-assistant');
    const input = assistant.getByRole('textbox', { name: '向 AI 提问', exact: true });
    await input.fill('助手可以输入');
    await expect(input).toBeFocused();
    if (isMobile) await expect(composer).toBeHidden();
    else {
      await expect.poll(async () => {
        const box = (await composer.boundingBox())!;
        return box.x + box.width - (await assistant.boundingBox())!.x;
      }).toBeLessThanOrEqual(0);
      const beside = (await composer.boundingBox())!;
      const assistantBox = (await assistant.boundingBox())!;
      expect(beside.x).toBeGreaterThanOrEqual(0);
      expect(beside.x + beside.width).toBeLessThanOrEqual(assistantBox.x);
      const backdrop = (await page.locator('[data-library-composer-overlay]').boundingBox())!;
      expect(backdrop.x + backdrop.width).toBeLessThanOrEqual(assistantBox.x);
      await page.screenshot({ path: `/tmp/wwa-composer-${width}-assistant-light.png`, animations: 'disabled' });
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await expect(composer).toHaveCSS('background-color', 'rgba(31, 31, 31, 0.97)');
      await page.screenshot({ path: `/tmp/wwa-composer-${width}-assistant-dark.png`, animations: 'disabled' });
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    }
    await assistant.getByRole('button', { name: isMobile ? '返回当前页面' : '关闭聊天', exact: true }).click();
    await expect(assistant).toBeHidden();
    await expect(composer.getByRole('textbox', { name: '文本标题', exact: true })).toHaveValue('保留中的草稿');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: `/tmp/wwa-composer-${testInfo.project.name}-edit.png`, animations: 'disabled' });
});
