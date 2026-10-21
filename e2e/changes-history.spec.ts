import type { Locator } from '@playwright/test';
import type { Prisma } from '@prisma/client';
import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = 'http://127.0.0.1:3015';
const totalRecords = 320;
const pasteId = 'paste-target-id-0001';
const undoTitle = '星港可撤销周报';

test.use({ timezoneId: 'Asia/Shanghai' });
// react-grab 是开发态遮罩，手机会盖住全屏对话框底部的「查看结果」。
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.beforeEach(async ({ request }) => {
  await resetE2eDatabase();
  seeded.taskId = await seedChanges(request);
});
test.afterAll(() => e2eDatabase.$disconnect());

const seeded = { taskId: '' };

function shanghaiMidnight(offsetDays: number) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(pick('year'), pick('month') - 1, pick('day') + offsetDays, -8, 0, 0);
}

function snapshots(name: string, field: 'title' | 'name' | 'status' = 'title', before = '旧值', after = '新值') {
  const key = field === 'name' ? 'name' : field === 'status' ? 'status' : 'title';
  const titled = field === 'status' ? { title: name, status: before } : { [key]: before === '旧值' ? name : before };
  const next = field === 'status' ? { title: name, status: after } : { [key]: after === '新值' ? `${name}（已改）` : after };
  return { beforeSnapshot: JSON.stringify(titled), afterSnapshot: JSON.stringify(next) };
}

async function owner<T>(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`${base}${path}`, { data });
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body.data as T;
}

async function seedChanges(request: APIRequestContext) {
  const claude = await owner<{ id: string }>(request, '/api/v1/connections', { name: '笔记本上的 Claude', host: 'claude', topicIds: [], includeInbox: true, autoActions: [] });
  const codex = await owner<{ id: string }>(request, '/api/v1/connections', { name: '工作站 Codex', host: 'codex', topicIds: [], includeInbox: true, autoActions: [] });
  const task = await owner<{ id: string }>(request, '/api/tasks', { title: undoTitle });
  const patched = await request.patch(`${base}/api/tasks/${task.id}`, { data: { status: 'doing' } });
  expect(patched.ok(), await patched.text()).toBe(true);
  const updates = await e2eDatabase.changeRecord.findMany({ where: { entityId: task.id, operation: 'update' } });
  expect(updates).toHaveLength(1);
  // 真实可撤销的记录放在今日事项之后、仍在第一页，滚到中部后 scrollTop 才够大。
  await e2eDatabase.changeRecord.update({ where: { id: updates[0].id }, data: { createdAt: new Date(Math.max(shanghaiMidnight(0) + 60_000, Date.now() - 10 * 60 * 1000)).toISOString() } });

  const midnight = shanghaiMidnight(0);
  let tick = Date.now();
  const today = () => new Date(Math.max(midnight, tick -= 250)).toISOString();
  const yesterday = (index: number) => new Date(shanghaiMidnight(-1) + (9 * 3600 + index * 90) * 1000).toISOString();
  const earlier = (index: number) => new Date(shanghaiMidnight(-4 - (index % 24)) + (8 * 3600 + (index % 40) * 70) * 1000).toISOString();
  const rows: Prisma.ChangeRecordCreateManyInput[] = [];
  const add = (row: Prisma.ChangeRecordCreateManyInput) => { rows.push({ source: 'user', ...row }); };

  add({ entityType: 'execution', entityId: 'e2e-exec-secret', entityName: '读取密钥文件', operation: 'execute', source: 'agent', beforeSnapshot: null, afterSnapshot: JSON.stringify({ toolName: 'read_file', input: { path: '/tmp/secret' }, result: { success: true } }), createdAt: today() });
  add({ entityType: 'task', entityId: 'e2e-task-purged', entityName: '清空过期草稿', operation: 'permanent_delete', ...snapshots('清空过期草稿'), createdAt: today() });
  add({ entityType: 'task', entityId: 'e2e-task-undo-entry', entityName: '撤销了标题修改', operation: 'undo:update', ...snapshots('撤销了标题修改'), createdAt: today() });
  add({ entityType: 'task', entityId: 'e2e-task-no-snap', entityName: '缺少快照的任务', operation: 'update', beforeSnapshot: null, afterSnapshot: null, createdAt: today() });
  add({ entityType: 'task', entityId: 'e2e-task-undone', entityName: '已经撤销的任务', operation: 'update', ...snapshots('已经撤销的任务', 'status', 'doing', 'todo'), undoneAt: new Date().toISOString(), createdAt: today() });
  add({ entityType: 'task', entityId: 'e2e-task-search-a', entityName: '星港检索样本', operation: 'update', ...snapshots('星港检索样本', 'status', 'todo', 'doing'), createdAt: today() });
  add({ entityType: 'task', entityId: 'e2e-task-search-b', entityName: '星港检索附注', operation: 'update', ...snapshots('星港检索附注', 'status', 'todo', 'blocked'), createdAt: today() });
  add({ entityType: 'task', entityId: pasteId, entityName: '孤立对象甲', operation: 'update', ...snapshots('孤立对象甲', 'status', 'todo', 'doing'), createdAt: today() });
  add({ entityType: 'task', entityId: 'e2e-task-claude', entityName: '连接改了截止日期', operation: 'update', source: 'agent', connectionId: claude.id, ...snapshots('连接改了截止日期'), createdAt: today() });
  add({ entityType: 'task', entityId: 'e2e-task-codex', entityName: '连接同步了优先级', operation: 'update', source: 'agent', connectionId: codex.id, ...snapshots('连接同步了优先级'), createdAt: today() });
  add({ entityType: 'topic', entityId: 'e2e-topic-roadmap', entityName: '产品路线清单', operation: 'update', ...snapshots('产品路线清单', 'name', '产品路线', '产品路线清单'), createdAt: today() });
  add({ entityType: 'tag', entityId: 'e2e-tag-release', entityName: '发布标签', operation: 'update', ...snapshots('发布标签', 'name', '发布', '发布标签'), createdAt: today() });
  add({ entityType: 'memory', entityId: 'e2e-memory-morning', entityName: '晨间回顾', operation: 'update', ...snapshots('晨间回顾'), createdAt: today() });
  for (const [index, name] of ['写周报', '对齐接口', '补测试', '看设计稿', '整理收集箱', '回复客户', '更新排期', '记录决定', '拆子任务', '核对文案', '归档完成项', '准备演示'].entries()) {
    add({ entityType: 'task', entityId: `e2e-today-${index}`, entityName: `今日事项：${name}`, operation: 'update', ...snapshots(`今日事项：${name}`, 'status', 'todo', 'doing'), createdAt: today() });
  }
  for (const [index, name] of ['复盘一', '复盘二', '复盘三', '复盘四', '复盘五'].entries()) {
    add({ entityType: 'task', entityId: `e2e-yesterday-${index}`, entityName: `昨日任务${name}`, operation: 'update', ...snapshots(`昨日任务${name}`, 'status', 'todo', 'done'), createdAt: yesterday(index) });
  }

  const apiCount = await e2eDatabase.changeRecord.count();
  const fillerCount = totalRecords - apiCount - rows.length;
  expect(fillerCount, `api ${apiCount} explicit ${rows.length}`).toBeGreaterThan(0);
  const fillerNames = ['整理会议纪要', '补充接口说明', '调整清单颜色', '归档过期标签', '记录一条记忆', '重排本周任务', '恢复误删事项', '确认阶段成果', '移动到收集箱', '修改截止日期'];
  const fillerKinds = [
    { entityType: 'task', operation: 'update' },
    { entityType: 'topic', operation: 'create' },
    { entityType: 'tag', operation: 'delete' },
    { entityType: 'memory', operation: 'update' },
    { entityType: 'execution', operation: 'execute' },
    { entityType: 'task', operation: 'undo:update' },
    { entityType: 'task', operation: 'permanent_delete' },
    { entityType: 'topic', operation: 'archive_preserve' },
  ] as const;
  for (let index = 0; index < fillerCount; index += 1) {
    const kind = fillerKinds[index % fillerKinds.length];
    const name = `${fillerNames[index % fillerNames.length]} ${index + 1}`;
    const blocked = kind.operation === 'execute' || kind.operation.startsWith('undo:') || kind.operation === 'permanent_delete';
    add({
      entityType: kind.entityType,
      entityId: `e2e-filler-${index}`,
      entityName: name,
      operation: kind.operation,
      source: index % 11 === 0 ? 'agent' : 'user',
      connectionId: index % 17 === 0 ? claude.id : index % 19 === 0 ? codex.id : null,
      ...(kind.operation === 'execute'
        ? { beforeSnapshot: null, afterSnapshot: JSON.stringify({ toolName: 'read_file', input: {}, result: { success: index % 2 === 0 } }) }
        : blocked
          ? snapshots(name)
          : kind.entityType === 'task'
            ? snapshots(name, 'status', 'todo', 'doing')
            : snapshots(name, 'name')),
      createdAt: index % 3 === 0 ? yesterday(index) : earlier(index),
    });
  }
  for (let offset = 0; offset < rows.length; offset += 40) await e2eDatabase.changeRecord.createMany({ data: rows.slice(offset, offset + 40) });
  expect(await e2eDatabase.changeRecord.count()).toBe(totalRecords);
  return task.id;
}

function isBulkList(url: string) {
  const parsed = new URL(url);
  if (parsed.pathname === '/api/tasks') return [...parsed.searchParams.keys()].length === 0;
  return parsed.pathname === '/api/topics' || parsed.pathname === '/api/tags';
}

async function warmShell(page: Page) {
  const wanted = new Set(['/api/topics', '/api/topics?archived=true', '/api/tags']);
  const seen = new Set<string>();
  const ready = new Promise<void>((resolve) => {
    const onResponse = (response: { url: () => string; ok: () => boolean }) => {
      if (!response.ok()) return;
      const url = new URL(response.url());
      const key = url.pathname + url.search;
      if (wanted.has(key)) seen.add(key);
      if (seen.size === wanted.size) {
        page.off('response', onResponse);
        resolve();
      }
    };
    page.on('response', onResponse);
  });
  await page.goto('/#/connections');
  await ready;
  await expect(page.getByRole('heading', { name: 'AI 连接', exact: true })).toBeVisible();
}

async function openChanges(page: Page) {
  await page.goto('/#/changes');
  await expect(page.getByRole('dialog', { name: '变更历史' })).toBeVisible();
  await expect(page.getByTestId('change-row').first()).toBeVisible();
}

async function scrollToEnd(page: Page) {
  const scroller = page.locator('[data-page-scroll]');
  await expect.poll(async () => {
    const end = page.getByText(/已经到底 · 共 \d+ 条/);
    if (await end.count()) return await end.innerText();
    await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    return '';
  }, { timeout: 60_000 }).toMatch(/已经到底/);
}

async function applyTaskReversibleToday(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '筛选' });
    await expect(panel).toBeVisible();
    const preview = page.waitForResponse((response) => {
      const url = response.url();
      return response.request().method() === 'GET' && url.includes('/api/changes') && url.includes('type=task') && url.includes('status=reversible') && url.includes('from=') && url.includes('limit=1');
    });
    await panel.getByRole('button', { name: '任务', exact: true }).click();
    await panel.getByRole('button', { name: '可撤销', exact: true }).click();
    await panel.getByRole('button', { name: '今天', exact: true }).click();
    await preview;
    await panel.getByRole('button', { name: /查看 \d+ 条结果/ }).click();
    await expect(panel).toBeHidden();
    return;
  }
  await page.getByRole('button', { name: '筛选对象类型' }).click();
  await page.getByRole('menuitemcheckbox', { name: '任务', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '状态', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: '可撤销', exact: true }).click();
  await page.keyboard.press('Escape');
  const filtered = page.waitForResponse((response) => {
    const url = response.url();
    return response.request().method() === 'GET' && url.includes('/api/changes') && url.includes('type=task') && url.includes('status=reversible') && url.includes('from=') && !url.includes('limit=1');
  });
  await page.getByRole('button', { name: '时间', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '今天', exact: true }).click();
  await filtered;
}

function undoRow(page: Page) {
  return page.getByTestId('change-row').filter({ hasText: undoTitle }).filter({ has: page.getByText('更新', { exact: true }) });
}

async function placeRow(row: Locator) {
  // 吸顶日期会挡住贴顶的按钮。放到滚动区中部，点击才不会再把列表挪开。
  return row.evaluate((element) => {
    const scroller = element.closest('[data-page-scroll]') as HTMLElement;
    const scrollerRect = scroller.getBoundingClientRect();
    const rowRect = element.getBoundingClientRect();
    const top = rowRect.top - scrollerRect.top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top - (scroller.clientHeight - rowRect.height) / 2);
    return { scrollTop: scroller.scrollTop, rowHeight: element.getBoundingClientRect().height };
  });
}

test('首屏只取一页，变更页不再请求任务、清单和标签全量', async ({ page }) => {
  test.setTimeout(60_000);
  // 侧栏本来就会拉清单和标签。先等外壳请求结束，再打开变更页，才能看出这一页没有再拉全量。
  await warmShell(page);
  const bulk: string[] = [];
  const onRequest = (request: { method: () => string; url: () => string }) => {
    if (request.method() === 'GET' && isBulkList(request.url())) bulk.push(new URL(request.url()).pathname + new URL(request.url()).search);
  };
  page.on('request', onRequest);
  const first = page.waitForResponse((response) => {
    if (response.request().method() !== 'GET' || !response.ok()) return false;
    const url = new URL(response.url());
    return url.pathname === '/api/changes' && !url.searchParams.has('cursor');
  });
  await page.evaluate(() => { window.location.hash = '/changes'; });
  const body = await (await first).json();
  await expect(page.getByRole('dialog', { name: '变更历史' })).toBeVisible();
  await expect(page.getByTestId('change-row')).toHaveCount(body.data.items.length);
  expect(body.data.items.length).toBeLessThanOrEqual(50);
  expect(body.data.items.length).toBeGreaterThan(0);
  expect(body.data.total).toBe(totalRecords);
  expect(body.data.nextCursor).toBeTruthy();
  expect(body.data.items[0]).not.toHaveProperty('beforeSnapshot');
  expect(bulk).toEqual([]);
  page.off('request', onRequest);
});

test('滚动到底后行数等于总数', async ({ page }) => {
  test.setTimeout(90_000);
  await openChanges(page);
  await expect(page.getByText(`已加载 50 条 / 共 ${totalRecords} 条`)).toBeVisible();
  await scrollToEnd(page);
  await expect(page.getByText(`已经到底 · 共 ${totalRecords} 条`)).toBeVisible();
  await expect(page.getByTestId('change-row')).toHaveCount(totalRecords);
});

test('任务、可撤销、今天可以组合筛选，清除后恢复', async ({ page, isMobile }) => {
  test.setTimeout(60_000);
  await openChanges(page);
  await applyTaskReversibleToday(page, Boolean(isMobile));
  await expect(page.getByText('对象：任务')).toBeVisible();
  await expect(page.getByText('状态：可撤销')).toBeVisible();
  await expect(page.getByText('时间：今天')).toBeVisible();
  await scrollToEnd(page);
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '昨天', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '更早', exact: true })).toHaveCount(0);
  const rows = page.getByTestId('change-row');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    await expect(row).toContainText('任务');
    await expect(row.getByRole('button', { name: '撤销' })).toBeEnabled();
    await expect(row.getByText('已撤销', { exact: true })).toHaveCount(0);
  }
  const listed = await (await page.request.get(`${base}/api/changes?${new URLSearchParams({ type: 'task', status: 'reversible', from: await page.evaluate(() => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString()), limit: '50' })}`)).json();
  expect(listed.data.total).toBe(count);
  await expect(page.getByText(`已加载 ${count} 条 / 共 ${count} 条`)).toBeVisible();

  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.getByText('对象：任务')).toHaveCount(0);
  await expect(page.getByText(`已加载 50 条 / 共 ${totalRecords} 条`)).toBeVisible();
  await expect(page.getByTestId('change-row')).toHaveCount(50);
});

test('搜索名称片段能命中，粘贴完整 ID 只剩一条', async ({ page }) => {
  test.setTimeout(45_000);
  await openChanges(page);
  const search = page.getByRole('searchbox', { name: '搜索名称，或粘贴完整 ID' });
  const byName = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().includes('/api/changes') && response.url().includes('q=') && response.ok());
  await search.fill('星港检索');
  const named = await (await byName).json();
  expect(named.data.total).toBe(2);
  await expect(page.getByTestId('change-row')).toHaveCount(2);
  await expect(page.getByTestId('change-row').nth(0)).toContainText('星港检索');
  await expect(page.getByTestId('change-row').nth(1)).toContainText('星港检索');

  const byId = page.waitForResponse((response) => response.url().includes(pasteId) && response.ok());
  await search.fill(pasteId);
  const exact = await (await byId).json();
  expect(exact.data.total).toBe(1);
  await expect(page.getByTestId('change-row')).toHaveCount(1);
  await expect(page.getByTestId('change-row')).toContainText('孤立对象甲');
});

test('不可撤销的按钮置灰，悬停或聚焦外层显示原因', async ({ page, isMobile }) => {
  test.skip(Boolean(isMobile), '触屏点按在手机用例里验收');
  await openChanges(page);
  const execution = page.getByTestId('change-row').filter({ hasText: '读取密钥文件' });
  await expect(execution.getByRole('button', { name: '撤销' })).toBeDisabled();
  await execution.locator('span[tabindex="0"]').hover();
  await expect(page.getByRole('tooltip', { name: '受控执行记录不可撤销' })).toBeVisible();

  const purged = page.getByTestId('change-row').filter({ hasText: '清空过期草稿' });
  await expect(purged.getByRole('button', { name: '撤销' })).toBeDisabled();
  await purged.locator('span[tabindex="0"]').focus();
  await expect(page.getByRole('tooltip', { name: '此类操作不支持撤销（永久删除）' })).toBeVisible();
});

test('撤销只让当前行转圈，完成后置灰且不把列表拉回顶部', async ({ page, request }) => {
  test.setTimeout(60_000);
  await openChanges(page);
  const row = undoRow(page);
  await expect(row).toBeVisible();
  const placed = await placeRow(row);
  const scroller = page.locator('[data-page-scroll]');
  expect(placed.scrollTop).toBeGreaterThan(placed.rowHeight);
  const undoButton = row.getByRole('button', { name: '撤销' });
  const buttonBox = await undoButton.boundingBox();
  const scrollerBox = await scroller.boundingBox();
  expect(buttonBox && scrollerBox && buttonBox.y > scrollerBox.y + 48 && buttonBox.y + buttonBox.height < scrollerBox.y + scrollerBox.height - 8).toBe(true);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/changes/*/undo', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    await gate;
    await route.continue();
  });
  try {
    await undoButton.click({ force: true });
    await expect(row.locator('svg.animate-spin')).toBeVisible();
    await expect(page.locator('[data-testid="change-row"] svg.animate-spin')).toHaveCount(1);
    expect(await page.locator('[data-testid="change-row"] button:not([disabled])').count()).toBeGreaterThan(0);
    const whilePending = await scroller.evaluate((element) => element.scrollTop);
    expect(Math.abs(whilePending - placed.scrollTop)).toBeLessThan(placed.rowHeight);
    release();
    await expect(page.getByText('变更已撤销')).toBeVisible();
    await expect.poll(async () => (await (await request.get(`${base}/api/tasks/${seeded.taskId}`)).json()).data.status).toBe('todo');
    await expect(row.getByText('已撤销', { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(row.getByRole('button', { name: '撤销' })).toBeDisabled();
    await expect(row.locator('svg.animate-spin')).toHaveCount(0);
    const after = await scroller.evaluate((element) => element.scrollTop);
    expect(Math.abs(after - placed.scrollTop)).toBeLessThan(placed.rowHeight);
  } finally {
    release();
  }
});

test('手机筛选面板关闭后 chip 可横滑，点置灰按钮外层出现原因', async ({ page, isMobile }) => {
  test.skip(!isMobile, '底部筛选面板只在手机视口');
  test.setTimeout(60_000);
  await openChanges(page);
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '筛选' });
  const objects = panel.locator('section').filter({ has: page.getByRole('heading', { name: '对象', exact: true }) });
  const preview = page.waitForResponse((response) => response.url().includes('/api/changes') && response.url().includes('limit=1') && response.url().includes('type=') && response.ok());
  for (const name of ['任务', '清单', '标签', '受控执行', '记忆', '资料', '技能']) await objects.getByRole('button', { name, exact: true }).click();
  await preview;
  const apply = panel.getByRole('button', { name: /查看 \d+ 条结果/ });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(panel).toBeHidden();
  const chips = page.locator('div.overflow-x-auto').filter({ hasText: '对象：任务' });
  await expect(chips).toBeVisible();
  const metrics = await chips.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollLeft: element.scrollLeft }));
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth + 8);
  await chips.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  expect(await chips.evaluate((element) => element.scrollLeft)).toBeGreaterThan(20);

  const execution = page.getByTestId('change-row').filter({ hasText: '读取密钥文件' });
  await execution.locator('span[tabindex="0"]').click();
  await expect(page.getByRole('tooltip', { name: '受控执行记录不可撤销' })).toBeVisible();
});
