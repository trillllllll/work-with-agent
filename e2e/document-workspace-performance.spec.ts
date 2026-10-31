import { mkdir, readFile, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
import { defaultEditBudgets } from '../client/src/components/documents/edit-budget.js';

const api = process.env.E2E_API_URL!;
const output = '/tmp/dovun-document-browser-performance';
type Measurement = { paragraphs: number; jsonBytes: number; openMs: number; inputMedianMs: number; inputP95Ms: number; inputMaxMs: number; maxLongTaskMs: number; longTaskCount: number; inputSamples: number[]; inputBudgetMet: boolean };
const paragraph = (index: number, text = `第 ${index + 1} 段：${'这是用于测量输入和排版的正文。'.repeat(6)}`) => ({ id: `paragraph-${index}`, kind: 'paragraph', text: [{ text }] });
async function create(request: APIRequestContext, title: string, blocks: unknown[]) {
  const content = { schemaVersion: 1, blocks };
  const response = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: crypto.randomUUID(), title, format: 'richdoc-v1', content } });
  expect(response.ok(), await response.text()).toBe(true);
  return { ...(await response.json()).data, jsonBytes: Buffer.byteLength(JSON.stringify(content)) };
}
async function open(page: Page, id: string, title: string) {
  await page.evaluate((resourceId) => { (window as any).__openStart = performance.now(); location.hash = `/library?resource=${resourceId}`; }, id);
  await expect(page.locator('input.document-title').first()).toHaveValue(title);
}

test('浏览器正文性能、目录分页、图片懒加载与窄屏控件实测', async ({ page, request }) => {
  test.setTimeout(180_000);
  await mkdir(output, { recursive: true }); await resetE2eDatabase();
  await page.addInitScript(() => {
    (window as any).__REACT_GRAB_DISABLED__ = true;
    localStorage.setItem('dovun.theme', 'light');
    (window as any).__longTasks = [];
    new PerformanceObserver((list) => { (window as any).__longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration }))); }).observe({ type: 'longtask', buffered: true });
    (window as any).__inputSamples = [];
    document.addEventListener('keydown', (event) => { if (event.key !== 'x' || !(event.target instanceof Element) || !event.target.closest('.document-prose')) return; const started = performance.now(); requestAnimationFrame(() => (window as any).__inputSamples.push(performance.now() - started)); }, true);
  });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
  const measurements: Measurement[] = [];
  const editingGates: unknown[] = [];
  const budgetOnly = process.env.DOCUMENT_BUDGET_ONLY === '1';
  const headingBlocks = Array.from({ length: 1000 }, (_, index) => ({ id: `heading-${index}`, kind: 'heading', level: 2, text: [{ text: `章节 ${index + 1}` }] }));
  const preparedHeadings = budgetOnly ? await create(request, '1000条目录样本', headingBlocks) : null;
  // About 345 B per paragraph: 1,000 and 4,000 fit the soft budget (5,000 blocks / 1.5 MiB); 10,000 (about 3.4 MB) is above the hard budget.
  for (const count of process.env.DOCUMENT_LAYOUT_ONLY === '1' ? [] : budgetOnly ? [1000, 4000, 10000] : [1000, 10000]) {
    const resource = await create(request, `${count}段性能样本`, Array.from({ length: count }, (_, index) => paragraph(index)));
    await open(page, resource.id, resource.title);
    if (await page.getByTestId('document-large-reading').isVisible()) {
      await expect(page.locator('.document-prose > p')).toHaveCount(100);
      await expect(page.locator('.document-prose')).toHaveAttribute('contenteditable', 'false');
      await expect(page.getByRole('button', { name: '插入图片或附件', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '立即保存', exact: true })).toBeVisible();
      await expect(page.locator('input.document-title')).not.toHaveAttribute('readonly');
      const drop = await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['blocked'], 'blocked.txt', { type: 'text/plain' })); return transfer; });
      await page.getByTestId('document-pane').dispatchEvent('drop', { dataTransfer: drop });
      await drop.dispose();
      await expect(page.locator('.document-upload-list')).toHaveCount(0);
      await page.getByTestId('document-large-reading').getByRole('button', { name: '下一页', exact: true }).first().click();
      await expect(page.locator('.document-prose > p').first()).toContainText('第 101 段');
      const after = (await (await request.get(`${api}/api/v1/library/resources/${resource.id}`)).json()).data;
      expect(after.revision).toBe(resource.revision); expect(after.contentHash).toBe(resource.contentHash);
      editingGates.push({ paragraphs: count, renderedParagraphs: 100, readOnly: true, page2StartsAt: 101, originalRevision: after.revision, unchangedHash: true });
      continue;
    }
    await expect(page.locator('.document-prose > p')).toHaveCount(count);
    const openMs = await page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - (window as any).__openStart)))));
    await page.locator('.document-prose > p').first().click();
    await page.evaluate(() => { (window as any).__inputSamples = []; (window as any).__inputStart = performance.now(); });
    for (let key = 0; key < 15; key++) { await page.keyboard.press('x'); await page.waitForTimeout(90); }
    await page.waitForTimeout(500);
    const timing = await page.evaluate(() => ({ samples: (window as any).__inputSamples as number[], tasks: ((window as any).__longTasks as Array<{ start: number; duration: number }>).filter((entry) => entry.start >= (window as any).__inputStart) }));
    const sorted = [...timing.samples].sort((a, b) => a - b);
    const inputP95Ms = sorted[Math.ceil(sorted.length * .95) - 1];
    const maxLongTaskMs = Math.max(0, ...timing.tasks.map((entry) => entry.duration));
    measurements.push({ paragraphs: count, jsonBytes: resource.jsonBytes, openMs, inputMedianMs: sorted[Math.floor(sorted.length / 2)], inputP95Ms, inputMaxMs: sorted[sorted.length - 1], maxLongTaskMs, longTaskCount: timing.tasks.length, inputSamples: timing.samples, inputBudgetMet: inputP95Ms <= 50 && maxLongTaskMs <= 50 });
    await writeFile(`${output}/${budgetOnly ? 'budget-measurements' : 'measurements'}.json`, JSON.stringify(measurements, null, 2));
    console.log('document measurement', JSON.stringify(measurements[measurements.length - 1]));
    await page.getByRole('button', { name: '立即保存', exact: true }).click();
    await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun');
  }

  const headings = preparedHeadings ?? await create(request, '1000条目录样本', headingBlocks);
  await open(page, headings.id, headings.title); await page.getByRole('button', { name: '目录', exact: true }).click();
  await expect(page.getByTestId('document-outline-item')).toHaveCount(100);
  await expect(page.getByTestId('document-outline-pagination')).toContainText('1–100 / 1000');
  await page.getByTestId('document-outline-pagination').getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByTestId('document-outline-item').first()).toHaveText('章节 101');
  await page.getByTestId('document-outline-item').first().click();
  await expect(page.locator('[data-block-id="heading-100"]')).toBeInViewport();
  if (budgetOnly) {
    const after = (await (await request.get(`${api}/api/v1/library/resources/${headings.id}`)).json()).data;
    expect(after.revision).toBe(headings.revision); expect(after.contentHash).toBe(headings.contentHash);
    const report = { at: new Date().toISOString(), browser: await page.context().browser()?.version(), measurements, editingGates, outline: { headings: 1000, pageSize: 100, secondPageStartsAt: 101, originalPreserved: true } };
    await writeFile(`${output}/budget-report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    await e2eDatabase.$disconnect(); return;
  }
  if (await page.getByTestId('document-large-reading').isVisible()) {
    await expect(page.locator('.document-prose > h2')).toHaveCount(100);
    await expect(page.locator('.document-prose')).toHaveAttribute('contenteditable', 'false');
  }
  {
    // One block above the soft byte budget: its page is still too large, so the text itself is paged.
    const longText = 'A'.repeat(10_000) + 'B'.repeat(10_000) + 'C'.repeat(defaultEditBudgets.rich.bytes);
    const long = await create(request, '单块纯文字阅读降级', [paragraph(0, longText)]);
    await open(page, long.id, long.title);
    const textPage = page.getByTestId('document-large-reading').locator('pre');
    await expect(textPage).toHaveText('A'.repeat(10_000));
    await page.getByRole('button', { name: '下一段文字', exact: true }).click();
    await expect(textPage).toHaveText('B'.repeat(10_000));
    const original = (await (await request.get(`${api}/api/v1/library/resources/${long.id}`)).json()).data;
    expect(original.content.blocks[0].text[0].text).toBe(longText);
    editingGates.push({ paragraphs: 1, characters: longText.length, textPageCharacters: 10_000, originalPreserved: true });
  }

  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const prepared = await request.post(`${api}/api/v1/library/uploads`, { data: { requestKey: crypto.randomUUID(), fileName: 'proof.png', mimeType: 'image/png', size: bytes.length } });
  const uploadId = (await prepared.json()).data.id;
  expect((await request.put(`${api}/api/v1/library/uploads/${uploadId}/content`, { data: bytes, headers: { 'Content-Type': 'application/octet-stream' } })).ok()).toBe(true);
  const committed = await request.post(`${api}/api/v1/commands`, { data: { requestId: crypto.randomUUID(), commands: [{ kind: 'material.create', input: { uploadId, topicId: null, folderId: null, taskIds: [], duplicateAction: 'create' } }] } });
  expect(committed.ok(), await committed.text()).toBe(true);
  const imageId = (await committed.json()).data.results[0].id;
  const imageBlocks = Array.from({ length: 8 }, (_, index) => ({ id: `image-${index}`, kind: 'image', target: { resourceId: imageId, revision: 1 }, alt: `配图 ${index + 1}` }));
  const illustrated = await create(request, '视口外图片样本', [...Array.from({ length: 100 }, (_, index) => paragraph(index)), ...imageBlocks]);
  const originalRequests: string[] = []; page.on('request', (request) => { if (request.url().includes(`/resources/${imageId}/versions/1/original`)) originalRequests.push(request.url()); });
  await open(page, illustrated.id, illustrated.title); await expect(page.locator('.document-resource-image')).toHaveCount(8); await page.waitForTimeout(500);
  const beforeScroll = originalRequests.length; expect(beforeScroll).toBe(0);
  await page.locator('.document-resource-image').last().scrollIntoViewIfNeeded();
  await expect.poll(() => originalRequests.length).toBe(8);
  const richImageRequests = originalRequests.length;
  const markdownReferences = Array.from({ length: 8 }, (_, index) => ({ path: `images/proof-${index}.png`, resourceId: imageId, revision: 1 }));
  const markdownBody = `${Array.from({ length: 100 }, (_, index) => `第${index + 1}段 Markdown 正文。`).join('\n\n')}\n\n${markdownReferences.map((reference, index) => `![配图${index + 1}](${reference.path})`).join('\n\n')}`;
  const markdownResponse = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: crypto.randomUUID(), title: 'Markdown视口外图片样本', format: 'markdown', content: markdownBody, relativeReferences: markdownReferences } });
  expect(markdownResponse.ok(), await markdownResponse.text()).toBe(true);
  const markdown = (await markdownResponse.json()).data;
  await open(page, markdown.id, markdown.title);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.locator('.document-mapped-image')).toHaveCount(8);
  await page.waitForTimeout(500);
  const markdownBeforeScroll = originalRequests.length - richImageRequests; expect(markdownBeforeScroll).toBe(0);
  await page.locator('.document-mapped-image').last().scrollIntoViewIfNeeded();
  await expect.poll(() => originalRequests.length - richImageRequests).toBe(8);
  await expect(page.locator('.document-mapped-image img')).toHaveCount(8);
  const markdownAfterScroll = originalRequests.length - richImageRequests;

  const layout = await create(request, '支付方案 · 文档工作区', [{ id: 'layout-heading', kind: 'heading', level: 1, text: [{ text: '支付方案' }] }, paragraph(1, '记录讨论结论，引用确切版本的证据，并在不同设备继续编辑。'), paragraph(2, '验收重点：正文保存、文件引用、目录导航以及返回文件列表。')]);
  const comparison = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: crypto.randomUUID(), title: '对照资料', format: 'text', content: '参考条件\n1. 保留原始版本\n2. 修改正文产生新版本\n3. 改名和移动不改变正文版本' } });
  const reference = (await comparison.json()).data;
  await open(page, reference.id, reference.title); await open(page, layout.id, layout.title);
  await page.getByRole('combobox', { name: '并排对照', exact: true }).selectOption({ label: '对照资料' });
  await expect(page.getByTestId('document-pane')).toHaveCount(2); await page.screenshot({ path: `${output}/dual-1440-light.png`, fullPage: true });
  await page.getByRole('combobox', { name: '并排对照', exact: true }).selectOption('');
  const controls: unknown[] = [];
  for (const theme of ['light', 'dark']) for (const width of [390, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((theme) => { document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add(theme); document.documentElement.style.colorScheme = theme; localStorage.setItem('dovun.theme', theme); }, theme);
    const checks = await page.evaluate(() => {
      const expected = ['返回文件列表', '编辑', '阅读', '立即保存', '插入图片或附件', '导出'];
      return expected.map((label) => { const button = [...document.querySelectorAll<HTMLButtonElement>('.document-workspace button')].find((node) => node.textContent?.trim() === label); const box = button?.getBoundingClientRect(); return { label, visible: Boolean(box && box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight), width: box?.width, height: box?.height }; });
    });
    expect(checks.every((entry) => entry.visible)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    controls.push({ theme, width, checks }); await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true });
  }
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: '导出', exact: true }).click(); await page.getByRole('menuitem', { name: '导出本机恢复包', exact: true }).click();
  const packageFile = await downloaded; const zip = await JSZip.loadAsync(await readFile(await packageFile.path()));
  const recovery = JSON.parse(await zip.file('manifest.json')!.async('string')); expect(recovery.complete).toBe(true); expect(zip.file('draft.json')).not.toBeNull();
  const report = { at: new Date().toISOString(), browser: await page.context().browser()?.version(), measurements, editingGates, outline: { headings: 1000, pageSize: 100, secondPageStartsAt: 101 }, images: { count: 8, beforeScroll, afterScroll: richImageRequests }, markdownImages: { count: 8, beforeScroll: markdownBeforeScroll, afterScroll: markdownAfterScroll }, controls, recoveryExport: { complete: recovery.complete }, notes: ['Chromium desktop engine, no CPU throttling; mobile widths are layout simulations.', 'Input samples measure keydown capture to the following requestAnimationFrame callback, a pre-paint proxy. Long tasks also cover delayed serialization and draft persistence.'] };
  await writeFile(`${output}/${process.env.DOCUMENT_LAYOUT_ONLY === '1' ? 'layout-report' : 'report'}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  await e2eDatabase.$disconnect();
});
