import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const mock = 'http://127.0.0.1:4010';
test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  expect((await request.patch(`${api}/api/settings`, { data: { model: 'mock', baseUrl: `${mock}/v1`, apiKey: 'test-key' } })).ok()).toBe(true);
  expect((await request.patch(`${api}/api/settings/html-blocks`, { data: { enabled: true } })).ok()).toBe(true);
  await page.addInitScript(() => { (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterEach(async ({ request }) => { await request.get(`${mock}/stream-fixture/release`); });
test.afterAll(() => e2eDatabase.$disconnect());
async function send(page: Page, kind: string) {
  await page.goto('/#/plan'); await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.getByLabel('向 AI 提问').fill(`正式流式验收 ${kind}`); await page.getByRole('button', { name: '发送', exact: true }).click();
}
async function savedBlock() {
  const message = await e2eDatabase.message.findFirst({ where: { role: 'assistant', blocksJson: { not: null } }, orderBy: { createdAt: 'desc' } });
  return message ? JSON.parse(message.blocksJson!).blocks[0] : null;
}
for (const kind of ['markdown', 'plain', 'bar', 'line', 'pie', 'scatter', 'mermaid', 'svg']) {
  test(`${kind} uses the actual model stream, persisted pending state and final history`, async ({ page, request, browserName }, info) => {
    let reloading = false;
    const errors: string[] = [], navigationCancellations: string[] = [];
    page.on('pageerror', e => {
      if (browserName === 'webkit' && reloading && /\/api\/(?:agent\/runs\/[^/]+\/events|conversations\/[^/]+\/snapshot).*due to access control checks\.$/.test(e.message)) navigationCancellations.push(e.message);
      else errors.push(e.message);
    });
    await send(page, kind);
    const chart = ['bar', 'line', 'pie', 'scatter'].includes(kind);
    const block = page.locator(`[data-block-type="${chart ? 'chart' : kind === 'markdown' ? 'text' : kind}"]`).last();
    if (kind === 'plain' || kind === 'markdown') {
      await expect(page.getByRole('heading', { name: '流式排版' })).toBeVisible();
      await expect(page.locator('.markdown-body strong').filter({ hasText: '可读文字' })).toBeVisible();
    } else {
      await expect(block).toHaveAttribute('data-block-status', 'pending');
      await expect(block.locator(chart ? 'canvas' : 'img')).toBeVisible({ timeout: 20_000 });
      expect((await savedBlock()).status).toBe('pending');
      if (chart) { expect((await savedBlock()).previewSpec.provenance.kind).toBe('unverified'); await expect(block).not.toContainText('已核验'); }
    }
    // Refresh is a real snapshot + SSE re-subscription while the model is still held.
    reloading = true; await page.reload(); await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click(); reloading = false;
    if (kind !== 'plain') await expect(block).toHaveAttribute('data-block-status', 'pending');
    await request.get(`${mock}/stream-fixture/release`);
    if (kind === 'plain') await expect(page.getByText('最后一段确认。', { exact: true })).toBeVisible();
    else {
      await expect(block).toHaveAttribute('data-block-status', 'ready');
      if (kind === 'markdown') await expect(block).toContainText('最后一段确认。');
      else if (!chart) {
        await expect.poll(async () => block.locator('img').evaluate(async img => fetch((img as HTMLImageElement).src).then(r => r.text()))).toContain('最终节点');
      } else expect((await savedBlock()).spec.provenance.kind).toBe('simulated');
    }
    await page.screenshot({ path: info.outputPath(`${kind}.png`), fullPage: true });
    reloading = true; await page.reload(); await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click(); reloading = false;
    if (kind !== 'plain') await expect(block).toHaveAttribute('data-block-status', 'ready');
    if (navigationCancellations.length) await info.attach('webkit-navigation-cancellations', { body: JSON.stringify(navigationCancellations), contentType: 'application/json' });
    expect(errors).toEqual([]);
  });
}
test('HTML retains entered value, focus and iframe identity through completion, source view and theme', async ({ page, request }, info) => {
  await send(page, 'html');
  const block = page.locator('[data-block-type="html"]');
  await block.scrollIntoViewIfNeeded();
  const frame = page.frameLocator('[data-testid="html-block-frame"]');
  const field = frame.getByLabel('我的计划');
  await expect(field).toBeVisible(); await field.fill('先做这个😀');
  await field.evaluate(el => { el.setAttribute('data-original-node', 'yes'); });
  await expect(block).toHaveAttribute('data-block-status', 'pending');
  expect(await field.evaluate(() => (window as any).__runs ?? 0)).toBe(0);
  await request.get(`${mock}/stream-fixture/release`);
  await expect(block).toHaveAttribute('data-block-status', 'ready');
  await expect.poll(() => field.evaluate(() => (window as any).__runs)).toBe(1);
  await expect(field).toHaveValue('先做这个😀'); await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('data-original-node', 'yes');
  const source = block.getByRole('button', { name: '查看源码', exact: true });
  await source.click(); await source.click();
  await page.evaluate(() => { localStorage.setItem('dovun.theme', 'dark'); window.dispatchEvent(new StorageEvent('storage', { key: 'dovun.theme', newValue: 'dark' })); });
  await expect.poll(() => field.evaluate(() => document.documentElement.getAttribute('data-wwa-theme'))).toBe('dark');
  await expect(field).toHaveValue('先做这个😀'); expect(await field.evaluate(() => (window as any).__runs)).toBe(1);
  await frame.getByRole('button', { name: '确认', exact: true }).click(); await expect(frame.locator('#result')).toHaveText('先做这个😀');
  await page.screenshot({ path: info.outputPath('html.png'), fullPage: true });
});
for (const kind of ['html', 'mermaid', 'svg', 'bar']) test(`${kind} validation failure keeps the previous preview`, async ({ page, request }) => {
  await send(page, `${kind} invalid`);
  const block = page.locator(`[data-block-type="${kind === 'bar' ? 'chart' : kind}"]`);
  const visual = block.locator(kind === 'html' ? 'iframe' : kind === 'bar' ? 'canvas' : 'img');
  await expect(visual).toBeVisible({ timeout: 20_000 });
  await request.get(`${mock}/stream-fixture/release`);
  if (kind === 'mermaid') await expect(block.getByRole('alert').first()).toBeVisible();
  else await expect(block).toHaveAttribute('data-block-status', 'error');
  await expect(visual).toBeVisible();
  if (kind === 'html') expect(await page.frameLocator('iframe').getByLabel('我的计划').evaluate(() => (window as any).__runs ?? 0)).toBe(0);
  if (kind === 'bar') await expect(block).not.toContainText('已核验');
});
test('stopping HTML keeps input without running initialization', async ({ page }) => {
  await send(page, 'html');
  const field = page.frameLocator('[data-testid="html-block-frame"]').getByLabel('我的计划');
  await expect(field).toBeVisible(); await field.fill('中断保留');
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(page.locator('[data-block-type="html"]')).toHaveAttribute('data-block-status', 'error');
  await expect(field).toHaveValue('中断保留'); expect(await field.evaluate(() => (window as any).__runs ?? 0)).toBe(0);
});

test('a Mermaid header and style definition do not expose a blank preview or acknowledge help', async ({ page, request }) => {
  let acknowledgements = 0; page.on('request', r => { if (r.url().endsWith('/block-preview')) acknowledgements++; });
  await send(page, 'mermaid empty');
  const block = page.locator('[data-block-type="mermaid"]');
  await expect(block).toHaveAttribute('data-block-status', 'pending');
  await expect.poll(async () => (await savedBlock())?.source).toContain('classDef warm');
  await page.waitForTimeout(500); // Two render ticks, while the mock still holds the content.
  await expect(block.locator('img')).toHaveCount(0); expect(acknowledgements).toBe(0);
  await request.get(`${mock}/stream-fixture/release`); await expect(block.locator('img')).toBeVisible();
});

test('a new conversation recovers when its first sequenced SSE event is missing', async ({ page, request }) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    (window as any).__droppedFirstEvent = 0;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!String(args[0]).endsWith('/api/chat') || !response.body) return response;
      const decoder = new TextDecoder(), encoder = new TextEncoder(); let buffer = '';
      const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary + 2); buffer = buffer.slice(boundary + 2);
            if (!(window as any).__droppedFirstEvent && /"seq":\s*\d+/.test(frame)) { (window as any).__droppedFirstEvent = 1; continue; }
            controller.enqueue(encoder.encode(frame));
          }
        },
        flush(controller) { buffer += decoder.decode(); if (buffer) controller.enqueue(encoder.encode(buffer)); },
      }));
      return new Response(stream, { status: response.status, headers: response.headers });
    };
  });
  await send(page, 'svg');
  const block = page.locator('[data-block-type="svg"]');
  await expect(block.locator('img')).toBeVisible(); await expect(block).toHaveAttribute('data-block-status', 'pending');
  expect(await page.evaluate(() => (window as any).__droppedFirstEvent)).toBe(1);
  await request.get(`${mock}/stream-fixture/release`); await expect(block).toHaveAttribute('data-block-status', 'ready');
  await expect.poll(() => block.locator('img').evaluate(async img => fetch((img as HTMLImageElement).src).then(r => r.text()))).toContain('最终节点');
});
