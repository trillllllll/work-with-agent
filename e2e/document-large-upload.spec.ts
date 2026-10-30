import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { randomUUID } from 'node:crypto';
import { defaultEditBudgets } from '../client/src/components/documents/edit-budget.js';
const api = process.env.E2E_API_URL!;
test.beforeEach(async ({ page }) => { await resetE2eDatabase(); await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__: boolean }).__REACT_GRAB_DISABLED__ = true; }); });
test.afterAll(async () => { await e2eDatabase.$disconnect(); });
test.use({ trace: 'off' });
test('100 MiB 附件上传中继续写作，刷新后正文和占位可恢复', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'chromium', '大字节恢复在桌面运行一次；手机/WebKit覆盖普通附件恢复。'); test.setTimeout(120_000);
  const directory = await mkdtemp('/tmp/dovun-large-attachment-'); const file = join(directory, 'large.bin');
  await writeFile(file, Buffer.alloc(100 * 1024 * 1024, 0x61));
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/library/uploads', async (route) => { if (route.request().method() === 'POST') await held; try { await route.continue(); } catch { /* The first request is intentionally interrupted by refresh. */ } });
  try {
    await page.goto('/#/library'); await page.getByRole('button', { name: '新建文档', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '文档正文', exact: true }); await editor.fill('大附件前的正文');
    const started = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/uploads'), { timeout: 40_000 });
    await page.locator('.document-editor-toolbar input[type=file]').setInputFiles(file); await started;
    const prevented = await editor.locator('p').last().evaluate((node) => {
      const range = document.createRange(); range.selectNodeContents(node); range.collapse(false); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      (node.closest('[contenteditable]') as HTMLElement).focus(); document.execCommand('insertText', false, '上传期间继续写');
      const leaving = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leaving); return leaving.defaultPrevented;
    });
    expect(prevented).toBe(true);
    await expect(page.getByTestId('document-save-state')).toHaveText('正文已存本机，等待附件上传');
    await page.reload(); await expect(editor).toContainText('上传期间继续写'); await expect(page.locator('.document-resource-upload')).toContainText('large.bin');
    release(); await page.unroute('**/api/v1/library/uploads');
    await expect(page.locator('.document-resource-file')).toContainText('large.bin', { timeout: 60_000 });
    await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun', { timeout: 30_000 });
    // Inline attachments are managed resources, intentionally absent from the root file list.
    const download = page.locator('.document-resource-file a');
    await expect(download).toHaveAttribute('href', /\/resources\/[^/]+\/versions\/1\/original$/);
    const path = await download.getAttribute('href');
    const response = await request.head(`${api}${path}`); expect(response.headers()['content-length']).toBe(String(100 * 1024 * 1024));
  } finally { release(); await rm(directory, { recursive: true, force: true }); }
});

test('无法转换的最新富编辑器状态刷新后仍可从本机恢复包取回', async ({ page }) => {
  await page.goto('/#/library'); await page.getByRole('button', { name: '新建文档', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.fill('最后有效正文'); await page.getByRole('button', { name: '立即保存', exact: true }).click();
  await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun');
  const prevented = await editor.evaluate((node) => {
    (node as HTMLElement).focus();
    const range = document.createRange(); range.selectNodeContents(node); range.collapse(false); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    // Tiptap exposes its real editor on the DOM for integration tests. Exercise a valid
    // editor tree that exceeds the product schema depth without mocking conversion.
    let content: unknown = { type: 'paragraph', content: [{ type: 'text', text: '不能丢失的最新原始输入' }] };
    for (let depth = 0; depth < 70; depth++) content = { type: 'blockquote', content: [content] };
    const instance = (node as HTMLElement & { editor: { commands: { insertContent: (value: unknown) => boolean } } }).editor;
    instance.commands.insertContent(content);
    const leaving = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leaving); return leaving.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(page.getByRole('alert').filter({ hasText: 'original editor data' })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('dovun-document-drafts', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const rows = await new Promise<unknown[]>((resolve, reject) => { const transaction = database.transaction('drafts'); const read = transaction.objectStore('drafts').getAll(); transaction.oncomplete = () => resolve(read.result); transaction.onerror = () => reject(transaction.error); });
    database.close(); return JSON.stringify(rows);
  })).toContain('不能丢失的最新原始输入');
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'original editor data' })).toBeVisible();
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出本机恢复包', exact: true }).click();
  const download = await downloading; const path = await download.path(); expect(path).toBeTruthy();
  const zip = await JSZip.loadAsync(await readFile(path!));
  const recovered = JSON.parse(await zip.file('editor-recovery/0.json')!.async('string'));
  expect(JSON.stringify(recovered.editorJson)).toContain('不能丢失的最新原始输入');
  expect(await zip.file('content.json')!.async('string')).toContain('最后有效正文');
});

test('另一视图在前方插入和删除块时保留独立光标', async ({ page, request }, info) => {
  test.skip(info.project.name === 'mobile', '窄屏不显示并排视图。');
  const content = { schemaVersion: 1, blocks: [{ id: 'first', kind: 'paragraph', text: [{ text: 'first paragraph' }] }, { id: 'target', kind: 'paragraph', text: [{ text: 'target paragraph' }] }] };
  const response = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: randomUUID(), title: '独立光标', format: 'richdoc-v1', schemaVersion: 1, content } });
  expect(response.ok(), await response.text()).toBe(true); const resource = (await response.json()).data;
  await page.goto(`/#/library?resource=${resource.id}`);
  await page.getByRole('combobox', { name: '并排对照', exact: true }).selectOption({ label: '独立光标' });
  const editors = page.getByRole('textbox', { name: '文档正文', exact: true }); await expect(editors).toHaveCount(2);
  const original = await editors.nth(1).evaluate((node) => {
    const editor = (node as HTMLElement & { editor: any }).editor;
    const position = editor.state.doc.child(0).nodeSize + 4; editor.commands.setTextSelection(position); return position;
  });
  await editors.nth(0).evaluate((node) => { (node as HTMLElement & { editor: any }).editor.commands.insertContentAt(0, { type: 'paragraph', attrs: { blockId: 'new-prefix' }, content: [{ type: 'text', text: 'prefix' }] }); });
  await expect(editors.nth(1)).toContainText('prefix');
  await expect.poll(() => editors.nth(1).evaluate((node) => { const selection = (node as HTMLElement & { editor: any }).editor.state.selection; return { from: selection.from, blockId: selection.$from.parent.attrs.blockId }; })).toEqual({ from: original + 8, blockId: 'target' });
  await editors.nth(0).evaluate((node) => { const editor = (node as HTMLElement & { editor: any }).editor; editor.commands.deleteRange({ from: 0, to: editor.state.doc.child(0).nodeSize }); });
  await expect.poll(() => editors.nth(1).evaluate((node) => { const selection = (node as HTMLElement & { editor: any }).editor.state.selection; return { from: selection.from, blockId: selection.$from.parent.attrs.blockId }; })).toEqual({ from: original, blockId: 'target' });
});

test('富文档编辑中越过块预算时保持可编辑，组词结束后也不转只读并完整保存', async ({ page, request }) => {
  const limit = defaultEditBudgets.rich.blocks;
  const content = { schemaVersion: 1, blocks: Array.from({ length: limit - 1 }, (_, index) => ({ id: `p-${index}`, kind: 'paragraph', text: [{ text: `段落 ${index}` }] })) };
  const response = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: randomUUID(), title: '富文档组词预算', format: 'richdoc-v1', schemaVersion: 1, content } });
  expect(response.ok(), await response.text()).toBe(true); const resource = (await response.json()).data;
  await page.goto(`/#/library?resource=${resource.id}`);
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true }); await expect(editor).toBeVisible();
  await editor.dispatchEvent('compositionstart', { data: '中' });
  await editor.evaluate((node) => {
    const editor = (node as HTMLElement & { editor: any }).editor;
    editor.commands.insertContentAt(editor.state.doc.content.size, [
      { type: 'paragraph', attrs: { blockId: 'ime-first' }, content: [{ type: 'text', text: '中文组词' }] },
      { type: 'paragraph', attrs: { blockId: 'ime-last' }, content: [{ type: 'text', text: '最后的内容' }] },
    ]);
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
  });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(page.getByTestId('document-large-reading')).toHaveCount(0);
  await page.getByRole('button', { name: '立即保存', exact: true }).click();
  expect((await (await request.get(`${api}/api/v1/library/resources/${resource.id}`)).json()).data.revision).toBe(1);
  await editor.dispatchEvent('compositionend', { data: '中文组词' });
  await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun');
  // Growing past the budget never takes the open editor away; a quiet hint explains possible slowness.
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(page.getByTestId('document-large-reading')).toHaveCount(0);
  await expect(page.getByTestId('document-large-editing')).toBeVisible();
  await editor.locator('p').last().click(); await page.keyboard.press('End'); await page.keyboard.type('，继续写');
  await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun');
  const saved = (await (await request.get(`${api}/api/v1/library/resources/${resource.id}`)).json()).data;
  expect(saved.content.blocks).toHaveLength(limit + 1); expect(JSON.stringify(saved.content)).toContain('最后的内容，继续写');
});
