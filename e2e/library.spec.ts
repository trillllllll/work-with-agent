import { mkdir } from 'node:fs/promises';
import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = 'http://127.0.0.1:3015';
const shots = '/tmp/wwa-library-shots';

async function command(request: APIRequestContext, commands: unknown[]) {
  const response = await request.post(`${base}/api/v1/commands`, { data: { requestId: crypto.randomUUID(), commands } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data.results[0];
}

async function createMaterial(request: APIRequestContext, title: string, content: string) {
  return command(request, [{ kind: 'material.create', input: { topicId: null, kind: 'text', title, content } }]) as Promise<{ id: string }>;
}

test.beforeAll(() => mkdir(shots, { recursive: true }));
test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    localStorage.setItem('agent-studio.theme', 'light');
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
  });
});
test.afterAll(() => e2eDatabase.$disconnect());

async function openLibrary(page: Page) {
  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
}

test('桌面三栏按资料模块宽度测量，窄屏收起文件夹', async ({ page, request }) => {
  const material = await createMaterial(request, '布局合同', '用于测量三栏宽度的正文');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openLibrary(page);
  await page.getByTestId(`library-row-${material.id}`).click();

  const surface = page.getByTestId('library-surface');
  const folders = page.getByTestId('library-folders');
  const preview = page.getByTestId('library-preview');
  await expect(folders).toBeVisible();
  await expect(preview).toBeVisible();
  const fw = (await folders.boundingBox())!.width;
  const pw = (await preview.boundingBox())!.width;
  expect(Math.abs(fw - 208)).toBeLessThanOrEqual(1);
  expect(Math.abs(pw - 360)).toBeLessThanOrEqual(1);
  await expect(surface).toHaveCSS('background-color', 'rgb(245, 245, 245)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('library-folders')).toBeHidden();
  await expect(page.getByRole('button', { name: '文件夹', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test('一次选择三个文件后出现三份资料', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  await page.locator('input[aria-label="选择文件"]').setInputFiles([
    { name: '甲文件.txt', mimeType: 'text/plain', buffer: Buffer.from('甲文件正文') },
    { name: '乙文件.txt', mimeType: 'text/plain', buffer: Buffer.from('乙文件正文') },
    { name: '丙文件.txt', mimeType: 'text/plain', buffer: Buffer.from('丙文件正文') },
  ]);
  await expect(page.getByText('已添加 3 份资料，0 份失败', { exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: /甲文件/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /乙文件/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /丙文件/ })).toBeVisible();
});

test('中文输入过程不搜索，旧的慢响应不覆盖新结果', async ({ page, request }) => {
  const first = await createMaterial(request, '甲材料独特', '甲材料独特的正文');
  const second = await createMaterial(request, '乙材料独特', '乙材料独特的正文');
  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  const search = page.getByLabel('搜索资料', { exact: true });
  let searches = 0;
  await page.route('**/api/v1/library/search**', async (route) => {
    searches += 1;
    const query = new URL(route.request().url()).searchParams.get('q') ?? '';
    if (query.includes('甲材料')) await new Promise((resolve) => setTimeout(resolve, 900));
    await route.continue();
  });

  await search.focus();
  await search.evaluate((node) => node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await search.fill('甲材料独特');
  await page.waitForTimeout(350);
  expect(searches).toBe(0);
  await search.evaluate((node) => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: (node as HTMLInputElement).value })));
  await expect.poll(() => searches).toBeGreaterThan(0);

  await search.fill('乙材料独特');
  await expect(page.getByTestId(`library-row-${second.id}`)).toBeVisible();
  await expect(page.getByTestId(`library-row-${first.id}`)).toHaveCount(0);
  await page.waitForTimeout(1100);
  await expect(page.getByTestId(`library-row-${second.id}`)).toBeVisible();
  await expect(page.getByTestId(`library-row-${first.id}`)).toHaveCount(0);
});

test('关闭预览后焦点回到资料行，离开任务后保留搜索和选中项', async ({ page, request }) => {
  const task = await request.post(`${base}/api/tasks`, { data: { title: '从资料打开的任务' } });
  expect(task.ok(), await task.text()).toBe(true);
  const taskId = (await task.json()).data.id as string;
  const material = await createMaterial(request, '可返回的资料', '返回后仍应选中');
  const detail = await request.get(`${base}/api/v1/library/materials/${material.id}`);
  const current = (await detail.json()).data;
  const linked = await request.post(`${base}/api/v1/commands`, { data: { requestId: crypto.randomUUID(), commands: [{ kind: 'material.links', targetId: material.id, expectedRevision: current.revision, input: { expectedOrganizationRevision: current.organizationRevision, addTaskIds: [taskId], removeTaskIds: [], removeInlineReferences: false, expectedTaskRevisions: {} } }] } });
  expect(linked.ok(), await linked.text()).toBe(true);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await openLibrary(page);
  const row = page.getByTestId(`library-row-${material.id}`);
  await row.click();
  await expect(page.getByTestId('library-preview')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('library-preview')).toBeHidden();
  await expect(row).toBeFocused();

  await row.click();
  const search = page.getByLabel('搜索资料', { exact: true });
  await search.fill('可返回的资料');
  await page.getByLabel('类型筛选', { exact: true }).selectOption('text');
  await page.getByRole('button', { name: '从资料打开的任务', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '任务详情', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(search).toHaveValue('可返回的资料');
  await expect(page.getByLabel('类型筛选', { exact: true })).toHaveValue('text');
  await expect(page.getByTestId('library-preview')).toBeVisible();
  await expect(row).toHaveAttribute('aria-selected', 'true');
});

test('亮色和暗色在三种宽度下都没有横向溢出', async ({ page, request }) => {
  const material = await createMaterial(request, '截图资料', '三种宽度都要能看见资料库');
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((value) => localStorage.setItem('agent-studio.theme', value), theme);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await openLibrary(page);
    await page.evaluate((value) => localStorage.setItem('agent-studio.theme', value), theme);
    await page.reload();
    await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
    await page.getByTestId(`library-row-${material.id}`).click();
    await expect(page.getByTestId('library-preview')).toBeVisible();
    for (const width of [1600, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      if (width !== 1600) await page.keyboard.press('Escape');
      await expect(page.getByTestId('library-surface')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `${shots}/${theme}-${width}.png`, fullPage: false });
      if (width !== 1600) await page.getByTestId(`library-row-${material.id}`).click();
    }
  }
});
