import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

// Text materials are written as documents now (see document-*.spec.ts); only links keep a composer.
async function openLinkComposer(page: Page) {
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('menuitem', { name: '链接', exact: true }).click();
  return page.getByRole('dialog', { name: '添加链接', exact: true });
}

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    localStorage.setItem('dovun.theme', 'light');
    (window as any).__REACT_GRAB_DISABLED__ = true;
  });
  await page.goto('/#/library');
});
test.afterAll(() => e2eDatabase.$disconnect());

test('link uses one line and keeps the existing save contract', async ({ page }) => {
  const link = await openLinkComposer(page);
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
});
