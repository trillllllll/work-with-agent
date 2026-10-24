import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL!;
test.beforeEach(() => resetE2eDatabase());
test.afterAll(() => e2eDatabase.$disconnect());

test('reply style saves without a model, survives reload, and can be cleared or restored', async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#/settings/model');
  const field = page.getByLabel('风格要求', { exact: true });
  await expect(field).toHaveValue('结论先行，多用短句。');
  await field.fill('先给结论。\n每句只说一件事。');
  await page.getByRole('button', { name: '保存回复风格', exact: true }).click();
  await expect(page.getByText('回复风格已保存', { exact: true })).toBeVisible();
  expect((await (await request.get(`${api}/api/settings`)).json()).data.apiKeyConfigured).toBe(false);
  await page.reload();
  await expect(field).toHaveValue('先给结论。\n每句只说一件事。');
  // A background refresh must not replace an unsaved edit.
  await field.fill('尚未保存的编辑');
  await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
  await expect(field).toHaveValue('尚未保存的编辑');
  await field.fill('');
  await page.getByRole('button', { name: '保存回复风格', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`${api}/api/settings/reply-style`)).json()).data.replyStyle).toBe('');
  await page.reload();
  await expect(field).toHaveValue('');
  await page.getByRole('region', { name: '回复风格', exact: true }).getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(field).toHaveValue('结论先行，多用短句。');
  await page.getByRole('button', { name: '保存回复风格', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`${api}/api/settings/reply-style`)).json()).data.replyStyle).toBe('结论先行，多用短句。');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.className = theme; }, theme);
    await field.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/dovun-reply-style-${info.project.name}-${theme}.png` });
  }
  await page.evaluate(() => localStorage.setItem('dovun.language', 'en'));
  await page.reload();
  await expect(page.getByLabel('Style instructions', { exact: true })).toHaveValue('结论先行，多用短句。');
  expect(errors).toEqual([]);
});
