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

test('Markdown 源码撤销后光标留在改动处，接着输入落在原位置', async ({ page, request }) => {
  const lines = Array.from({ length: 30 }, (_, index) => `第${index + 1}行`);
  const doc = await createText(request, '撤销光标.md', lines.join('\n'), 'markdown');
  await open(page, doc.id);
  const source = page.locator('textarea.document-source');
  const lineEnd = lines[0].length;
  await source.evaluate((field: HTMLTextAreaElement, offset) => { field.focus(); field.setSelectionRange(offset, offset); }, lineEnd);
  await page.keyboard.type('ABC', { delay: 60 });
  await page.waitForTimeout(1_000);
  await page.keyboard.type('DEF', { delay: 60 });
  await page.waitForTimeout(300);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(source).toHaveValue([`${lines[0]}ABC`, ...lines.slice(1)].join('\n'));
  expect(await source.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd])).toEqual([lineEnd + 3, lineEnd + 3]);
  await page.keyboard.type('X');
  await expect(source).toHaveValue([`${lines[0]}ABCX`, ...lines.slice(1)].join('\n'));
});

test('富文档撤销后光标回到改动处，即使撤销前光标已移到别处', async ({ page, request }) => {
  const doc = await createRich(request, '富文档撤销光标', [paragraph('first', '第一段'), paragraph('second', '第二段')]);
  await open(page, doc.id);
  const editor = richEditor(page);
  await editor.locator('p').first().click(); await page.keyboard.press('End');
  await page.keyboard.type('ABC', { delay: 60 });
  await page.waitForTimeout(1_000);
  await page.keyboard.type('DEF', { delay: 60 });
  await page.waitForTimeout(600);
  await editor.locator('p').nth(1).click(); await page.keyboard.press('End');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor.locator('p').first()).toHaveText('第一段ABC');
  await page.keyboard.type('X');
  await expect(editor.locator('p').first()).toHaveText('第一段ABCX');
  await expect(editor.locator('p').nth(1)).toHaveText('第二段');
});

async function documentItems(request: APIRequestContext) {
  return ((await (await request.get(`${api}/api/v1/library/materials`)).json()).data.items as Array<{ kind: string; title: string }>).filter((item) => item.kind === 'document');
}

test('只点新建文档不写内容，不会在 Dovun 建出空文档，关闭后也不留本机草稿', async ({ page, request }, info) => {
  await page.goto('/#/library');
  await page.getByRole('button', { name: '新建文档', exact: true }).click();
  await expect(richEditor(page)).toBeVisible();
  await expect(page.getByTestId('document-save-state')).toHaveText('输入内容后开始保存');
  await page.waitForTimeout(3_000);
  expect(await documentItems(request)).toEqual([]);
  // Narrow layouts have no tab strip; there "返回文件列表" is the only way out and is covered below.
  if (info.project.name !== 'mobile') {
    await page.getByRole('button', { name: '关闭 未命名文档', exact: true }).click();
    await expect(page.getByTestId('document-pane')).toHaveCount(0);
    await page.getByRole('button', { name: '本机草稿', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '本机草稿', exact: true }).getByText('此设备没有待恢复的文档草稿。', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '新建文档', exact: true }).click();
    await expect(richEditor(page)).toBeVisible();
  }
  // Returning to the list discards an untouched blank document too.
  await page.getByRole('button', { name: '返回文件列表', exact: true }).click();
  await expect(page.getByTestId('document-pane')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^已打开/ })).toHaveCount(0);
  await page.getByRole('button', { name: '本机草稿', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '本机草稿', exact: true }).getByText('此设备没有待恢复的文档草稿。', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2_500);
  expect(await documentItems(request)).toEqual([]);
});

test('新建后直接输入标题，回车进入正文，标题和正文一起保存', async ({ page, request }) => {
  await page.goto('/#/library');
  await page.getByRole('button', { name: '新建文档', exact: true }).click();
  const title = page.getByRole('textbox', { name: '文档标题', exact: true });
  await expect(title).toBeFocused();
  await page.keyboard.type('支付方案');
  await page.keyboard.press('Enter');
  await expect(richEditor(page)).toBeFocused();
  await page.keyboard.type('第一段正文');
  await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun', { timeout: 20_000 });
  const [item] = await documentItems(request);
  expect(item?.title).toBe('支付方案');
  const saved = await bodyOf(request, (item as unknown as { id: string }).id);
  expect(JSON.stringify(saved.content)).toContain('第一段正文');
  expect(saved.title).toBe('支付方案');
});
