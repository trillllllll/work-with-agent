import { test, expect, type Page, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
import { randomUUID } from 'node:crypto';

// Editing behaviour of the document workspace: keyboard, attributes, undo, creation, paste and budgets.
const api = process.env.E2E_API_URL!;
test.beforeEach(async ({ page }) => { await resetE2eDatabase(); await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__: boolean }).__REACT_GRAB_DISABLED__ = true; }); });
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

type Block = Record<string, unknown>;
const paragraph = (id: string, text: string): Block => ({ id, kind: 'paragraph', text: text ? [{ text }] : [] });
async function createText(request: APIRequestContext, title: string, content: string, format: 'text' | 'markdown' = 'text') {
  const response = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: randomUUID(), title, format, content } });
  expect(response.ok(), await response.text()).toBe(true); return (await response.json()).data as { id: string; revision: number };
}
async function createRich(request: APIRequestContext, title: string, blocks: Block[]) {
  const response = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: randomUUID(), title, format: 'richdoc-v1', schemaVersion: 1, content: { schemaVersion: 1, blocks } } });
  expect(response.ok(), await response.text()).toBe(true); return (await response.json()).data as { id: string; revision: number };
}
async function bodyOf(request: APIRequestContext, id: string) { return (await (await request.get(`${api}/api/v1/library/resources/${id}`)).json()).data; }
async function open(page: Page, id: string) { await page.goto(`/#/library?resource=${id}`); await expect(page.getByTestId('document-pane')).toBeVisible(); }
const richEditor = (page: Page) => page.getByRole('textbox', { name: '文档正文', exact: true });
/** Closing is asynchronous (local flush first), so "stays open" must be observed after that window. */
async function expectStillOpen(page: Page) { await page.waitForTimeout(500); await expect(page.getByTestId('document-pane')).toBeVisible(); }

test('在正文、标题和源码里按 Esc 不关闭文档，焦点离开后 Esc 仍可关闭', async ({ page, request }) => {
  const rich = await createRich(request, 'Esc 富文档', [paragraph('first', '已有正文')]);
  await open(page, rich.id);
  const editor = richEditor(page);
  await editor.locator('p').first().click(); await page.keyboard.press('End'); await page.keyboard.type('，继续写');
  await page.keyboard.press('Escape');
  await expectStillOpen(page);
  await expect(editor).toContainText('已有正文，继续写');

  const title = page.getByRole('textbox', { name: '文档标题', exact: true });
  await title.click(); await page.keyboard.press('Escape');
  await expectStillOpen(page);

  // An IME candidate list consumes Escape; the page must not treat it as "close".
  await page.locator('.document-meta').click();
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })));
  await expectStillOpen(page);

  const markdown = await createText(request, 'Esc 源码.md', '# 标题\n\n正文', 'markdown');
  await open(page, markdown.id);
  const source = page.locator('textarea.document-source');
  await source.click(); await page.keyboard.press('Escape');
  await expectStillOpen(page);
  await expect(source).toHaveValue('# 标题\n\n正文');

  // Focus outside every editing surface keeps the established Escape-to-close behaviour.
  await page.locator('.document-meta').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('document-pane')).toBeHidden();
  await expect.poll(async () => JSON.stringify((await bodyOf(request, rich.id)).content)).toContain('已有正文，继续写');
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const firstBlock = (content: { blocks: Array<Record<string, unknown>> }, kind: string) => content.blocks.find((block) => block.kind === kind) as Record<string, unknown> | undefined;

test('快速输入图片说明和代码语言不丢字，改说明时不重新读取图片', async ({ page, request }) => {
  const doc = await createRich(request, '属性输入', [paragraph('first', '正文')]);
  await open(page, doc.id);
  const editor = richEditor(page);
  await editor.locator('p').first().click(); await page.keyboard.press('End');
  await page.locator('.document-editor-toolbar input[type=file]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png });
  await expect(editor.locator('figure img')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun', { timeout: 30_000 });
  const image = firstBlock((await bodyOf(request, doc.id)).content, 'image')!;
  const imageId = (image.target as { resourceId: string }).resourceId;
  const reads: string[] = [];
  page.on('request', (entry) => {
    const url = new URL(entry.url());
    if (url.pathname.includes(`/resources/${imageId}/versions/`) || url.pathname.endsWith(`/resources/${imageId}`) && url.searchParams.has('revision')) reads.push(entry.url());
  });
  await editor.locator('figure').click();
  const caption = page.getByRole('textbox', { name: '图片说明', exact: true });
  await expect(caption).toBeVisible();
  await caption.pressSequentially('截图说明文字', { delay: 50 });
  await expect(caption).toHaveValue('截图说明文字');
  await expect(editor.locator('figure figcaption')).toHaveText('截图说明文字');
  await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun', { timeout: 20_000 });
  expect(firstBlock((await bodyOf(request, doc.id)).content, 'image')!.caption).toBe('截图说明文字');
  expect(reads).toEqual([]);
  await expect(editor.locator('figure img')).toBeVisible();

  await editor.locator('p').first().click(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await page.getByRole('toolbar', { name: '格式工具', exact: true }).getByRole('button', { name: '代码块', exact: true }).click();
  const language = page.getByRole('textbox', { name: '代码语言', exact: true });
  await expect(language).toBeVisible();
  await language.pressSequentially('typescript', { delay: 50 });
  await expect(language).toHaveValue('typescript');
  await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun', { timeout: 20_000 });
  expect(firstBlock((await bodyOf(request, doc.id)).content, 'codeBlock')!.language).toBe('typescript');
});
