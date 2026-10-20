import { test, expect } from './fixtures.js';
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
  const choice = page.frameLocator('iframe[title="方案选择"]');
  await expect(choice.getByRole('button', { name: '方案 B' })).toBeVisible();
  await expect(page.locator('iframe[title="方案选择"]')).toHaveAttribute('sandbox', 'allow-scripts');

  // Every probe inside the page runs with the sandbox and CSP in force.
  await expect(choice.locator('#probe')).toContainText('"done":"yes"', { timeout: 15_000 });
  const probe = JSON.parse(await choice.locator('#probe').textContent() ?? '{}');
  for (const key of ['fetch', 'xhr', 'websocket', 'image', 'parent', 'top', 'storage', 'cookie', 'eval']) expect(probe[key], key).toMatch(/^blocked:/);
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
  await page.frameLocator('iframe[title="跳转测试"]').getByRole('button', { name: '离开这里' }).click();
  await expect(page.getByText('这个小页面试图离开当前内容，已停止运行。')).toBeVisible();
  await expect(page.locator('iframe[title="跳转测试"]')).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.frameLocator('iframe[title="方案选择"]').getByRole('button', { name: '方案 A' })).toBeVisible();
  expect(chats).toBe(1);
  expect(errors).toEqual([]);
});

test('关闭交互页面后历史回复只显示说明和源码', async ({ page, request }) => {
  await page.goto('/#/plan'); await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.getByLabel('向 AI 提问').fill('html 选择题验收'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.frameLocator('iframe[title="方案选择"]').getByRole('button', { name: '方案 A' })).toBeVisible();
  expect((await request.patch(`${api}/api/settings/html-blocks`, { data: { enabled: false } })).ok()).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.getByText('交互页面已在设置中关闭，只显示源码。').first()).toBeVisible();
  await expect(page.locator('iframe[title="方案选择"]')).toHaveCount(0);
  await expect(page.getByText('方案 A 和方案 B 两个按钮，点选后填入输入框').first()).toBeVisible();
});

test('设置页可以关闭交互页面并修改允许的来源', async ({ page }) => {
  await page.goto('/#/settings');
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
