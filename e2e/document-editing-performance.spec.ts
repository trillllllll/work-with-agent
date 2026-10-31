import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
import { editBudgetOverrideKey } from '../client/src/components/documents/edit-budget.js';

/**
 * Editing performance samples (DOCUMENT_EDIT_MEASURE=1). Every sample opens straight into the editor through the
 * development budget override, so documents above the shipped budgets can be measured. Gate per sample, taken
 * from performance-verification.md: keydown-to-next-frame p95 <= 50 ms and no long task over 50 ms while typing
 * or saving. Chromium only, no CPU throttling, garbage collected before each sample; numbers are a desktop baseline,
 * not a device guarantee.
 */
const api = process.env.E2E_API_URL!;
const output = '/tmp/dovun-document-browser-performance';
const label = process.env.DOCUMENT_MEASURE_LABEL ?? 'run';
const unlimited = { rich: { blocks: 1_000_000, bytes: 64 * 1024 * 1024 }, richHard: { blocks: 1_000_000, bytes: 64 * 1024 * 1024 }, text: 64 * 1024 * 1024, textHard: 64 * 1024 * 1024 };
type Block = Record<string, unknown>;
type Sample = { name: string; kind: 'paragraphs' | 'list' | 'tables' | 'markdown'; units: number; format: 'richdoc-v1' | 'markdown'; content: unknown; mode?: 'edit' | 'split'; target: string };

const sentence = '这是用于测量输入和排版的正文。'.repeat(6);
const paragraph = (id: string, text: string): Block => ({ id, kind: 'paragraph', text: [{ text }] });
function paragraphs(count: number) { return Array.from({ length: count }, (_, index) => paragraph(`p-${index}`, `第 ${index + 1} 段：${sentence}`)); }
function list(items: number) { return [{ id: 'list', kind: 'bulletList', children: Array.from({ length: items }, (_, index) => ({ id: `li-${index}`, kind: 'listItem', children: [paragraph(`lp-${index}`, `条目 ${index + 1}：${sentence.slice(0, 30)}`)] })) }]; }
function table(id: string, rows = 20, columns = 5): Block {
  return { id, kind: 'table', children: Array.from({ length: rows }, (_, row) => ({ id: `${id}-r${row}`, kind: 'tableRow', children: Array.from({ length: columns }, (_, column) => ({ id: `${id}-r${row}-c${column}`, kind: row === 0 ? 'tableHeader' : 'tableCell', children: [paragraph(`${id}-r${row}-c${column}-p`, `单元格 ${row}-${column}`)] })) })) };
}
function tables(count: number) { return Array.from({ length: count }, (_, index) => [paragraph(`t-intro-${index}`, `表格 ${index + 1} 前的说明`), table(`t-${index}`)]).flat(); }
function markdown(bytes: number) {
  const parts: string[] = []; let size = 0; let index = 0;
  while (size < bytes) { const part = `## 小节 ${index + 1}\n\n${sentence}\n\n- 要点 ${index + 1}\n- 继续说明\n\n`; parts.push(part); size += Buffer.byteLength(part); index++; }
  return parts.join('');
}
const blockCount = (content: unknown) => { let count = 0; const visit = (value: unknown) => { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') { const record = value as Record<string, unknown>; if (typeof record.id === 'string' && typeof record.kind === 'string') count++; Object.values(record).forEach(visit); } }; visit(content); return count; };

async function create(request: APIRequestContext, sample: Sample) {
  const content = sample.format === 'richdoc-v1' ? { schemaVersion: 1, blocks: sample.content } : sample.content;
  const response = await request.post(`${api}/api/v1/library/resources`, { data: { requestId: crypto.randomUUID(), title: sample.name, format: sample.format, content }, timeout: 120_000 });
  expect(response.ok(), await response.text()).toBe(true);
  return { ...(await response.json()).data as { id: string }, jsonBytes: Buffer.byteLength(typeof content === 'string' ? content : JSON.stringify(content)), blocks: sample.format === 'richdoc-v1' ? blockCount(content) : 0 };
}

async function freshLibrary(page: Page) {
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('/#/library'); await page.reload();
  await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
}

const percentile = (values: number[], fraction: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : 0; };
// Playwright trace snapshots serialise the whole DOM on every action; on long documents that alone causes
// long tasks, so measurement runs never record traces.
test.use({ trace: 'off', screenshot: 'off' });

test('编辑性能样本：段落、列表、表格与 Markdown', async ({ page, request }) => {
  test.setTimeout(1_800_000);
  await mkdir(output, { recursive: true }); await resetE2eDatabase();
  await page.addInitScript(({ key, budgets }) => {
    (window as any).__REACT_GRAB_DISABLED__ = true;
    localStorage.setItem('dovun.theme', 'light');
    localStorage.setItem(key, JSON.stringify(budgets));
    (window as any).__longTasks = [];
    new PerformanceObserver((entries) => { (window as any).__longTasks.push(...entries.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration }))); }).observe({ type: 'longtask', buffered: true });
    (window as any).__inputSamples = [];
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'x' || !(event.target instanceof Element) || !event.target.closest('.document-prose, .document-source')) return;
      const started = performance.now(); requestAnimationFrame(() => (window as any).__inputSamples.push(performance.now() - started));
    }, true);
  }, { key: editBudgetOverrideKey, budgets: unlimited });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();

  const only = process.env.DOCUMENT_MEASURE_ONLY ? new RegExp(process.env.DOCUMENT_MEASURE_ONLY) : null;
  const samples: Sample[] = [
    ...[500, 1000, 2000, 5000, 10000].map((count): Sample => ({ name: `段落 ${count}`, kind: 'paragraphs', units: count, format: 'richdoc-v1', content: paragraphs(count), target: '.document-prose > p' })),
    ...[250, 500, 1000, 2500, 5000].map((items): Sample => ({ name: `列表 ${items} 项`, kind: 'list', units: items, format: 'richdoc-v1', content: list(items), target: '.document-prose li p' })),
    ...[2, 4, 9, 22, 45].map((count): Sample => ({ name: `表格 ${count} 个 20×5`, kind: 'tables', units: count, format: 'richdoc-v1', content: tables(count), target: '.document-prose td p' })),
    ...[256 * 1024, 1024 * 1024].flatMap((bytes) => (['edit', 'split'] as const).map((mode): Sample => ({ name: `Markdown ${bytes / 1024} KiB ${mode === 'split' ? '分屏' : '源码'}`, kind: 'markdown', units: bytes, format: 'markdown', content: markdown(bytes), mode, target: 'textarea.document-source' }))),
    // Above about 1 MB the split preview shows a size notice instead of rendering, so larger texts are measured in source mode only.
    ...[2048 * 1024, 4096 * 1024].map((bytes): Sample => ({ name: `Markdown ${bytes / 1024} KiB 源码`, kind: 'markdown', units: bytes, format: 'markdown', content: markdown(bytes), mode: 'edit', target: 'textarea.document-source' })),
  ].filter((sample) => !only || only.test(sample.name));
  const profileFor = new Set((process.env.DOCUMENT_MEASURE_PROFILE ?? '段落 1000').split(',').filter(Boolean));

  const results: unknown[] = [];
  const serverErrors: string[] = [];
  page.on('response', async (response) => {
    if (!response.url().includes('/api/') || response.status() < 500) return;
    serverErrors.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname} ${(await response.text().catch(() => '')).slice(0, 160)}`);
  });
  for (const sample of samples) {
    const resource = await create(request, sample);
    await freshLibrary(page);
    const errorsBefore = serverErrors.length;
    await page.evaluate((id) => { (window as any).__openStart = performance.now(); location.hash = `/library?resource=${id}`; }, resource.id);
    await expect(page.locator('input.document-title').first()).toHaveValue(sample.name, { timeout: 120_000 });
    await expect(page.locator(sample.target).first()).toBeVisible({ timeout: 120_000 });
    const openMs = await page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - (window as any).__openStart)))));
    expect(await page.getByTestId('document-large-reading').count()).toBe(0);
    expect(await page.getByTestId('document-large-text-reading').count()).toBe(0);
    if (sample.mode === 'split') await page.getByRole('button', { name: '分屏', exact: true }).click();
    if (sample.format === 'markdown') await page.locator(sample.target).evaluate((field: HTMLTextAreaElement) => { field.focus(); field.setSelectionRange(0, 0); });
    else { await page.locator(sample.target).first().click(); await page.keyboard.press('End'); }
    await page.waitForTimeout(800);
    // Collect what the previous sample left behind, so its teardown is not counted against this one.
    const gc = await page.context().newCDPSession(page); await gc.send('HeapProfiler.collectGarbage'); await gc.detach();
    await page.waitForTimeout(200);
    const profiling = profileFor.has(sample.name);
    const cdp = profiling ? await page.context().newCDPSession(page) : null;
    if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
    await page.evaluate(() => { (window as any).__inputSamples = []; (window as any).__inputStart = performance.now(); });
    let saveRequestMs: number | null = null;
    const saveResponse = page.waitForResponse((response) => response.request().method() === 'PUT' && /\/api\/v1\/library\/resources\/[^/]+\/content$/.test(new URL(response.url()).pathname), { timeout: 120_000 })
      .then(async (response) => { await response.finished().catch(() => null); const timing = response.request().timing(); const end = timing.responseEnd > 0 ? timing.responseEnd : timing.responseStart; saveRequestMs = end > 0 ? end : null; return response.status(); }).catch(() => null);
    for (let key = 0; key < 15; key++) { await page.keyboard.press('x'); await page.waitForTimeout(90); }
    const typingEnd = await page.evaluate(() => performance.now());
    await page.waitForTimeout(300);
    const savedAt = Date.now();
    await expect(page.getByTestId('document-save-state')).toHaveText('已保存到 Dovun', { timeout: 120_000 });
    const saveMs = Date.now() - savedAt + 300;
    const saveStatus = await saveResponse;
    await page.waitForTimeout(2_000);
    if (cdp) {
      const { profile } = await cdp.send('Profiler.stop');
      await writeFile(`${output}/edit-profile-${label}-${sample.name.replace(/\s+/g, '_')}.cpuprofile`, JSON.stringify(profile));
      await cdp.detach();
    }
    const timing = await page.evaluate((end) => {
      const start = (window as any).__inputStart as number;
      const tasks = ((window as any).__longTasks as Array<{ start: number; duration: number }>).filter((entry) => entry.start >= start);
      return { samples: (window as any).__inputSamples as number[], typing: tasks.filter((entry) => entry.start <= end + 300), after: tasks.filter((entry) => entry.start > end + 300) };
    }, typingEnd);
    const maxTyping = Math.max(0, ...timing.typing.map((entry) => entry.duration));
    const maxAfter = Math.max(0, ...timing.after.map((entry) => entry.duration));
    const inputP95Ms = percentile(timing.samples, 0.95);
    const result = {
      name: sample.name, kind: sample.kind, units: sample.units, blocks: resource.blocks, jsonBytes: resource.jsonBytes,
      openMs: Math.round(openMs), inputSamples: timing.samples.length, inputMedianMs: +percentile(timing.samples, 0.5).toFixed(1), inputP95Ms: +inputP95Ms.toFixed(1), inputMaxMs: +Math.max(0, ...timing.samples).toFixed(1),
      typingLongTasks: timing.typing.length, typingMaxLongTaskMs: Math.round(maxTyping), saveLongTasks: timing.after.length, saveMaxLongTaskMs: Math.round(maxAfter),
      saveMs, saveRequestMs: saveRequestMs === null ? null : Math.round(saveRequestMs), saveStatus, serverErrors: serverErrors.slice(errorsBefore),
      gate: inputP95Ms <= 50 && maxTyping <= 50 && maxAfter <= 50 && serverErrors.length === errorsBefore && saveStatus === 200,
    };
    results.push(result);
    console.log('edit measurement', JSON.stringify(result));
    await writeFile(`${output}/edit-measurements-${label}.json`, JSON.stringify({ at: new Date().toISOString(), browser: page.context().browser()?.version(), label, results }, null, 2));
  }
  await e2eDatabase.$disconnect();
});
