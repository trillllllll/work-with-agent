import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const mock = 'http://127.0.0.1:4010';
const defaults = ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com'];
test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  const saved = await request.patch(`${api}/api/settings`, { data: { model: 'mock', baseUrl: `${mock}/v1`, apiKey: 'test-key' } });
  expect(saved.ok(), await saved.text()).toBe(true);
  // The mock server stands in for a CDN, so it joins the allowlist; localhost on the same port stays outside it.
  const html = await request.patch(`${api}/api/settings/html-blocks`, { data: { enabled: true, cdn: [...defaults, mock] } });
  expect(html.ok(), await html.text()).toBe(true);
  await page.addInitScript(() => { (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterEach(async ({ request }) => { await request.patch(`${api}/api/settings/html-blocks`, { data: { enabled: true, cdn: defaults } }); });
test.afterAll(() => e2eDatabase.$disconnect());

test('交互页面只能把选择填进输入框，不能联网或读取应用数据', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  let chats = 0; page.on('request', (item) => { if (item.url().endsWith('/api/chat') && item.method() === 'POST') chats++; });
  const leaksBefore = (await (await request.get(`${mock}/html-leaks`)).json()).count;
  await page.goto('/#/plan'); await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const composer = page.getByLabel('向 AI 提问');
  await composer.fill('html 选择题验收'); await page.getByRole('button', { name: '发送', exact: true }).click();
  // WebKit's IntersectionObserver sometimes never fires until the block is in view.
  await htmlBlock(page, '方案选择').scrollIntoViewIfNeeded();
  const choice = page.frameLocator('iframe[title="方案选择"]');
  await expect(choice.getByRole('button', { name: '方案 B' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('iframe[title="方案选择"]')).toHaveAttribute('sandbox', 'allow-scripts');

  // Every probe inside the page runs with the sandbox and CSP in force.
  await expect(choice.locator('#probe')).toContainText('"done":"yes"', { timeout: 15_000 });
  const probe = JSON.parse(await choice.locator('#probe').textContent() ?? '{}');
  for (const key of ['fetch', 'xhr', 'websocket', 'image', 'parent', 'top', 'storage', 'cookie', 'eval']) {
    const value = probe[key];
    // WebKit's opaque origin returns "" for document.cookie and does not throw. A real cookie string still fails.
    if (key === 'cookie' && value === '') continue;
    expect(value, key).toMatch(/^blocked:/);
  }
  expect(probe.open).toBe('null');
  expect(probe.rtc).toBe('undefined');
  expect(probe.sendBeacon).not.toBe('open');
  await expect(choice.locator('#cdn-ok')).toHaveText('loaded');
  await expect(choice.locator('#cdn-bad')).toHaveText('blocked');
  expect((await (await request.get(`${mock}/html-leaks`)).json()).count).toBe(leaksBefore);

  // The page tried to fill on load without the user touching it: nothing reaches the composer.
  await expect(composer).toHaveValue('');
  await choice.getByRole('button', { name: '方案 B' }).click();
  await expect(composer).toHaveValue('我选 B');
  await expect(composer).toBeFocused();
  await page.waitForTimeout(600);
  await choice.getByRole('button', { name: '方案 A' }).click();
  await expect(composer).toHaveValue('我选 A');
  expect(chats).toBe(1);

  // A message posted by anything other than the frame itself is ignored.
  await composer.fill('');
  await page.evaluate(() => window.postMessage({ type: 'wwa:fill-input', text: '伪造' }, '*'));
  await page.waitForTimeout(300);
  await expect(composer).toHaveValue('');

  // A page that navigates itself is stopped instead of showing what it reached.
  await htmlBlock(page, '跳转测试').scrollIntoViewIfNeeded();
  const leaving = page.frameLocator('iframe[title="跳转测试"]');
  await expect(leaving.getByRole('button', { name: '离开这里' })).toBeVisible({ timeout: 15_000 });
  await leaving.getByRole('button', { name: '离开这里' }).click();
  await expect(page.getByText('这个小页面试图离开当前内容，已停止运行。')).toBeVisible();
  await expect(page.locator('iframe[title="跳转测试"]')).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await htmlBlock(page, '方案选择').scrollIntoViewIfNeeded();
  await expect(page.frameLocator('iframe[title="方案选择"]').getByRole('button', { name: '方案 A' })).toBeVisible({ timeout: 15_000 });
  expect(chats).toBe(1);
  // WebKit reports the probe's blocked top.location assignment as a page error. The sandbox still refuses it.
  expect(errors.filter((message) => !message.includes('allow-top-navigation'))).toEqual([]);
});

test('关闭交互页面后历史回复只显示说明和源码', async ({ page, request }) => {
  await page.goto('/#/plan'); await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.getByLabel('向 AI 提问').fill('html 选择题验收'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await htmlBlock(page, '方案选择').scrollIntoViewIfNeeded();
  await expect(page.frameLocator('iframe[title="方案选择"]').getByRole('button', { name: '方案 A' })).toBeVisible({ timeout: 15_000 });
  expect((await request.patch(`${api}/api/settings/html-blocks`, { data: { enabled: false } })).ok()).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.getByText('交互页面已在设置中关闭，只显示源码。').first()).toBeVisible();
  await expect(page.locator('iframe[title="方案选择"]')).toHaveCount(0);
  await expect(page.getByText('方案 A 和方案 B 两个按钮，点选后填入输入框').first()).toBeVisible();
});

test('设置页可以关闭交互页面并修改允许的来源', async ({ page }) => {
  await page.goto('/#/settings/model');
  const section = page.getByRole('region', { name: '交互页面设置' });
  await expect(section.getByLabel('允许加载脚本和样式的来源')).toHaveValue([...defaults, mock].join('\n'));
  await section.getByLabel('允许加载脚本和样式的来源').fill('https://cdn.jsdelivr.net/npm');
  await section.getByRole('button', { name: '保存来源' }).click();
  await expect(page.getByText(/CDN 地址无效/)).toBeVisible();
  await section.getByRole('button', { name: '恢复默认' }).click();
  await expect(section.getByLabel('允许加载脚本和样式的来源')).toHaveValue(defaults.join('\n'));
  await expect(section.getByLabel('允许助手使用交互页面')).toBeEnabled();
  await section.getByLabel('允许助手使用交互页面').uncheck();
  await expect(section.getByLabel('允许助手使用交互页面')).not.toBeChecked();
});

const blockedText = '这个小页面试图离开当前内容，已停止运行。';

function htmlBlock(page: Page, title: string) {
  // h3, not the heading role: a modal marks the inline block aria-hidden, and getByRole would miss it.
  return page.locator('[data-testid="html-block"]').filter({ has: page.locator('h3', { hasText: new RegExp(`^${title}$`) }) });
}

/** Frames load once the block is within 300px of the chat scroller's visible area. */
async function reveal(page: Page, title: string) {
  const block = htmlBlock(page, title);
  await block.scrollIntoViewIfNeeded();
  const iframe = block.locator(`iframe[title="${title}"]`);
  await expect(iframe).toBeVisible({ timeout: 15_000 });
  return { block, iframe, frame: iframe.contentFrame() };
}

async function sendMoveCheck(page: Page) {
  await page.goto('/#/plan');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const composer = page.getByLabel('向 AI 提问');
  await composer.fill('html 搬家验收');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(htmlBlock(page, '甘特图')).toBeVisible({ timeout: 15_000 });
  return composer;
}

/** The early-navigation block always leaves, once it has been scrolled into view. */
async function expectEarlyBlocked(page: Page) {
  const block = htmlBlock(page, '提前跳走');
  await block.scrollIntoViewIfNeeded();
  await expect(block.getByText(blockedText, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('iframe[title="提前跳走"]')).toHaveCount(0);
}

test('换位置后不误报', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '桌面布局');
  test.setTimeout(120_000);
  await sendMoveCheck(page);
  await expectEarlyBlocked(page);
  const gantt = await reveal(page, '甘特图');
  await gantt.frame.getByRole('button', { name: '仅实际' }).click();
  await expect(gantt.frame.locator('#state')).toHaveText('仅实际');
  const moveBefore = await page.evaluate(() => typeof (Element.prototype as any).moveBefore === 'function');

  const settled = async (keepState: boolean) => {
    await page.waitForTimeout(1500);
    await expect(page.getByText(blockedText, { exact: true })).toHaveCount(1);
    await expect(page.locator('iframe[title="甘特图"]')).toHaveCount(1);
    if (keepState) await expect(gantt.frame.locator('#state')).toHaveText('仅实际');
  };

  await page.evaluate(() => { location.hash = '#/inbox'; });
  await settled(moveBefore);
  await page.evaluate(() => { location.hash = '#/plan'; });
  await settled(moveBefore);
  await page.evaluate(() => { location.hash = '#/settings'; });
  await settled(moveBefore);
  // Opening settings moves the host. Without moveBefore that reloads the frame, so re-apply the
  // filter inside the modal; the following tab switches stay in the same slot and must keep it.
  if (!moveBefore) {
    await expect(gantt.frame.locator('#state')).toBeVisible({ timeout: 15_000 });
    if ((await gantt.frame.locator('#state').textContent()) !== '仅实际') {
      await gantt.frame.getByRole('button', { name: '仅实际' }).click();
      await expect(gantt.frame.locator('#state')).toHaveText('仅实际');
    }
  }
  const tabs = page.getByRole('navigation', { name: '工作区设置导航' });
  await tabs.getByRole('button', { name: '回收站', exact: true }).click();
  await settled(true);
  await tabs.getByRole('button', { name: '变更历史', exact: true }).click();
  await settled(true);
  await page.evaluate(() => { location.hash = '#/plan'; });
  await settled(moveBefore);
  await page.evaluate(() => { location.hash = '#/chat'; });
  await settled(moveBefore);
  await page.evaluate(() => { location.hash = '#/plan'; });
  await settled(moveBefore);
});

test('真跳转仍拦截', async ({ page }) => {
  test.setTimeout(90_000);
  await sendMoveCheck(page);
  const external = await reveal(page, '外链');
  await external.block.getByRole('button', { name: '全屏查看' }).click();
  const dialog = page.getByRole('dialog', { name: '外链' });
  const dialogFrame = dialog.locator('iframe[title="外链"]').contentFrame();
  await expect(dialogFrame.getByRole('link', { name: '外链', exact: true })).toBeVisible({ timeout: 15_000 });
  await dialogFrame.getByRole('link', { name: '外链', exact: true }).click();
  await expect(dialog.getByText(blockedText, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(external.block.locator('iframe[title="外链"]')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  await expectEarlyBlocked(page);
  const before = await page.getByText(blockedText, { exact: true }).count();
  await external.frame.getByRole('link', { name: '外链', exact: true }).click();
  await expect(page.locator('iframe[title="外链"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(blockedText, { exact: true })).toHaveCount(before + 1);
});

test('锚点不拦截', async ({ page }) => {
  test.setTimeout(60_000);
  await sendMoveCheck(page);
  const anchor = await reveal(page, '锚点');
  await anchor.frame.getByRole('link', { name: '井号', exact: true }).click();
  await anchor.frame.getByRole('link', { name: '去小节', exact: true }).click();
  expect(await anchor.frame.locator('#sec').evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await anchor.frame.getByRole('link', { name: '空链接', exact: true }).click();
  // WebKit fires an iframe load for a same-document hash change; the ping answer keeps it from being blocked.
  await anchor.frame.getByRole('button', { name: '改 hash', exact: true }).click();
  await expect(anchor.frame.locator('#log')).toContainText('改hash');
  await expect(anchor.frame.locator('#log')).toContainText('井号');
  await expect(anchor.frame.locator('#log')).toContainText('去小节');
  await expect(anchor.frame.locator('#log')).toContainText('空链接');
  await page.waitForTimeout(1500);
  await expect(page.locator('iframe[title="锚点"]')).toHaveCount(1);
  await expect(anchor.frame.locator('#log')).toContainText('井号');
  await expect(anchor.frame.locator('#log')).toContainText('去小节');
  await expect(anchor.frame.locator('#log')).toContainText('空链接');
  await expect(anchor.block.getByText(blockedText, { exact: true })).toHaveCount(0);
});

test('reload 放行', async ({ page }) => {
  test.setTimeout(60_000);
  await sendMoveCheck(page);
  await expectEarlyBlocked(page);
  const before = await page.getByText(blockedText, { exact: true }).count();
  const reload = await reveal(page, '重新加载');
  await expect(reload.frame.locator('#mark')).toHaveText('原样');
  await reload.frame.getByRole('button', { name: '重新加载' }).click();
  await page.waitForTimeout(2000);
  await expect(page.locator('iframe[title="重新加载"]')).toHaveCount(1);
  await expect(reload.frame.locator('#mark')).toHaveText('原样', { timeout: 10_000 });
  await expect(page.getByText(blockedText, { exact: true })).toHaveCount(before);
  await expect(reload.block.getByText(blockedText, { exact: true })).toHaveCount(0);
});

test('随机码读不到', async ({ page }) => {
  test.setTimeout(60_000);
  const composer = await sendMoveCheck(page);
  const probe = await reveal(page, '探针');
  const srcdoc = await probe.iframe.evaluate((el: HTMLIFrameElement) => el.srcdoc);
  const match = srcdoc.match(/var NONCE=("(?:\\.|[^"\\])*")/);
  expect(match).toBeTruthy();
  const nonce = JSON.parse(match![1]);
  await expect(probe.frame.locator('#probe-out')).toContainText('"captured"', { timeout: 15_000 });
  const probeText = await probe.frame.locator('#probe-out').textContent();
  expect(probeText).not.toContain(nonce);
  const data = JSON.parse(probeText ?? '');
  expect(data.captured).toEqual([]);
  expect(data.frameElement).toBe('null');
  expect(data.html).not.toContain(nonce);
  expect(data.scripts).not.toContain(nonce);
  await expect(composer).toHaveValue('');
});

type BlockProbe = { title: string; distance: number; loaded: boolean };

async function probeBlocks(page: Page): Promise<BlockProbe[]> {
  return page.evaluate(() => {
    return [...document.querySelectorAll('[data-testid="html-block"]')].map((block) => {
      const scroller = block.closest('[data-chat-scroll]');
      const title = block.querySelector('h3')?.textContent?.trim() ?? '';
      const loaded = Boolean(block.querySelector('iframe[data-testid="html-block-frame"]'));
      if (!(scroller instanceof HTMLElement)) return { title, distance: Number.POSITIVE_INFINITY, loaded };
      const blockRect = block.getBoundingClientRect();
      const rootRect = scroller.getBoundingClientRect();
      let distance = 0;
      if (blockRect.bottom <= rootRect.top) distance = rootRect.top - blockRect.bottom;
      else if (blockRect.top >= rootRect.bottom) distance = blockRect.top - rootRect.bottom;
      return { title, distance, loaded };
    });
  });
}

function splitLabel(rows: BlockProbe[]) {
  return {
    count: rows.length,
    nearMissing: rows.filter((row) => row.distance <= 280 && !row.loaded).map((row) => `${row.title}@${Math.round(row.distance)}`).sort(),
    farLoaded: rows.filter((row) => row.distance > 450 && row.loaded).map((row) => `${row.title}@${Math.round(row.distance)}`).sort(),
    farUnloaded: rows.some((row) => row.distance > 450 && !row.loaded),
    nearLoaded: rows.some((row) => row.distance <= 280 && row.loaded),
  };
}

/** Frames latch once mounted, so blocks loaded before this check (passed in `seen`) may be far away now. */
async function expectPreloadRule(page: Page, count = 8, seen: ReadonlySet<string> = new Set()) {
  await expect.poll(async () => {
    const label = splitLabel(await probeBlocks(page));
    return { count: label.count, nearMissing: label.nearMissing, farLoaded: label.farLoaded.filter((entry) => !seen.has(entry.slice(0, entry.lastIndexOf('@')))) };
  }, { timeout: 15_000 }).toEqual({ count, nearMissing: [], farLoaded: [] });
}

async function expectLazySplit(page: Page, count = 8) {
  await expectPreloadRule(page, count);
  const label = splitLabel(await probeBlocks(page));
  expect(label.nearLoaded, 'a block inside the preload margin should have a frame').toBe(true);
  expect(label.farUnloaded, 'a block beyond 450px should still be a placeholder').toBe(true);
}

async function scrollTopOf(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-chat-scroll]');
    return el instanceof HTMLElement ? el.scrollTop : -1;
  });
}

async function distanceFromBottom(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-chat-scroll]');
    if (!(el instanceof HTMLElement) || el.clientHeight === 0) return Number.POSITIVE_INFINITY;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
}

async function settleChat(page: Page) {
  await expect(page.getByTestId('ai-assistant').locator('header').getByRole('status')).toHaveText('可用', { timeout: 15_000 });
  await expect.poll(async () => page.evaluate(() => {
    const el = document.querySelector('[data-chat-scroll]');
    if (!(el instanceof HTMLElement) || el.clientHeight === 0) return '';
    const mark = `${el.scrollHeight}|${Math.round(el.scrollTop)}|${el.clientHeight}`;
    const stable = (window as unknown as { __lazyStable?: string }).__lazyStable === mark;
    (window as unknown as { __lazyStable?: string }).__lazyStable = mark;
    return stable ? mark : '';
  }), { timeout: 15_000, intervals: [200] }).not.toBe('');
}

async function openSideAssistant(page: Page) {
  await page.goto('/#/plan');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.getByTestId('ai-assistant')).toBeVisible();
}

async function sendPrompt(page: Page, text: string) {
  await page.getByLabel('向 AI 提问').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

async function wheelScroller(page: Page, deltaY: number) {
  const point = await page.evaluate(() => {
    const scroller = document.querySelector('[data-chat-scroll]');
    if (!(scroller instanceof HTMLElement)) return null;
    const rect = scroller.getBoundingClientRect();
    const usable = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && scroller.contains(hit) && !hit.closest('iframe'));
    };
    for (let y = rect.top + 6; y < rect.bottom - 6; y += 10) {
      if (usable(rect.left + 8, y)) return { x: rect.left + 8, y };
      if (usable(rect.left + rect.width / 2, y)) return { x: rect.left + rect.width / 2, y };
    }
    return { x: rect.left + Math.min(8, rect.width / 2), y: rect.top + Math.min(12, rect.height / 2) };
  });
  expect(point, 'chat scroller is on screen').toBeTruthy();
  const before = await scrollTopOf(page);
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.wheel(0, deltaY);
  await expect.poll(async () => scrollTopOf(page), { timeout: 5_000 }).not.toBe(before);
}

async function scrollTowardUnloaded(page: Page, mobile: boolean) {
  const delta = await page.evaluate(() => {
    const scroller = document.querySelector('[data-chat-scroll]');
    if (!(scroller instanceof HTMLElement)) return 0;
    const root = scroller.getBoundingClientRect();
    let best = 0;
    for (const block of scroller.querySelectorAll('[data-testid="html-block"]')) {
      if (block.querySelector('iframe[data-testid="html-block-frame"]')) continue;
      const rect = block.getBoundingClientRect();
      if (rect.bottom > root.top && rect.top < root.bottom) continue;
      const above = rect.bottom <= root.top ? root.top - rect.bottom : 0;
      const below = rect.top >= root.bottom ? rect.top - root.bottom : 0;
      const distance = above || below;
      if (!distance) continue;
      const signed = (above ? -1 : 1) * distance;
      if (!best || distance < Math.abs(best)) best = signed;
    }
    if (!best) return 0;
    const amount = Math.min(420, Math.max(180, Math.abs(best) - 60));
    return Math.sign(best) * amount;
  });
  if (!delta) return false;
  if (mobile) {
    const before = await scrollTopOf(page);
    await page.locator('[data-chat-scroll]').evaluate((el, dy) => { (el as HTMLElement).scrollTop += dy; }, delta);
    await expect.poll(async () => scrollTopOf(page), { timeout: 5_000 }).not.toBe(before);
  } else {
    await wheelScroller(page, delta);
  }
  return true;
}

async function scrollUntilNewlyLoaded(page: Page, mobile: boolean) {
  const pending = new Set((await probeBlocks(page)).filter((row) => !row.loaded).map((row) => row.title));
  expect(pending.size).toBeGreaterThan(0);
  for (let step = 0; step < 12; step += 1) {
    const seen = new Set((await probeBlocks(page)).filter((row) => row.loaded).map((row) => row.title));
    const moved = await scrollTowardUnloaded(page, mobile);
    expect(moved, 'unloaded blocks are still out of the preload range').toBe(true);
    await expectPreloadRule(page, 8, seen);
    const now = await probeBlocks(page);
    if (now.some((row) => pending.has(row.title) && row.loaded)) return;
  }
  expect(false, 'scrolling toward unloaded blocks never mounted them').toBe(true);
}

/**
 * While a reply arrives the list follows the bottom, so every block passes through view and loads.
 * Blocks the user has never seen only exist after a reload, which renders the history in one go at the bottom.
 */
async function loadLazyHistory(page: Page) {
  await openSideAssistant(page);
  await sendPrompt(page, 'html 懒加载验收');
  await expect(page.locator('[data-testid="html-block"]')).toHaveCount(8, { timeout: 15_000 });
  await settleChat(page);
  await page.reload();
  const open = page.getByRole('button', { name: '打开 AI 助手', exact: true });
  await expect.poll(async () => await open.isVisible() || await page.getByTestId('ai-assistant').isVisible(), { timeout: 15_000 }).toBe(true);
  if (await open.isVisible()) await open.click();
  await expect(page.getByTestId('ai-assistant')).toBeVisible();
  await expect(page.locator('[data-testid="html-block"]')).toHaveCount(8, { timeout: 15_000 });
  await settleChat(page);
  // Opening on the newest message: the last block is in view, the oldest are far above.
  await expect.poll(async () => distanceFromBottom(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
}

test('懒加载：只预加载附近的块', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const mobile = testInfo.project.name === 'mobile';
  await loadLazyHistory(page);
  await expectLazySplit(page);
  await scrollUntilNewlyLoaded(page, mobile);
});

test('懒加载：换位置和收起面板后照常加载', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '桌面布局');
  test.setTimeout(180_000);
  await loadLazyHistory(page);
  await expectLazySplit(page);
  for (const hash of ['#/settings', '#/chat', '#/plan']) {
    const seen = new Set((await probeBlocks(page)).filter((row) => row.loaded).map((row) => row.title));
    await page.evaluate((next) => { location.hash = next; }, hash);
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
    await expect.poll(async () => page.evaluate(() => {
      const el = document.querySelector('[data-chat-scroll]');
      if (!(el instanceof HTMLElement)) return 0;
      const box = el.getBoundingClientRect();
      return box.height > 80 && box.width > 80 ? el.clientHeight : 0;
    }), { timeout: 15_000 }).toBeGreaterThan(80);
    await expect(page.getByText(blockedText, { exact: true })).toHaveCount(0);
    await expectPreloadRule(page, 8, seen);
    await scrollUntilNewlyLoaded(page, false);
    await expect(page.getByText(blockedText, { exact: true })).toHaveCount(0);
  }
  await page.locator('button[title="收起助手"]').click();
  await page.reload();
  await expect(page.locator('[data-testid="html-block"]')).toHaveCount(8, { timeout: 15_000 });
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.getByTestId('ai-assistant')).toBeVisible();
  await expect(page.getByText(blockedText, { exact: true })).toHaveCount(0);
  await expectLazySplit(page);
});

async function frameHeight(page: Page) {
  const frame = page.locator('iframe[title="贴底变高"]');
  if (await frame.count() === 0) return 0;
  return frame.evaluate((el: HTMLIFrameElement) => el.getBoundingClientRect().height);
}

async function restingFrameHeight(page: Page) {
  await expect.poll(async () => frameHeight(page), { timeout: 15_000 }).toBeGreaterThan(200);
  const height = await frameHeight(page);
  expect(height, 'growth should still be pending when the frame first settles').toBeLessThan(500);
  return height;
}

async function atBottomWithRoom(page: Page) {
  await expect.poll(async () => {
    const gap = await distanceFromBottom(page);
    const room = await page.evaluate(() => {
      const el = document.querySelector('[data-chat-scroll]');
      return el instanceof HTMLElement ? el.scrollHeight - el.clientHeight : 0;
    });
    return gap <= 2 && room > 500;
  }, { timeout: 15_000 }).toBe(true);
}

test('贴底：内容变高时停在底部', async ({ page }) => {
  test.setTimeout(90_000);
  await openSideAssistant(page);
  await sendPrompt(page, 'html 贴底验收');
  await expect(page.locator('[data-testid="html-block"]')).toHaveCount(4, { timeout: 15_000 });
  const initial = await restingFrameHeight(page);
  await settleChat(page);
  await expect.poll(async () => distanceFromBottom(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
  await expect.poll(async () => frameHeight(page), { timeout: 15_000 }).toBeGreaterThan(initial + 100);
  expect(await distanceFromBottom(page)).toBeLessThanOrEqual(2);
});

test('贴底：用户往上滚后不抢', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const mobile = testInfo.project.name === 'mobile';
  await openSideAssistant(page);
  await sendPrompt(page, 'html 贴底验收');
  await expect(page.locator('[data-testid="html-block"]')).toHaveCount(4, { timeout: 15_000 });
  await atBottomWithRoom(page);
  const before = await scrollTopOf(page);
  // A small step keeps the growing frame on screen: Chromium stops rendering offscreen cross-origin frames,
  // so a frame scrolled fully out of view would never report its new height.
  if (mobile) await page.locator('[data-chat-scroll]').evaluate((el) => { (el as HTMLElement).scrollBy(0, -150); });
  else await wheelScroller(page, -150);
  await expect.poll(async () => before - await scrollTopOf(page), { timeout: 5_000 }).toBeGreaterThan(2);
  // WebKit animates wheel scrolling, so wait for the user's own scroll to finish before taking the reference.
  await expect.poll(async () => { const first = await scrollTopOf(page); await page.waitForTimeout(300); return first === await scrollTopOf(page); }, { timeout: 5_000 }).toBe(true);
  const top = await scrollTopOf(page);
  const anchor = await growingBlockTop(page);
  expect(await distanceFromBottom(page)).toBeGreaterThan(2);
  const initial = await restingFrameHeight(page);
  await expect.poll(async () => frameHeight(page), { timeout: 15_000 }).toBeGreaterThan(initial + 100);
  // Not pulled down: the growth (about 900px) all lands below the user's position.
  expect(await distanceFromBottom(page)).toBeGreaterThan(600);
  // What the user looks at stays put. A frame above that resizes itself may shift scrollTop through
  // scroll anchoring (WebKit does this), which keeps the visible content still, so either measure may hold.
  const scrollStill = Math.abs((await scrollTopOf(page)) - top) <= 2;
  const viewStill = Math.abs((await growingBlockTop(page)) - anchor) <= 2;
  expect(scrollStill || viewStill, `scrollTop ${top} -> ${await scrollTopOf(page)}, block top ${anchor} -> ${await growingBlockTop(page)}`).toBe(true);
});

/** Top of the growing block relative to the chat scroller's visible area. */
async function growingBlockTop(page: Page) {
  return page.locator('[data-testid="html-block"]').filter({ has: page.locator('h3', { hasText: /^贴底变高$/ }) }).evaluate((block) => {
    const scroller = block.closest('[data-chat-scroll]');
    return block.getBoundingClientRect().top - (scroller instanceof HTMLElement ? scroller.getBoundingClientRect().top : 0);
  });
}
