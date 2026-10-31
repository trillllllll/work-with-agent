import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL!;
// Save as and the conversion source live in the document toolbar's "More" menu.
async function moreItem(page: Page, name: string) {
  await page.getByTestId('document-pane').getByRole('button', { name: '更多', exact: true }).click();
  return page.getByRole('menuitem', { name, exact: true });
}
test('另存为保留确切来源，转换副本可读，未保存正文禁止转换', async ({ page, request }) => {
  await resetE2eDatabase();
  const sourceText = '\ufeff# 原始文字\r\n\r\n正文 *星号*\r\n';
  const made = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: crypto.randomUUID(), title: '文本来源', format: 'text', content: sourceText } });
  expect(made.ok(), await made.text()).toBe(true); const source = (await made.json()).data;
  await page.goto(`/#/library?resource=${source.id}`);
  const saveAs = await moreItem(page, '另存为');
  await expect(saveAs).toBeEnabled();
  await saveAs.click();
  let dialog = page.getByRole('dialog', { name: '另存为', exact: true });
  await expect(dialog.getByTestId('document-conversion-loss')).toContainText('按 Markdown 语法解释');
  await dialog.getByRole('textbox', { name: '新文档标题', exact: true }).fill('转换后的 Markdown');
  const creating = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/library/resources');
  await dialog.getByRole('button', { name: '确认转换并创建', exact: true }).click();
  const creation = await creating; expect(creation.ok(), await creation.text()).toBe(true); const markdown = (await creation.json()).data;
  expect(markdown.id).not.toBe(source.id); expect(markdown.content).toBe(sourceText); expect(markdown.format).toBe('markdown');
  expect(markdown.conversionSource).toMatchObject({ resourceId: source.id, revision: 1, format: 'text', contentHash: source.contentHash });
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('转换后的 Markdown');
  await (await moreItem(page, '来源版本 1')).click();
  await expect(page.getByTestId('document-save-state')).toHaveText('第 1 版 · 只读');

  await page.goto(`/#/library?resource=${markdown.id}`);
  await (await moreItem(page, '另存为')).click();
  dialog = page.getByRole('dialog', { name: '另存为', exact: true });
  await expect(dialog.getByTestId('document-conversion-loss')).toContainText('按纯文本显示');
  await dialog.getByRole('textbox', { name: '新文档标题', exact: true }).fill('再次转为文本');
  const creatingText = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/library/resources');
  await dialog.getByRole('button', { name: '确认转换并创建', exact: true }).click();
  const plain = (await (await creatingText).json()).data;
  expect(plain.format).toBe('text'); expect(plain.content).toBe(sourceText);

  const richBody = { schemaVersion: 1, blocks: [
    { id: 'title', kind: 'heading', level: 1, text: [{ text: '旧版方案' }] },
    { id: 'file', kind: 'file', label: '原文证据', target: { resourceId: source.id, revision: 1 } },
    { id: 'table', kind: 'table', children: [{ id: 'row', kind: 'tableRow', children: [{ id: 'cell', kind: 'tableCell', colspan: 2, children: [{ id: 'p', kind: 'paragraph', text: [{ text: '旧版表格文字' }] }] }] }] },
  ] };
  const richResponse = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: crypto.randomUUID(), title: '富文档来源', format: 'richdoc-v1', content: richBody } });
  expect(richResponse.ok(), await richResponse.text()).toBe(true); const rich = (await richResponse.json()).data;
  const changedBody = structuredClone(richBody); changedBody.blocks[0].text = [{ text: '新版方案' }];
  expect((await request.put(`${api}/api/v1/library/resources/${rich.id}/content`, { data: { requestId: crypto.randomUUID(), expectedRevision: 1, format: 'richdoc-v1', content: changedBody } })).ok()).toBe(true);
  await page.goto(`/#/library?resource=${rich.id}&revision=1`);
  await (await moreItem(page, '另存为')).click();
  dialog = page.getByRole('dialog', { name: '另存为', exact: true });
  await expect(dialog.getByTestId('document-conversion-loss')).toContainText('表格转为制表符分隔');
  await dialog.getByRole('textbox', { name: '新文档标题', exact: true }).fill('旧版转换副本');
  const creatingRich = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/library/resources');
  await dialog.getByRole('button', { name: '确认转换并创建', exact: true }).click();
  const richCopyResponse = await creatingRich; expect(richCopyResponse.ok(), await richCopyResponse.text()).toBe(true); const richCopy = (await richCopyResponse.json()).data;
  expect(richCopy.conversionSource).toMatchObject({ resourceId: rich.id, revision: 1 });
  expect(richCopy.relativeReferences).toContainEqual(expect.objectContaining({ resourceId: source.id, revision: 1 }));
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('旧版转换副本');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.getByRole('heading', { name: '旧版方案', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '原文证据', exact: true })).toBeVisible();
  await expect(page.getByTestId('document-pane').locator('pre')).toContainText('旧版表格文字');
  const unchanged = (await (await request.get(`${api}/api/v1/library/resources/${rich.id}`)).json()).data;
  expect(unchanged.revision).toBe(2); expect(unchanged.content).toEqual(changedBody);
  await page.goto(`/#/library?resource=${rich.id}&revision=1`);
  await (await moreItem(page, '另存为')).click();
  dialog = page.getByRole('dialog', { name: '另存为', exact: true });
  await dialog.getByRole('combobox', { name: '目标格式', exact: true }).selectOption('text');
  await expect(dialog.getByTestId('document-conversion-loss')).toContainText('资源不再内嵌显示');
  await dialog.getByRole('textbox', { name: '新文档标题', exact: true }).fill('富文档转为文本');
  const creatingPlain = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/library/resources');
  await dialog.getByRole('button', { name: '确认转换并创建', exact: true }).click();
  const richPlainResponse = await creatingPlain; expect(richPlainResponse.ok(), await richPlainResponse.text()).toBe(true);
  const richPlain = (await richPlainResponse.json()).data;
  expect(richPlain.format).toBe('text'); expect(richPlain.content).toContain(`原文证据 (wwa-material:${source.id} · v1)`); expect(richPlain.content).toContain('旧版表格文字');
  expect(richPlain.conversionSource).toMatchObject({ resourceId: rich.id, revision: 1 });
  await page.goto(`/#/library?resource=${richCopy.id}`);
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await page.locator('textarea.document-source').fill('尚未保存的正文');
  await expect(await moreItem(page, '另存为')).toBeDisabled();
  await e2eDatabase.$disconnect();
});
