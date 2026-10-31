import { test, expect, type Page, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { cjkPdf } from './fixtures/cjk-pdf.js';
import { defaultEditBudgets } from '../client/src/components/documents/edit-budget.js';

const api = process.env.E2E_API_URL!;
test.beforeEach(async ({ page }) => { await resetE2eDatabase(); await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__: boolean }).__REACT_GRAB_DISABLED__ = true; }); });
test.afterAll(async () => { await e2eDatabase.$disconnect(); });
async function create(request: APIRequestContext, title: string, content = 'original') {
  const response = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: randomUUID(), title, format: 'text', content } });
  expect(response.ok(), await response.text()).toBe(true); return (await response.json()).data;
}
async function bodyOf(request: APIRequestContext, id: string) { return (await (await request.get(`${api}/api/v1/library/resources/${id}`)).json()).data; }
async function open(page: Page, id: string) { await page.goto(`/#/library?resource=${id}`); await expect(page.getByTestId('document-pane')).toBeVisible(); }

test('超预算文本以只读源码分页显示，翻页不截断或改写权威正文', async ({ page, request }) => {
  // Each repeated line is 20 UTF-8 bytes; enough lines to pass the soft text budget but stay within the hard one.
  const content = '\uFEFF# 源文件\r\n' + '😀 中文 `code`\r\n'.repeat(Math.ceil(defaultEditBudgets.text / 20) + 1_000) + 'END-OF-ORIGINAL';
  const resource = await create(request, '长文本.md', content);
  await open(page, resource.id);
  const reader = page.getByTestId('document-large-text-reading');
  await expect(reader).toBeVisible(); await expect(page.locator('textarea.document-source')).toHaveCount(0);
  await expect(reader.getByRole('button', { name: '仍要编辑', exact: true })).toBeVisible();
  await expect(reader.locator('pre')).toContainText('# 源文件');
  await reader.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(reader.getByText(/^第 2 \/ /)).toBeVisible();
  expect((await reader.locator('pre').textContent())!.length).toBeLessThanOrEqual(10_000);
  const unchanged = await bodyOf(request, resource.id);
  expect(unchanged.content).toBe(content); expect(unchanged.revision).toBe(1);
});

test('文本编辑中越过预算时保留输入框，组词结束后也不转只读并保存完整正文', async ({ page, request }) => {
  const resource = await create(request, '组词预算'); await open(page, resource.id);
  const field = page.locator('textarea.document-source');
  await field.dispatchEvent('compositionstart', { data: '中' });
  const content = 'a'.repeat(defaultEditBudgets.text) + '中文'; await field.fill(content);
  await expect(field).toBeVisible(); await expect(page.getByTestId('document-large-text-reading')).toHaveCount(0);
  await field.dispatchEvent('compositionend', { data: '中文' });
  await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun');
  await expect(field).toBeVisible(); await expect(page.getByTestId('document-large-text-reading')).toHaveCount(0);
  await expect(page.getByTestId('document-large-editing')).toBeVisible();
  expect((await bodyOf(request, resource.id)).content).toBe(content);
});

test('Markdown 分屏预览在输入停顿后刷新，组词期间不刷新', async ({ page, request }) => {
  const created = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: randomUUID(), title: '分屏预览', format: 'markdown', content: '# 初稿\n' } });
  expect(created.ok(), await created.text()).toBe(true);
  await open(page, (await created.json()).data.id); await page.getByRole('button', { name: '分屏', exact: true }).click();
  const preview = page.locator('.document-reading'); const field = page.locator('textarea.document-source');
  await expect(preview.getByRole('heading', { name: '初稿', exact: true })).toBeVisible();
  await field.fill('# 初稿\n\n## 第二节\n');
  await expect(preview.getByRole('heading', { name: '第二节', exact: true })).toBeVisible();
  await field.dispatchEvent('compositionstart', { data: '组' });
  await field.fill('# 初稿\n\n## 第二节\n\n## 组词中\n');
  await page.waitForTimeout(600);
  await expect(preview.getByRole('heading', { name: '组词中', exact: true })).toHaveCount(0);
  await field.dispatchEvent('compositionend', { data: '组词中' });
  await expect(preview.getByRole('heading', { name: '组词中', exact: true })).toBeVisible();
});

test('打开超预算文档先分页阅读，仍要编辑后可写入保存，超过硬上限只读', async ({ page, request }) => {
  const over = defaultEditBudgets.rich.blocks + 20;
  const blocks = Array.from({ length: over }, (_, index) => ({ id: `p-${index}`, kind: 'paragraph', text: [{ text: `段落 ${index}` }] }));
  const made = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: randomUUID(), title: '超预算富文档', format: 'richdoc-v1', schemaVersion: 1, content: { schemaVersion: 1, blocks } } });
  expect(made.ok(), await made.text()).toBe(true); const resource = (await made.json()).data;
  await open(page, resource.id);
  const reading = page.getByTestId('document-large-reading');
  await expect(reading).toBeVisible();
  await expect(page.locator('.document-prose').first()).toHaveAttribute('contenteditable', 'false');
  await reading.getByRole('button', { name: '仍要编辑', exact: true }).click();
  await expect(reading).toHaveCount(0);
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(editor.locator('p')).toHaveCount(over);
  await expect(page.getByTestId('document-large-editing')).toBeVisible();
  await editor.locator('p').last().click(); await page.keyboard.press('End'); await page.keyboard.type('续写');
  await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun', { timeout: 20_000 });
  const saved = await bodyOf(request, resource.id);
  expect(saved.content.blocks).toHaveLength(over); expect(saved.content.blocks[over - 1].text[0].text).toBe(`段落 ${over - 1}续写`);
  // A new page load decides again: the document opens as paged reading.
  await page.reload();
  await expect(page.getByTestId('document-large-reading')).toBeVisible();

  const huge = defaultEditBudgets.richHard.blocks + 10;
  const hard = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: randomUUID(), title: '超硬上限富文档', format: 'richdoc-v1', schemaVersion: 1, content: { schemaVersion: 1, blocks: Array.from({ length: huge }, (_, index) => ({ id: `h-${index}`, kind: 'paragraph', text: [{ text: `段 ${index}` }] })) } } });
  expect(hard.ok(), await hard.text()).toBe(true);
  await open(page, (await hard.json()).data.id);
  await expect(page.getByTestId('document-large-reading')).toBeVisible();
  await expect(page.getByRole('button', { name: '仍要编辑', exact: true })).toHaveCount(0);
});

test('旧文本附件的补充说明单独可读，不覆盖原件正文', async ({ page, request }) => {
  const resource = await create(request, '旧原件与说明', '原文件权威正文');
  await e2eDatabase.materialVersion.update({ where: { materialId_revision: { materialId: resource.id, revision: 1 } }, data: { supplementalContent: '旧版本的独立说明' } });
  await open(page, resource.id);
  await expect(page.locator('textarea.document-source')).toHaveValue('原文件权威正文');
  await expect(page.getByTestId('document-supplement')).toContainText('旧版本的独立说明');
  expect((await bodyOf(request, resource.id)).content).toBe('原文件权威正文');
});
async function upload(request: APIRequestContext, name: string, mime: string, bytes: Buffer) {
  const prepared = await request.post(`${api}/api/v1/library/uploads`, { data: { requestKey: randomUUID(), fileName: name, mimeType: mime, size: bytes.byteLength } }); expect(prepared.ok()).toBe(true);
  const id = (await prepared.json()).data.id;
  const transferred = await request.put(`${api}/api/v1/library/uploads/${id}/content`, { data: bytes, headers: { 'Content-Type': 'application/octet-stream' } }); expect(transferred.ok(), await transferred.text()).toBe(true);
  const committed = await request.post(`${api}/api/v1/commands`, { data: { requestId: randomUUID(), commands: [{ kind: 'material.create', input: { uploadId: id, topicId: null, folderId: null, taskIds: [], duplicateAction: 'create' } }] } }); expect(committed.ok(), await committed.text()).toBe(true);
  return (await committed.json()).data.results[0];
}

test('新建富文档可混合编辑并在刷新后恢复确切正文', async ({ page, request }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#/library'); await page.getByRole('button', { name: '新建文档', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true }); await expect(editor).toBeVisible();
  await editor.fill('支付方案的正文');
  await page.getByRole('button', { name: '插入表格', exact: true }).click();
  await expect(editor.locator('table')).toBeVisible();
  await editor.locator('table p').first().fill('金额');
  await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun');
  const resources = (await (await request.get(`${api}/api/v1/library/materials`)).json()).data.items;
  const resource = resources.find((item: { kind: string }) => item.kind === 'document'); expect(resource).toBeTruthy();
  const saved = await bodyOf(request, resource.id); expect(saved.format).toBe('richdoc-v1'); expect(JSON.stringify(saved.content)).toContain('支付方案'); expect(JSON.stringify(saved.content)).toContain('金额');
  await page.reload(); await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText('支付方案');
  await page.screenshot({ path: `/tmp/dovun-document-workspace-e2e/${info.project.name}-mixed.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test('正文保存与改名分离，切换文档及刷新不丢输入', async ({ page, request }) => {
  const first = await create(request, '文档一'); const second = await create(request, '文档二');
  await open(page, first.id); const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  // Text source uses its own accessible name.
  const source = page.locator('textarea.document-source'); await source.fill('本机输入，切换后仍在');
  await page.goto(`/#/library?resource=${second.id}`); await expect(source).toHaveValue('original');
  await page.goto(`/#/library?resource=${first.id}`); await expect(source).toHaveValue('本机输入，切换后仍在');
  await expect.poll(async () => (await bodyOf(request, first.id)).content).toBe('本机输入，切换后仍在');
  const before = await bodyOf(request, first.id);
  const title = page.locator('input.document-title'); await title.fill('改名后的文档'); await title.press('Enter');
  await expect.poll(async () => (await bodyOf(request, first.id)).title).toBe('改名后的文档');
  expect((await bodyOf(request, first.id)).revision).toBe(before.revision);
  await page.reload(); await expect(source).toHaveValue('本机输入，切换后仍在');
  void editor;
});

test('并发保存保留双方正文并提示冲突', async ({ page, request }) => {
  const resource = await create(request, '并发文档'); await open(page, resource.id);
  await page.locator('textarea.document-source').fill('本机尚未提交');
  const remote = await request.put(`${api}/api/v1/library/resources/${resource.id}/content`, { data: { requestId: randomUUID(), expectedRevision: 1, format: 'text', content: '另一端的新版本' } }); expect(remote.ok()).toBe(true);
  await expect(page.getByTestId('document-save-state')).toHaveText('存在冲突');
  await expect(page.locator('textarea.document-source')).toHaveValue('本机尚未提交');
  expect((await bodyOf(request, resource.id)).content).toBe('另一端的新版本');
});

test('上传中切换文档并刷新，附件只插回原文档', async ({ page, request }) => {
  const other = await create(request, '对照文档');
  await page.goto('/#/library'); await page.getByRole('button', { name: '新建文档', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true }); await editor.fill('等待附件也能继续写');
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/library/uploads/*/content', async (route) => { if (route.request().method() === 'PUT') await held; try { await route.continue(); } catch { /* Navigation may close an intercepted request; the upload retries from its durable draft. */ } });
  await page.locator('.document-editor-toolbar input[type=file]').setInputFiles({ name: 'evidence.zip', mimeType: 'application/zip', buffer: Buffer.from('retained attachment bytes') });
  await expect(page.locator('.document-resource-upload')).toBeVisible();
  const localUrl = page.url();
  await page.goto(`/#/library?resource=${other.id}`);
  await expect(page.locator('textarea.document-source')).toHaveValue('original');
  release(); await page.unroute('**/api/v1/library/uploads/*/content');
  await page.goto(localUrl);
  await expect(page.locator('.document-resource-file')).toContainText('evidence.zip');
  await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun');
  expect((await bodyOf(request, other.id)).content).toBe('original');
  await page.reload(); await expect(editor).toContainText('等待附件也能继续写'); await expect(page.locator('.document-resource-file')).toContainText('evidence.zip');
});

test('中文 PDF 使用本地 CMap 读取和搜索，不依赖外网', async ({ page, request }) => {
  const maps: string[] = []; const failures: string[] = [];
  page.on('response', (response) => { if (response.url().includes('/pdfjs/') && response.url().endsWith('.bcmap')) { maps.push(response.url()); if (!response.ok()) failures.push(response.url()); } });
  await page.route('https://**/*', (route) => route.abort());
  const file = await upload(request, '中文.pdf', 'application/pdf', cjkPdf());
  await open(page, file.id); await page.getByRole('button', { name: '本页文字', exact: true }).click();
  await expect(page.locator('.document-pdf-text')).toHaveText('中文');
  await page.getByRole('textbox', { name: '搜索文本', exact: true }).fill('中文'); await page.getByRole('button', { name: '搜索文本', exact: true }).click();
  await expect(page.locator('.document-pdf-reader .document-reader-toolbar').nth(1).getByRole('button', { name: '1', exact: true })).toBeVisible();
  expect(maps.some((url) => url.endsWith('/GB-EUC-H.bcmap'))).toBe(true);
  expect(maps.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
  expect(failures).toEqual([]);
});

test('PDF 搜索和页码、Excel 工作表与定位都可使用', async ({ page, request }, info) => {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([400, 500]).drawText('Payment reference first page', { x: 30, y: 450, font, size: 16 });
  pdf.addPage([400, 500]).drawText('Second page searchable needle', { x: 30, y: 450, font, size: 16 });
  const file = await upload(request, 'reference.pdf', 'application/pdf', Buffer.from(await pdf.save()));
  await open(page, file.id); await expect(page.locator('.document-pdf-canvas canvas')).toBeVisible();
  await page.getByRole('textbox', { name: '搜索文本', exact: true }).fill('needle'); await page.getByRole('button', { name: '搜索文本', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '页码', exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: '本页文字', exact: true }).click(); await expect(page.locator('.document-pdf-text')).toContainText('needle');
  await page.screenshot({ path: `/tmp/dovun-document-workspace-e2e/${info.project.name}-pdf.png`, fullPage: true });
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Sheet One').getCell('A1').value = 'First'; const second = workbook.addWorksheet('Sheet Two'); second.getCell('B120').value = 'Located cell';
  const sheet = await upload(request, 'table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from(await workbook.xlsx.writeBuffer()));
  await open(page, sheet.id); await page.getByRole('combobox', { name: '工作表', exact: true }).selectOption({ label: 'Sheet Two' });
  await page.getByRole('textbox', { name: '单元格或范围（如 A1:B10）', exact: true }).fill('B120'); await page.getByRole('button', { name: '定位', exact: true }).click();
  await expect(page.locator('.document-workbook-grid')).toContainText('Located cell');
});

test('复制混合正文保留附件并分配新的块身份', async ({ page, request }) => {
  const attachment = await upload(request, 'shared.bin', 'application/octet-stream', Buffer.from('versioned bytes'));
  const created = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: randomUUID(), title: '复制附件', format: 'richdoc-v1', schemaVersion: 1, content: { schemaVersion: 1, blocks: [
    { id: 'intro', kind: 'paragraph', text: [{ text: '混合正文' }] }, { id: 'original-file', kind: 'file', target: { resourceId: attachment.id, revision: 1 }, label: 'shared.bin' }, { id: 'tail', kind: 'paragraph', text: [] },
  ] } } }); expect(created.ok()).toBe(true); const resource = (await created.json()).data;
  await open(page, resource.id); const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await expect(editor.locator('.document-resource-file')).toContainText('shared.bin');
  await editor.locator('p').first().click(); await editor.press('ControlOrMeta+a');
  const copied = await editor.evaluate((node) => { const clipboard = new DataTransfer(); node.dispatchEvent(new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true })); return { html: clipboard.getData('text/html'), text: clipboard.getData('text/plain'), selection: window.getSelection()?.toString() }; });
  expect(copied.html, JSON.stringify(copied)).toContain('data-document-resource="file"');
  await editor.press('ArrowRight');
  // ArrowRight on a full selection is resolved by the browser and reaches ProseMirror through an asynchronous
  // selectionchange; pressing Enter before that would replace the whole document.
  await expect.poll(() => editor.evaluate((node) => (node as HTMLElement & { editor: { state: { selection: { empty: boolean } } } }).editor.state.selection.empty)).toBe(true);
  await editor.press('Enter');
  await editor.evaluate((node, data) => { const clipboard = new DataTransfer(); clipboard.setData('text/html', data.html); clipboard.setData('text/plain', data.text); node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true })); }, copied);
  await expect(editor.locator('.document-resource-file')).toHaveCount(2);
  const ids = await editor.locator('.document-resource-file').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.blockId));
  expect(new Set(ids).size).toBe(2);
  await expect.poll(async () => (await bodyOf(request, resource.id)).references.length).toBe(2);
});

test('输入后立即撤销并重做不会等待草稿节流', async ({ page }) => {
  await page.goto('/#/library'); await page.getByRole('button', { name: '新建文档', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.pressSequentially('instant'); await editor.press('ControlOrMeta+z');
  await expect(editor).not.toContainText('instant');
  await editor.press('ControlOrMeta+Shift+z'); await expect(editor).toContainText('instant');
});

test('Word 正文、表格和图片通过同一个只读入口阅读', async ({ page, request }) => {
  const archive = new JSZip();
  archive.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  archive.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  archive.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>');
  archive.file('word/media/image1.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+c0ncAAAAASUVORK5CYII=', 'base64'));
  archive.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>Word structure preview</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="image1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>');
  const resource = await upload(request, 'reference.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', await archive.generateAsync({ type: 'nodebuffer' }));
  await open(page, resource.id); const frame = page.frameLocator('.document-office-frame');
  await expect(frame.locator('body')).toContainText('Word structure preview'); await expect(frame.locator('table')).toContainText('Table cell');
  await expect(frame.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(page.locator('.document-office-frame')).toHaveAttribute('sandbox', '');
});

test('完整文档包离线含原件，重新导入分配新身份和引用', async ({ page, request }) => {
  const fileBytes = Buffer.from('exact portable attachment');
  const attachment = await upload(request, 'portable.bin', 'application/octet-stream', fileBytes);
  const created = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: randomUUID(), title: '可迁移文档', format: 'richdoc-v1', schemaVersion: 1, content: { schemaVersion: 1, blocks: [
    { id: 'first', kind: 'paragraph', text: [{ text: '可离开应用阅读的正文' }] }, { id: 'file', kind: 'file', target: { resourceId: attachment.id, revision: 1 }, label: 'portable.bin' },
  ] } } }); expect(created.ok()).toBe(true); const resource = (await created.json()).data;
  await open(page, resource.id); await page.getByRole('button', { name: '导出', exact: true }).click();
  const downloading = page.waitForEvent('download'); await page.getByRole('menuitem', { name: '文档包（含 Markdown / HTML）', exact: true }).click();
  const download = await Promise.race([downloading, page.locator('[data-sonner-toast]').first().waitFor({ state: 'visible', timeout: 20_000 }).then(async () => { throw new Error(`Export feedback: ${await page.locator('[data-sonner-toast]').first().textContent()}`); })]); const path = await download.path(); expect(path).toBeTruthy();
  const zip = await JSZip.loadAsync(await readFile(path!)); const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  expect(manifest.resources).toHaveLength(2); const importedFile = manifest.resources.find((item: { format: string }) => item.format === 'binary');
  expect(await zip.file(importedFile.originalPath)!.async('nodebuffer')).toEqual(fileBytes);
  expect(await zip.file(`readable/${manifest.root}.md`)!.async('string')).toContain('../');
  await page.getByRole('button', { name: '返回文件列表', exact: true }).click();
  await page.locator('input[type=file][accept=".zip"]').setInputFiles(path!);
  await expect(page.getByTestId('document-pane')).toBeVisible(); await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText('可离开应用阅读的正文');
  await expect.poll(async () => (await (await request.get(`${api}/api/v1/library/materials?q=${encodeURIComponent('可迁移文档')}`)).json()).data.items.filter((item: { kind: string }) => item.kind === 'document').length).toBe(2);
  const matches = (await (await request.get(`${api}/api/v1/library/materials?q=${encodeURIComponent('可迁移文档')}`)).json()).data.items;
  const copy = await bodyOf(request, matches.find((item: { id: string; kind: string }) => item.id !== resource.id && item.kind === 'document').id);
  expect(copy.content.blocks[1].target.resourceId).not.toBe(attachment.id);
  const copied = await request.get(`${api}/api/v1/library/resources/${copy.content.blocks[1].target.resourceId}/versions/1/original`); expect(await copied.body()).toEqual(fileBytes);
  expect((await bodyOf(request, resource.id)).revision).toBe(1);
});

test('两个独立浏览器会话在同一隔离工作区续写并收到新版本', async ({ page, request, browser }) => {
  const resource = await create(request, '跨浏览器续写'); await open(page, resource.id);
  const secondContext = await browser.newContext({ storageState: await page.context().storageState(), baseURL: process.env.E2E_UI_URL, locale: 'zh-CN', viewport: { width: 390, height: 844 } });
  try {
    const other = await secondContext.newPage(); await other.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__: boolean }).__REACT_GRAB_DISABLED__ = true; });
    await open(other, resource.id); await other.locator('textarea.document-source').fill('另一浏览器写入');
    await expect(other.getByTestId('document-save-state')).toHaveText('已保存到 Dovun');
    await expect(page.locator('textarea.document-source')).toHaveValue('另一浏览器写入', { timeout: 15_000 });
    await page.locator('textarea.document-source').fill('电脑视图接着写'); await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun');
    await expect(other.locator('textarea.document-source')).toHaveValue('电脑视图接着写', { timeout: 15_000 });
    expect((await bodyOf(request, resource.id)).revision).toBe(3);
  } finally { await secondContext.close(); }
});
