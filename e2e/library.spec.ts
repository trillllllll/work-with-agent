import { mkdir, readFile } from 'node:fs/promises';
import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
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

async function readMaterial(request: APIRequestContext, id: string) {
  const response = await request.get(`${base}/api/v1/library/materials/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as { id: string; revision: number; organizationRevision: number; folderId: string | null; tags: Array<{ id: string; name: string }> };
}

async function createFolder(request: APIRequestContext, name: string, parentId: string | null = null) {
  return command(request, [{ kind: 'libraryFolder.create', input: { parentId, name } }]) as Promise<{ id: string }>;
}

async function createTag(request: APIRequestContext, name: string) {
  return command(request, [{ kind: 'libraryTag.create', input: { name } }]) as Promise<{ id: string }>;
}

async function organize(request: APIRequestContext, id: string, input: { folderId?: string | null; tagIds?: string[] }) {
  const current = await readMaterial(request, id);
  await command(request, [{ kind: 'material.organize', targetId: id, expectedRevision: current.revision, input: { expectedOrganizationRevision: current.organizationRevision, ...input } }]);
}

test('一百二十一份资料翻到第101份，引用框能搜到那份正文', async ({ page, request }) => {
  test.setTimeout(120_000);
  const materials: Array<{ id: string }> = [];
  for (let n = 1; n <= 121; n += 1) {
    const title = `资料 ${String(n).padStart(3, '0')}`;
    const content = n === 101 ? '只有第101份正文包含的词' : `${title} 的正文`;
    const created = await createMaterial(request, title, content);
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 122 - n)).toISOString();
    await e2eDatabase.material.update({ where: { id: created.id }, data: { createdAt: stamp, updatedAt: stamp } });
    materials.push(created);
  }
  const material101 = materials[100]!;
  const created = await request.post(`${base}/api/tasks`, { data: { title: '翻页后引用' } });
  expect(created.ok(), await created.text()).toBe(true);
  const taskId = (await created.json()).data.id as string;

  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  const pager = page.getByTestId('library-pagination');
  await expect(pager).toContainText('共 121 份资料');
  await pager.getByRole('button', { name: '下一页', exact: true }).click();
  await pager.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByTestId(`library-row-${material101.id}`)).toBeVisible();

  await expect.poll(async () => {
    const response = await request.get(`${base}/api/v1/library/search?q=${encodeURIComponent('只有第101份正文包含的词')}&limit=40`);
    const items = (await response.json()).data?.items ?? [];
    return items.some((item: { id?: string }) => item.id === material101.id);
  }, { timeout: 60_000 }).toBe(true);

  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${taskId}`).click();
  await page.getByRole('button', { name: '引用已有资料', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '引用已有资料', exact: true });
  await picker.getByRole('textbox', { name: '搜索资料', exact: true }).fill('只有第101份正文包含的词');
  await expect(picker.getByTestId(`material-picker-row-${material101.id}`)).toBeVisible({ timeout: 60_000 });
});

test('搜索后批量移动，整理版本冲突时对话框保持打开', async ({ page, request }) => {
  test.setTimeout(60_000);
  const folder = await createFolder(request, '批次文件夹');
  const material = await createMaterial(request, '批次移动独特词', '批次移动独特词 的正文');
  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  await page.getByLabel('搜索资料', { exact: true }).fill('批次移动独特词');
  const row = page.getByTestId(`library-row-${material.id}`);
  await expect(row).toBeVisible();
  await row.getByRole('checkbox', { name: '选择 批次移动独特词', exact: true }).check();
  await page.getByRole('button', { name: '移动', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量整理', exact: true });
  await dialog.getByLabel('移动到文件夹', { exact: true }).selectOption(folder.id);
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await readMaterial(request, material.id)).folderId).toBe(folder.id);

  const conflicted = await createMaterial(request, '冲突整理独特词', '冲突整理独特词 的正文');
  const tag = await createTag(request, '冲突标签');
  await page.getByLabel('搜索资料', { exact: true }).fill('冲突整理独特词');
  const conflictRow = page.getByTestId(`library-row-${conflicted.id}`);
  await expect(conflictRow).toBeVisible();
  await conflictRow.getByRole('checkbox', { name: '选择 冲突整理独特词', exact: true }).check();
  const loaded = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/v1/library/materials/${conflicted.id}`);
  await page.getByRole('button', { name: '移动', exact: true }).click();
  await loaded;
  const conflictDialog = page.getByRole('dialog', { name: '批量整理', exact: true });
  await conflictDialog.getByLabel('移动到文件夹', { exact: true }).selectOption(folder.id);
  let bumped = false;
  await page.route('**/api/v1/commands', async (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON() as { commands?: Array<{ targetId?: string; expectedRevision?: number; input?: { expectedOrganizationRevision?: number } }> } | null;
    const issued = body?.commands?.find((item) => item.targetId === conflicted.id);
    if (url.pathname === '/api/v1/commands' && !bumped && issued?.input?.expectedOrganizationRevision) {
      bumped = true;
      const bump = await request.post(`${base}/api/v1/commands`, { data: { requestId: crypto.randomUUID(), commands: [{ kind: 'material.organize', targetId: conflicted.id, expectedRevision: issued.expectedRevision, input: { expectedOrganizationRevision: issued.input.expectedOrganizationRevision, tagIds: [tag.id] } }] } });
      expect(bump.ok(), await bump.text()).toBe(true);
    }
    await route.continue();
  });
  await conflictDialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect(conflictDialog).toBeVisible();
  await expect(conflictDialog).toContainText(/已完成 \d+ 份，\d+ 份未完成/);
  await expect(conflictRow.getByRole('checkbox', { name: '选择 冲突整理独特词', exact: true })).toBeChecked();
  await page.unroute('**/api/v1/commands');
});

test('窄资料库的搜索框铺满模块宽度', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLibrary(page);
  const surface = await page.getByTestId('library-surface').boundingBox();
  const search = await page.getByLabel('搜索资料', { exact: true }).boundingBox();
  expect(surface).toBeTruthy();
  expect(search).toBeTruthy();
  expect(search!.width).toBeGreaterThanOrEqual(surface!.width - 34);
  expect(search!.height).toBeGreaterThanOrEqual(44);
});

test('引用打开旧版本，而不是替换后的最新版', async ({ page, request }) => {
  test.setTimeout(120_000);
  const phrase = '旧版独有词甲';
  const settings = await request.patch(`${base}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  expect(settings.ok(), await settings.text()).toBe(true);
  const material = await createMaterial(request, '可引用旧版', `${phrase} 在第一版正文`);
  let indexedChunk = '';
  await expect.poll(async () => {
    const content = await request.get(`${base}/api/v1/library/materials/${material.id}/content?revision=1&limit=40`);
    const id = (await content.json()).data?.items?.[0]?.id as string | undefined;
    if (!id) return '';
    const found = await request.get(`${base}/api/v1/library/search?q=${encodeURIComponent(phrase)}&limit=40`);
    const items = (await found.json()).data?.items ?? [];
    if (!items.some((item: { id?: string }) => item.id === material.id)) return '';
    indexedChunk = id;
    return id;
  }, { timeout: 60_000 }).not.toBe('');

  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  await page.getByRole('button', { name: '问资料', exact: true }).click();
  const ask = page.getByRole('dialog', { name: '问资料', exact: true });
  await ask.getByLabel('向资料提问', { exact: true }).fill(phrase);
  const answered = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/library/answers');
  await ask.getByRole('button', { name: '提问', exact: true }).click();
  const payload = await (await answered).json();
  const citation = (payload.data?.citations ?? []).find((item: { id?: string }) => item.id === 'C1');
  expect(citation?.revision).toBe(1);
  expect(citation?.chunkId).toBe(indexedChunk);
  const current = await readMaterial(request, material.id);
  await command(request, [{ kind: 'material.update', targetId: material.id, expectedRevision: current.revision, input: { content: '第二版正文已经换掉' } }]);
  await ask.getByRole('button', { name: /^C1 ·/ }).click();
  await expect(page.getByTestId('library-preview-version')).toHaveText('版本 1');
  const chunk = page.getByTestId(`library-chunk-${citation.chunkId}`);
  await expect(chunk).toBeVisible();
  await expect(chunk).toHaveAttribute('data-highlighted', 'true');
});

test('空资料库新建的标签可以马上用于整理', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  await page.getByLabel('新标签名称', { exact: true }).fill('空库标签');
  await page.getByRole('button', { name: '新建标签', exact: true }).click();
  await expect(page.getByRole('button', { name: '空库标签', exact: true })).toBeVisible();
  const material = await createMaterial(request, '待贴标签', '待贴标签 的正文');
  await page.reload();
  await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: '选择 待贴标签', exact: true }).check();
  await page.getByTestId('library-surface').getByRole('button', { name: '标签', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量整理', exact: true });
  await expect(dialog.getByRole('checkbox', { name: '空库标签', exact: true })).toBeVisible();
  expect(material.id).toBeTruthy();
});

test('重命名和移动文件夹后资料仍在原文件夹', async ({ page, request }) => {
  const parent = await createFolder(request, '父文件夹');
  const folder = await createFolder(request, '子文件夹');
  const material = await createMaterial(request, '文件夹里的资料', '文件夹里的资料正文');
  await organize(request, material.id, { folderId: folder.id });
  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  await page.getByRole('button', { name: '更多 子文件夹', exact: true }).click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '重命名文件夹', exact: true });
  await rename.getByLabel('文件夹名称', { exact: true }).fill('子文件夹已改名');
  await rename.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '更多 子文件夹已改名', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '更多 子文件夹已改名', exact: true }).click();
  await page.getByRole('menuitem', { name: '移动', exact: true }).click();
  const move = page.getByRole('dialog', { name: '移动文件夹', exact: true });
  await move.getByLabel('移动到文件夹', { exact: true }).selectOption(parent.id);
  await move.getByRole('button', { name: '保存', exact: true }).click();
  await expect(move).toBeHidden();
  const current = await readMaterial(request, material.id);
  expect(current.id).toBe(material.id);
  expect(current.folderId).toBe(folder.id);
});

test('批量移除一个标签时保留另一个', async ({ page, request }) => {
  const keep = await createTag(request, '保留甲');
  const drop = await createTag(request, '去掉乙');
  const material = await createMaterial(request, '双标签资料', '双标签资料正文');
  await organize(request, material.id, { tagIds: [keep.id, drop.id] });
  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  await page.getByRole('checkbox', { name: '选择 双标签资料', exact: true }).check();
  await page.getByTestId('library-surface').getByRole('button', { name: '标签', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量整理', exact: true });
  await dialog.getByRole('checkbox', { name: '去掉乙', exact: true }).check();
  await dialog.getByRole('radio', { name: '移除选中标签', exact: true }).check();
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect(dialog).toBeHidden();
  const current = await readMaterial(request, material.id);
  expect(current.tags.map((tag) => tag.name)).toEqual(['保留甲']);
});

test('文本资料预览显示原件正文', async ({ page, request }) => {
  const material = await createMaterial(request, '原件可见', '原件正文可见甲');
  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  await page.getByTestId(`library-row-${material.id}`).click();
  await expect(page.getByTestId('library-preview')).toContainText('原件正文可见甲');
});

test('会话资料带着空解析位置时预览仍显示正文', async ({ page, request }) => {
  const created = await command(request, [{ kind: 'material.create', input: { topicId: null, kind: 'thread', title: '会话摘录可见', content: '会话正文可见乙', metadata: { completeness: 'excerpt' } } }]) as { id: string };
  const extraction = await e2eDatabase.materialExtraction.findFirstOrThrow({ where: { materialId: created.id } });
  await e2eDatabase.materialExtraction.update({
    where: { id: extraction.id },
    data: {
      status: 'unsupported',
      errorCode: 'UNSUPPORTED',
      errorsJson: JSON.stringify([{ locator: null, code: 'UNSUPPORTED', message: '暂不支持此格式的正文解析' }]),
      leaseToken: null,
      generation: { increment: 100 },
    },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('agent-studio.theme', 'dark'); });
  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  await page.getByTestId(`library-row-${created.id}`).click();
  const preview = page.getByTestId('library-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('heading', { name: '会话摘录可见' })).toBeVisible();
  await expect(preview.getByRole('button', { name: '关闭', exact: true })).toBeVisible();
  await expect(preview).toContainText('会话正文可见乙');
  await expect(preview).toContainText('暂不支持此格式的正文解析');
  await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
  expect(errors.join('\n')).not.toMatch(/locator/);

  await page.setViewportSize({ width: 700, height: 800 });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('会话正文可见乙');
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(preview).toBeHidden();

  const text = await createMaterial(request, '文本仍可预览', '文本正文仍在');
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.getByTestId(`library-row-${text.id}`).click();
  await expect(page.getByTestId('library-preview')).toContainText('文本正文仍在');
  await page.getByTestId('library-preview').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByTestId('library-preview')).toBeHidden();
});

test('搜索失败时显示重试，而不是空列表文案', async ({ page, request }) => {
  await createMaterial(request, '仍在库里', '仍在库里的正文');
  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  await page.route('**/api/v1/library/search**', (route) => route.abort());
  await page.getByLabel('搜索资料', { exact: true }).fill('不会返回');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await expect(page.getByText('没有找到资料')).toHaveCount(0);
  await page.unroute('**/api/v1/library/search**');
});

test('第101个片段可以显示，下载原文与原件字节一致', async ({ page, request }) => {
  test.setTimeout(120_000);
  const marker = '第101段标记词';
  // Width 1200 and overlap 200 step by 1000. Ordinal 100 starts at code point
  // 100000, but the previous window already covers through 100200, so the body
  // has to be longer than that or the 101st chunk is never created.
  const content = `${'甲'.repeat(100_000)}${marker}${'乙'.repeat(400)}`;
  const material = await createMaterial(request, '超过一百个片段', content);
  let chunkId = '';
  await expect.poll(async () => {
    const response = await request.get(`${base}/api/v1/library/materials/${material.id}/content?revision=1&cursor=80&limit=40`);
    if (!response.ok()) return '';
    const items = (await response.json()).data?.items as Array<{ id: string; ordinal: number; text: string }> | undefined;
    const hit = items?.find((item) => item.ordinal === 100 && item.text.includes(marker));
    chunkId = hit?.id ?? '';
    return chunkId;
  }, { timeout: 60_000 }).not.toBe('');
  const source = await request.get(`${base}/api/v1/library/materials/${material.id}/versions/1/source`);
  const sourceText = await source.text();
  expect(source.ok(), sourceText).toBe(true);
  expect(source.headers()['content-type']).toContain('text/plain');
  expect(sourceText).toBe(content);

  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  await page.getByTestId(`library-row-${material.id}`).click();
  const preview = page.getByTestId('library-preview');
  const downloaded = page.waitForEvent('download');
  await preview.getByRole('button', { name: '下载', exact: true }).click();
  expect(await readFile(await (await downloaded).path(), 'utf8')).toBe(content);
  await preview.getByRole('tab', { name: '提取文字', exact: true }).click();
  const chunk = preview.getByTestId(`library-chunk-${chunkId}`);
  for (let step = 0; step < 4 && await chunk.count() === 0; step += 1) {
    const more = preview.getByRole('button', { name: '继续加载', exact: true });
    await expect(more).toBeVisible();
    const arrived = page.waitForResponse((response) => response.url().includes(`/materials/${material.id}/content`) && response.ok());
    await more.click();
    const body = await (await arrived).json() as { data?: { items?: Array<{ id: string }> } };
    const firstId = body.data?.items?.[0]?.id ?? '';
    expect(firstId, '继续加载没有返回片段').not.toBe('');
    await expect(preview.getByTestId(`library-chunk-${firstId}`)).toBeAttached({ timeout: 15_000 });
  }
  await chunk.scrollIntoViewIfNeeded();
  await expect(chunk).toBeVisible();
  await expect(chunk).toContainText(marker);
});

test('历史版本使用自己的类型预览和下载', async ({ page, request }) => {
  test.setTimeout(60_000);
  const original = '第一版原文甲乙';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const material = await createMaterial(request, '版本类型会变', original);
  const current = await readMaterial(request, material.id);
  await command(request, [{ kind: 'material.update', targetId: material.id, expectedRevision: current.revision, input: { content: '第二版说明', fileName: '第二版.png', mimeType: 'image/png', attachmentBase64: png.toString('base64') } }]);
  const latest = await request.get(`${base}/api/v1/library/materials/${material.id}/versions/2/source`);
  const latestText = await latest.text();
  expect(latest.ok(), latestText).toBe(true);
  const described = JSON.parse(latestText).data as { kind: string; mimeType: string; fileName: string };
  expect(described).toMatchObject({ kind: 'attachment', mimeType: 'image/png', fileName: '第二版.png' });

  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  await page.getByTestId(`library-row-${material.id}`).click();
  const preview = page.getByTestId('library-preview');
  await expect(preview.getByTestId('library-preview-version')).toHaveText('版本 2');
  await expect(preview.getByRole('img', { name: '第二版.png', exact: true })).toBeVisible();
  const imageDownload = page.waitForEvent('download');
  await preview.getByRole('button', { name: '下载', exact: true }).click();
  const imageFile = await imageDownload;
  expect(Buffer.compare(await readFile(await imageFile.path()), png)).toBe(0);
  expect(imageFile.suggestedFilename()).toBe('第二版.png');

  await preview.getByRole('button', { name: /^版本 1/ }).click();
  await expect(preview.getByTestId('library-preview-version')).toHaveText('版本 1');
  await expect(preview.getByText(original, { exact: true })).toBeVisible();
  await expect(preview.getByRole('img')).toHaveCount(0);
  const textDownload = page.waitForEvent('download');
  await preview.getByRole('button', { name: '下载', exact: true }).click();
  const textFile = await textDownload;
  expect(await readFile(await textFile.path(), 'utf8')).toBe(original);
});

test('第41个关联任务要通过下一页才能看到', async ({ page, request }) => {
  test.setTimeout(90_000);
  const material = await createMaterial(request, '多关联资料', '这份资料关联了超过一页任务');
  const taskIds: string[] = [];
  for (let n = 1; n <= 41; n += 1) {
    const created = await request.post(`${base}/api/tasks`, { data: { title: `关联页任务 ${String(n).padStart(2, '0')}` } });
    const createdBody = await created.json() as { data?: { id?: string } };
    expect(created.ok(), JSON.stringify(createdBody)).toBe(true);
    taskIds.push(createdBody.data?.id ?? '');
  }
  const detail = await readMaterial(request, material.id);
  await command(request, [{
    kind: 'material.links',
    targetId: material.id,
    expectedRevision: detail.revision,
    input: {
      expectedOrganizationRevision: detail.organizationRevision,
      addTaskIds: taskIds,
      removeTaskIds: [],
      removeInlineReferences: false,
      expectedTaskRevisions: {},
    },
  }]);
  const first = await request.get(`${base}/api/v1/library/materials/${material.id}/tasks?limit=40&cursor=0`);
  const second = await request.get(`${base}/api/v1/library/materials/${material.id}/tasks?limit=40&cursor=40`);
  expect(first.ok() && second.ok()).toBe(true);
  const pageOne = (await first.json()).data as { items: Array<{ id: string; title: string }>; total: number; nextCursor: number | null };
  const pageTwo = (await second.json()).data as { items: Array<{ id: string; title: string }>; total: number; nextCursor: number | null };
  expect(pageOne.total).toBe(41);
  expect(pageOne.nextCursor).toBe(40);
  expect(pageTwo.items).toHaveLength(1);
  const hidden = pageTwo.items[0]!;
  const shown = pageOne.items[0]!;

  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  await page.getByTestId(`library-row-${material.id}`).click();
  const preview = page.getByTestId('library-preview');
  const pager = preview.getByTestId('library-linked-tasks-pagination');
  await expect(pager).toContainText('共 41 个任务');
  await expect(preview.getByTestId(`library-linked-task-${shown.id}`)).toBeVisible();
  await expect(preview.getByTestId(`library-linked-task-${hidden.id}`)).toHaveCount(0);
  const nextPage = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/v1/library/materials/${material.id}/tasks` && url.searchParams.get('cursor') === '40' && response.ok();
  });
  await pager.getByRole('button', { name: '下一页', exact: true }).click();
  await nextPage;
  await expect(preview.getByTestId(`library-linked-task-${hidden.id}`)).toBeVisible();
  await expect(preview.getByRole('button', { name: hidden.title, exact: true })).toBeVisible();
  await expect(preview.getByTestId(`library-linked-task-${shown.id}`)).toHaveCount(0);
});

test('批量关联可以搜索任务名称，并一次选中多个带清单和状态的任务', async ({ page, request }) => {
  const topic = await request.post(`${base}/api/topics`, { data: { name: '海盐清单' } });
  const topicBody = await topic.json() as { data?: { id?: string } };
  expect(topic.ok(), JSON.stringify(topicBody)).toBe(true);
  const topicId = topicBody.data?.id ?? '';
  const first = await request.post(`${base}/api/tasks`, { data: { title: '海盐关联甲', topicId } });
  const second = await request.post(`${base}/api/tasks`, { data: { title: '海盐关联乙', topicId } });
  const decoy = await request.post(`${base}/api/tasks`, { data: { title: '胡椒无关任务' } });
  expect(first.ok() && second.ok() && decoy.ok()).toBe(true);
  const firstId = (await first.json()).data.id as string;
  const secondId = (await second.json()).data.id as string;
  const decoyId = (await decoy.json()).data.id as string;
  const doing = await request.patch(`${base}/api/tasks/${secondId}`, { data: { status: 'doing' } });
  expect(doing.ok(), await doing.text()).toBe(true);
  const material = await createMaterial(request, '批量关联资料', '等待关联到两个任务');

  await page.setViewportSize({ width: 1400, height: 900 });
  await openLibrary(page);
  const row = page.getByTestId(`library-row-${material.id}`);
  await expect(row).toBeVisible();
  await row.getByRole('checkbox', { name: '选择 批量关联资料', exact: true }).check();
  await page.getByRole('button', { name: '关联任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量整理', exact: true });
  await dialog.getByRole('textbox', { name: '搜索任务', exact: true }).fill('海盐关联');
  const rowA = dialog.getByTestId(`task-picker-row-${firstId}`);
  const rowB = dialog.getByTestId(`task-picker-row-${secondId}`);
  await expect(rowA).toBeVisible();
  await expect(rowA).toContainText('海盐清单');
  await expect(rowA).toContainText('待办');
  await expect(rowB).toContainText('海盐清单');
  await expect(rowB).toContainText('进行中');
  await expect(dialog.getByTestId(`task-picker-row-${decoyId}`)).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: '选择 海盐关联甲', exact: true }).check();
  await dialog.getByRole('checkbox', { name: '选择 海盐关联乙', exact: true }).check();
  await expect(dialog).toContainText('已选 2 个任务');
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect(dialog).toBeHidden();

  const linked = await request.get(`${base}/api/v1/library/materials/${material.id}/tasks?limit=40`);
  const linkedBody = await linked.json() as { data?: { items?: Array<{ id: string }> } };
  expect(linked.ok(), JSON.stringify(linkedBody)).toBe(true);
  const ids = (linkedBody.data?.items ?? []).map((item) => item.id).sort();
  expect(ids).toEqual([firstId, secondId].sort());
});

test('预览里可以一次关联多个任务', async ({ page, request }) => {
  const topic = await request.post(`${base}/api/topics`, { data: { name: '预览清单' } });
  const topicBody = await topic.json() as { data?: { id?: string } };
  expect(topic.ok(), JSON.stringify(topicBody)).toBe(true);
  const topicId = topicBody.data?.id ?? '';
  const first = await request.post(`${base}/api/tasks`, { data: { title: '预览关联甲', topicId } });
  const second = await request.post(`${base}/api/tasks`, { data: { title: '预览关联乙', topicId } });
  expect(first.ok() && second.ok()).toBe(true);
  const firstId = (await first.json()).data.id as string;
  const secondId = (await second.json()).data.id as string;
  const doing = await request.patch(`${base}/api/tasks/${secondId}`, { data: { status: 'doing' } });
  expect(doing.ok(), await doing.text()).toBe(true);
  const blocked = await request.patch(`${base}/api/tasks/${secondId}`, { data: { status: 'blocked' } });
  expect(blocked.ok(), await blocked.text()).toBe(true);
  const material = await createMaterial(request, '预览多选资料', '从预览一次关联两件任务');

  await page.setViewportSize({ width: 1600, height: 1000 });
  await openLibrary(page);
  await page.getByTestId(`library-row-${material.id}`).click();
  const preview = page.getByTestId('library-preview');
  await preview.getByRole('textbox', { name: '搜索任务', exact: true }).fill('预览关联');
  const rowB = preview.getByTestId(`task-picker-row-${secondId}`);
  await expect(rowB).toBeVisible();
  await expect(rowB).toContainText('预览清单');
  await expect(rowB).toContainText('已阻塞');
  await preview.getByRole('checkbox', { name: '选择 预览关联甲', exact: true }).check();
  await preview.getByRole('checkbox', { name: '选择 预览关联乙', exact: true }).check();
  await preview.getByRole('button', { name: '关联', exact: true }).click();
  await expect(preview.getByTestId(`library-linked-task-${firstId}`)).toBeVisible();
  await expect(preview.getByTestId(`library-linked-task-${secondId}`)).toBeVisible();

  const linked = await request.get(`${base}/api/v1/library/materials/${material.id}/tasks?limit=40`);
  const linkedBody = await linked.json() as { data?: { items?: Array<{ id: string }> } };
  expect(linked.ok(), JSON.stringify(linkedBody)).toBe(true);
  const ids = (linkedBody.data?.items ?? []).map((item) => item.id).sort();
  expect(ids).toEqual([firstId, secondId].sort());
});
