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
/** Format controls that do not fit the toolbar row (narrow and touch screens) are under "More formatting". */
async function formatControl(page: Page, name: string) {
  const toolbar = page.getByRole('toolbar', { name: '格式工具', exact: true });
  const inline = toolbar.getByRole('button', { name, exact: true });
  if (await inline.count()) { await inline.click(); return; }
  await toolbar.getByRole('button', { name: '更多格式', exact: true }).click();
  await page.locator('.format-menu-list').getByRole('button', { name, exact: true }).click();
}

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

test('阅读模式没有插入入口，拖入文件也不改正文', async ({ page, request }) => {
  const doc = await createRich(request, '阅读拖放', [paragraph('first', '原有正文')]);
  await open(page, doc.id);
  await expect(page.getByRole('toolbar', { name: '格式工具', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: '格式工具', exact: true })).toHaveCount(0);
  const uploads: string[] = []; page.on('request', (sent) => { if (new URL(sent.url()).pathname.startsWith('/api/v1/library/uploads')) uploads.push(sent.method()); });
  const drop = await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' })); return transfer; });
  await page.getByTestId('document-pane').dispatchEvent('drop', { dataTransfer: drop });
  await drop.dispose();
  await page.waitForTimeout(1_000);
  expect(uploads).toEqual([]);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(richEditor(page).locator('.document-resource')).toHaveCount(0);
  expect((await bodyOf(request, doc.id)).revision).toBe(doc.revision);
});

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
  await formatControl(page, '代码块');
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

const assistantReply = '## 会议结论\n\n- 第一项\n- 第二项\n\n**重点**：上线前回归\n\n```js\nconsole.log(1)\n```\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |';
async function pasteText(page: Page, text: string, options: { plainShortcut?: boolean } = {}) {
  await richEditor(page).evaluate((node, { text, plainShortcut }) => {
    if (plainShortcut) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', shiftKey: true, metaKey: navigator.platform.startsWith('Mac'), ctrlKey: !navigator.platform.startsWith('Mac'), bubbles: true, cancelable: true }));
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', text);
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, { text, plainShortcut: options.plainShortcut === true });
}

test('粘贴助手回复的 Markdown 变成格式，Ctrl/Cmd+Shift+V 保留原文字符', async ({ page, request }) => {
  const doc = await createRich(request, 'Markdown 粘贴', [paragraph('first', '开头')]);
  await open(page, doc.id);
  const editor = richEditor(page);
  await editor.locator('p').first().click(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await pasteText(page, assistantReply);
  await expect(editor.locator('h2')).toHaveText('会议结论');
  await expect(editor.locator('ul > li')).toHaveCount(2);
  await expect(editor.locator('strong')).toHaveText('重点');
  await expect(editor.locator('pre')).toContainText('console.log(1)');
  await expect(editor.locator('table th')).toHaveCount(2);
  await expect(editor.locator('table td')).toHaveCount(2);
  await expect(editor).not.toContainText('##');
  await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun', { timeout: 20_000 });
  const saved = (await bodyOf(request, doc.id)).content as { blocks: Array<{ kind: string; level?: number; language?: string }> };
  expect(saved.blocks.map((block) => block.kind)).toEqual(['paragraph', 'heading', 'bulletList', 'paragraph', 'codeBlock', 'table', 'paragraph']);
  expect(saved.blocks[1].level).toBe(2); expect(saved.blocks[4].language).toBe('js');

  await editor.locator('p').last().click(); await page.keyboard.press('End');
  await pasteText(page, '## 原样\n\n- 星号 **不转换**', { plainShortcut: true });
  await expect(editor).toContainText('## 原样');
  await expect(editor).toContainText('- 星号 **不转换**');
  await expect(editor.locator('h2')).toHaveCount(1);
});

type SavedBlock = { kind: string; text?: Array<{ text: string; marks?: Array<{ kind: string; href?: string }> }>; children?: SavedBlock[] };
const tableCell = (id: string, text: string, header = false): Block => ({ id, kind: header ? 'tableHeader' : 'tableCell', children: [paragraph(`${id}-p`, text)] });
/** Each saved row as [cell kind, cell text] pairs. */
const tableShape = (table: SavedBlock | undefined) => table?.children?.map((row) => row.children?.map((cell) => [cell.kind, cell.children?.[0]?.text?.map((run) => run.text).join('') ?? '']));

test('表格在光标处增删行列，也可整表删除，保存的结构随之改变', async ({ page, request }) => {
  const doc = await createRich(request, '表格行列', [paragraph('intro', '表格前'), { id: 'table', kind: 'table', children: [
    { id: 'r0', kind: 'tableRow', children: [tableCell('h0', '名称', true), tableCell('h1', '数量', true)] },
    { id: 'r1', kind: 'tableRow', children: [tableCell('c0', '苹果'), tableCell('c1', '3')] },
  ] }]);
  await open(page, doc.id);
  const editor = richEditor(page);
  const rows = editor.locator('tr');
  const choose = async (name: string) => {
    await page.getByRole('button', { name: '表格行列', exact: true }).click();
    await page.locator('.format-menu-list').getByRole('button', { name, exact: true }).click();
  };
  await editor.getByText('苹果', { exact: true }).click();
  await choose('在下方插入行');
  await expect(rows).toHaveCount(3);
  await choose('在右侧插入列');
  await expect(rows.first().locator('th, td')).toHaveCount(3);
  // Delete the inserted column and row again from inside them; the original table remains.
  await rows.nth(1).locator('td').nth(1).click();
  await choose('删除列');
  await expect(rows.first().locator('th, td')).toHaveCount(2);
  await rows.nth(2).locator('td').first().click();
  await choose('删除行');
  await expect(rows).toHaveCount(2);
  await expect.poll(async () => tableShape(firstBlock((await bodyOf(request, doc.id)).content, 'table') as SavedBlock), { timeout: 20_000 })
    .toEqual([[['tableHeader', '名称'], ['tableHeader', '数量']], [['tableCell', '苹果'], ['tableCell', '3']]]);
  // The whole table goes, including a row added just before.
  await choose('在下方插入行');
  await expect(rows).toHaveCount(3);
  await choose('删除表格');
  await expect(editor.locator('table')).toHaveCount(0);
  await expect(editor).toContainText('表格前');
  await expect.poll(async () => firstBlock((await bodyOf(request, doc.id)).content, 'table'), { timeout: 20_000 }).toBeUndefined();
});

test('链接可修改地址并整段移除，不安全地址不能应用', async ({ page, request }) => {
  const doc = await createRich(request, '链接编辑', [{ id: 'first', kind: 'paragraph', text: [{ text: '前文 ' }, { text: '官网链接', marks: [{ kind: 'link', href: 'https://old.example.com/' }] }, { text: ' 后文' }] }]);
  await open(page, doc.id);
  const editor = richEditor(page);
  const links = async () => ((await bodyOf(request, doc.id)).content.blocks[0] as SavedBlock).text!.filter((run) => run.marks?.some((mark) => mark.kind === 'link')).map((run) => ({ text: run.text, href: run.marks!.find((mark) => mark.kind === 'link')!.href }));
  // The caret sits inside the link; the whole link is edited.
  await editor.locator('a').click();
  await formatControl(page, '链接');
  const dialog = page.getByRole('dialog', { name: '链接', exact: true });
  const address = dialog.getByRole('textbox', { name: '链接地址', exact: true });
  await expect(address).toHaveValue('https://old.example.com/');
  await address.fill('javascript:alert(1)');
  await expect(dialog.getByRole('button', { name: '应用', exact: true })).toBeDisabled();
  await address.fill('https://new.example.com/');
  await address.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://new.example.com/');
  await expect(editor.locator('a')).toHaveText('官网链接');
  await expect.poll(links, { timeout: 20_000 }).toEqual([{ text: '官网链接', href: 'https://new.example.com/' }]);
  await editor.locator('a').click();
  await formatControl(page, '链接');
  await page.getByRole('dialog', { name: '链接', exact: true }).getByRole('button', { name: '移除链接', exact: true }).click();
  await expect(editor.locator('a')).toHaveCount(0);
  await expect(editor.locator('p').first()).toHaveText('前文 官网链接 后文');
  await expect.poll(links, { timeout: 20_000 }).toEqual([]);
  expect(((await bodyOf(request, doc.id)).content.blocks[0] as SavedBlock).text!.map((run) => run.text).join('')).toBe('前文 官网链接 后文');
});
