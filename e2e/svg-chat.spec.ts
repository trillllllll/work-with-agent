import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 280"><text x="8" y="26" fill="#8b95a5">本周完成记录</text><rect x="202" y="55" width="80" height="30" fill="#416e85"/><text x="242" y="75" text-anchor="middle" fill="#ffffff">8 条</text></svg>';
const fence = (source: string, language = 'svg') => '```' + language + '\n' + source + '\n```';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { localStorage.setItem('agent-studio.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('历史 Markdown 和富媒体文字块里的 SVG 可预览、查看源码、放大和导出，危险内容不执行', async ({ page }) => {
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (request.url().includes('blocked-svg.invalid')) externalRequests.push(request.url()); });
  const conversation = await e2eDatabase.conversation.create({ data: {} });
  const markdown = '完成记录如下：\n\n' + fence(svg) + '\n\n本周完成 9 条。\n\n```ts\nconst keep = 1\n```';
  await e2eDatabase.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: markdown } });
  await e2eDatabase.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: '富媒体文字块', blocksJson: JSON.stringify({ schemaVersion: 1, blocks: [{ id: 'text-svg', index: 0, type: 'text', status: 'ready', markdown: fence(svg, '') }, { id: 'standalone-svg', index: 1, type: 'svg', status: 'ready', title: '独立 SVG', source: svg }] }) } });
  const unsafe = '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svgExecuted=true"><script>window.__svgExecuted=true</script><image href="https://blocked-svg.invalid/image"/></svg>';
  await e2eDatabase.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: fence(unsafe) } });
  await page.addInitScript((id) => localStorage.setItem('agent-studio.conversationId', id), conversation.id);
  await page.goto('/#/chat');
  const previews = page.locator('[data-svg-block]');
  await expect(previews).toHaveCount(3);
  for (const preview of [previews.nth(0), previews.nth(1)]) {
    const image = preview.getByRole('img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  await expect(page.locator('[data-block-type=svg]').getByRole('img', { name: '独立 SVG' })).toBeVisible();
  await previews.first().screenshot({ path: `/tmp/wwa-svg-fallback-${test.info().project.name}.png` });
  await expect(page.locator('pre', { hasText: 'const keep = 1' })).toBeVisible();
  await expect(previews.nth(2).getByRole('alert')).toBeVisible();
  await expect(previews.nth(2).getByRole('img')).toHaveCount(0);
  const first = previews.first();
  await first.getByRole('button', { name: '查看源码', exact: true }).click();
  await expect(first.locator('pre')).toContainText('<svg');
  await first.getByRole('button', { name: '查看源码', exact: true }).click();
  const download = page.waitForEvent('download');
  await first.getByRole('button', { name: 'SVG', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('diagram.svg');
  await first.getByRole('button', { name: '放大查看', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__svgExecuted)).toBeUndefined();
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.locator('[data-svg-block] img')).toHaveCount(2);
});

test('浏览器 SVG 过滤保留内部箭头，拒绝脚本、外链、样式、非法 XML 和超大内容', async ({ page }) => {
  await page.goto('/#/chat');
  const result = await page.evaluate(async (modulePath) => {
    const { safeSvg } = await import(modulePath);
    const valid = safeSvg('<svg viewBox="0 0 200 80"><defs><marker id="arrow"><path d="M0 0 L6 3 L0 6"/></marker></defs><path d="M10 10 L100 10" marker-end="url(#arrow)"/><text x="8" y="50">中文</text></svg>');
    const rejected = [
      String.raw`<svg><rect fill="u\72l(https\3a\2f\2f blocked-svg.invalid/x)"/></svg>`,
      '<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"/>',
      '<svg><foreignObject/></svg>', '<svg><image href="https://blocked-svg.invalid/x"/></svg>',
      '<svg><rect fill="url(https://blocked-svg.invalid/x)"/></svg>', '<svg style="background:url(https://blocked-svg.invalid/x)"/>',
      '<!DOCTYPE svg><svg/>', '<svg><g></svg>', '<html/>',
      '<svg><path marker-end="url(#missing)"/></svg>', '<svg>' + '<rect/>'.repeat(501) + '</svg>',
      '<svg>' + '<g>'.repeat(25) + '</g>'.repeat(25) + '</svg>', '<svg>' + 'x'.repeat(65536) + '</svg>',
    ].map((source) => { try { safeSvg(source); return false; } catch { return true; } });
    return { valid, rejected };
  }, '/src/lib/safe-svg.ts');
  expect(result.valid).toContain('marker-end="url(#arrow)"');
  expect(result.valid).toContain('中文');
  expect(result.valid).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(result.rejected.every(Boolean)).toBe(true);
});
