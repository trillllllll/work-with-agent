import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const api = 'http://127.0.0.1:3015';
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

/** Frames stay on the lazy placeholder until they intersect the viewport. */
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
