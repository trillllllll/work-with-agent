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
