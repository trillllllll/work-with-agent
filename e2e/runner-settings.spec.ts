/**
 * Runner settings (§9.2): computers, projects, this-computer shell events, phone layout.
 * Nodes are prepared through the API. A lease with the issued token marks a computer online.
 */
import type { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const GIB = 1024 ** 3;
const web = (process.env.E2E_UI_URL ?? 'http://127.0.0.1:5175');

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

async function bodyOf<T>(response: APIResponse): Promise<T> {
  const payload = await response.json() as { data: T; code?: string; error?: string };
  expect(response.ok(), `${response.status()} ${payload.code ?? ''} ${payload.error ?? ''}`).toBe(true);
  return payload.data;
}

function capabilities(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 2,
    version: '9.9.9-e2e',
    platform: 'linux-x64',
    providers: [{ provider: 'codex', available: true, version: '9.9.9-e2e', path: '/opt/e2e/codex' }],
    maxConcurrent: 2,
    allowedRoots: ['/srv/demo'],
    freeBytes: 5 * GIB,
    gh: true,
    managedBy: 'cli',
    logPath: '/var/log/wwa/online.log',
    lastError: null,
    startedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

async function lease(request: APIRequestContext, token: string, caps: ReturnType<typeof capabilities>) {
  return request.post(`${web}/api/v1/node/lease`, {
    headers: { Authorization: `Node ${token}` },
    data: { capabilities: caps, activeJobIds: [], max: 1 },
  });
}

async function createComputer(request: APIRequestContext, name: string, caps = capabilities()) {
  const created = await bodyOf<{ node: { id: string }; token: string }>(await request.post(`${web}/api/nodes`, { data: { name } }));
  const leased = await lease(request, created.token, caps);
  expect(leased.ok(), await leased.text()).toBe(true);
  return { id: created.node.id, token: created.token };
}

function computerCard(page: Page, name: string) {
  return page.locator('article').filter({ has: page.getByRole('heading', { name, exact: true, level: 4 }) });
}

async function projectCard(page: Page, name: string) {
  await expect.poll(async () => {
    const articles = page.locator('article');
    const count = await articles.count();
    for (let index = 0; index < count; index += 1) {
      const box = articles.nth(index).getByRole('textbox', { name: '名称', exact: true });
      if ((await box.count()) === 0) continue;
      if ((await box.inputValue()) === name) return name;
    }
    return '';
  }).toBe(name);
  const articles = page.locator('article');
  const count = await articles.count();
  for (let index = 0; index < count; index += 1) {
    const article = articles.nth(index);
    const box = article.getByRole('textbox', { name: '名称', exact: true });
    if ((await box.count()) > 0 && (await box.inputValue()) === name) return article;
  }
  throw new Error(`找不到项目 ${name}`);
}

function unboundList(page: Page) {
  return page.getByRole('heading', { name: '清单与项目', exact: true }).locator('..');
}

async function pickTopic(page: Page, card: Locator, name: string) {
  const trigger = card.getByRole('button', { name: '选择清单' });
  const popover = page.locator('[data-slot="popover-content"]');
  const option = popover.getByRole('button', { name, exact: true });
  if (!(await option.isVisible())) await trigger.click();
  await option.click();
  await expect(card.getByRole('button', { name: `移除 ${name}` })).toBeVisible();
  await expect(trigger).toBeEnabled();
  if (await popover.isVisible()) await trigger.click();
  await expect(popover).toBeHidden();
}

function installShellEvents(page: Page, nodeId: string) {
  const origin = (process.env.E2E_UI_URL ?? 'http://127.0.0.1:5175');
  page.on('request', (request) => {
    const url = request.url();
    const detail = url.includes('dovun-node-unpair')
      ? { type: 'node-unpair', ok: true, stopped: false, configRemoved: false, cancelled: 0, message: 'e2e-not-stopped' }
      : url.includes('dovun-node-status')
        ? { type: 'node-status', nodeId, server: origin, running: true, configured: true, logPath: '/var/log/wwa/node.log' }
        : null;
    if (!detail) return;
    // The status listener is attached before the sentinel navigation. Dispatch after fulfill, or the page waits on the route forever.
    setTimeout(() => { void page.evaluate((payload) => window.dispatchEvent(new CustomEvent('dovun-desktop', { detail: payload })), detail).catch(() => undefined); }, 30);
  });
}

async function columnCounts(section: Locator) {
  return section.locator('.grid').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length));
}

async function expectInsideViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

test.describe('桌面', () => {
  test.describe.configure({ timeout: 60_000 });
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });

  test('主控卡命令默认折叠，展开后可见说明，规划模型链接到模型设置', async ({ page }) => {
    await page.goto('/#/settings/local');
    const section = page.getByRole('region', { name: '主控与电脑设置' });
    const trigger = section.getByRole('button', { name: '主控上的 AI 命令' });
    await expect(trigger).toHaveAttribute('data-state', 'closed');
    await expect(section.getByText('只用于定期回顾和交接')).toBeHidden();
    await trigger.click();
    await expect(trigger).toHaveAttribute('data-state', 'open');
    await expect(section.getByText('只用于定期回顾和交接')).toBeVisible();
    await section.getByRole('link', { name: '在『模型与 AI』修改' }).click();
    await expect(page).toHaveURL(/#\/settings\/model$/);
    await expect(page.getByLabel('接口地址')).toBeVisible();
  });

  test('在线电脑卡显示上报信息，离线卡写明上次上报', async ({ page, request }) => {
    await createComputer(request, '在线电脑');
    const offline = await createComputer(request, '离线电脑', capabilities({
      version: '8.8.8-e2e',
      providers: [{ provider: 'codex', available: true, version: '8.8.8-e2e', path: '/opt/e2e/offline-codex' }],
      allowedRoots: ['/srv/offline'],
      logPath: '/var/log/wwa/offline.log',
      lastError: 'e2e-offline-error',
    }));
    await e2eDatabase.agentNode.update({ where: { id: offline.id }, data: { lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() } });

    await page.goto('/#/settings/local');
    const online = computerCard(page, '在线电脑');
    await expect(online.getByText('在线', { exact: true })).toBeVisible();
    await expect(online).toContainText('9.9.9-e2e');
    await expect(online).toContainText('/opt/e2e/codex');
    await expect(online).toContainText('/srv/demo');
    await expect(online).toContainText('最多同时跑 2 个');
    await expect(online).toContainText('5.0 GB');
    await expect(online).toContainText('/var/log/wwa/online.log');
    await expect(online).not.toContainText('上次上报');

    const stale = computerCard(page, '离线电脑');
    await expect(stale).toContainText('离线');
    await expect(stale).toContainText('上次上报');
    await expect(stale).toContainText('以下是上次上报的快照。');
    await expect(stale).toContainText('8.8.8-e2e');
    await expect(stale).toContainText('/opt/e2e/offline-codex');
    await expect(stale).toContainText('/srv/offline');
    await expect(stale).toContainText('/var/log/wwa/offline.log');
    await expect(stale).toContainText('e2e-offline-error');
  });

  test('添加电脑只显示一次命令，重新生成后旧令牌 lease 返回 401', async ({ page, request }) => {
    await page.goto('/#/settings/local');
    const section = page.getByRole('region', { name: '主控与电脑设置' });
    await section.getByRole('button', { name: '添加电脑' }).click();
    const add = page.getByRole('dialog', { name: '添加电脑' });
    await add.getByRole('textbox', { name: '名称' }).fill('一次性电脑');
    await add.getByRole('button', { name: '生成连接命令' }).click();
    await expect(add).toContainText('令牌只显示这一次');
    const command = await add.locator('code', { hasText: '--token' }).innerText();
    const oldToken = command.match(/--token (\S+)/)?.[1];
    expect(oldToken).toBeTruthy();
    await add.getByRole('button', { name: 'Close' }).click();
    await expect(add).toBeHidden();
    await expect(page.getByText(oldToken!)).toHaveCount(0);

    const card = computerCard(page, '一次性电脑');
    await card.getByRole('button', { name: '重新生成连接命令' }).click();
    const confirm = page.getByRole('dialog', { name: '重新签发令牌' });
    await expect(confirm).toContainText('旧令牌会立刻失效');
    await confirm.getByRole('button', { name: '重新签发' }).click();
    const again = page.getByRole('dialog', { name: '连接命令' });
    await expect(again).toContainText('令牌只显示这一次');
    const next = (await again.locator('code', { hasText: '--token' }).innerText()).match(/--token (\S+)/)?.[1];
    expect(next).toBeTruthy();
    expect(next).not.toBe(oldToken);

    const rejected = await lease(request, oldToken!, capabilities());
    expect(rejected.status()).toBe(401);
    expect((await rejected.json()).code).toBe('NODE_TOKEN_INVALID');
    const accepted = await lease(request, next!, capabilities());
    expect(accepted.ok(), await accepted.text()).toBe(true);
  });

  test('远端吊销取消后记录还在，确认后进入已断开折叠区，删除后消失', async ({ page, request }) => {
    await createComputer(request, '远端电脑');
    await page.goto('/#/settings/local');
    const card = computerCard(page, '远端电脑');
    await card.getByRole('button', { name: '吊销', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '吊销这台电脑' });
    await expect(dialog).toContainText('远端电脑不能从这里停进程');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden();
    await expect(card).toBeVisible();
    await expect(page.getByRole('button', { name: /已断开的电脑/ })).toHaveCount(0);

    await card.getByRole('button', { name: '吊销', exact: true }).click();
    await page.getByRole('dialog', { name: '吊销这台电脑' }).getByRole('button', { name: '吊销', exact: true }).click();
    await expect(card).toBeHidden();
    const revoked = page.getByRole('button', { name: /已断开的电脑/ });
    await expect(revoked).toBeVisible();
    await revoked.click();
    await expect(page.getByText('远端电脑', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '删除记录' }).click();
    const remove = page.getByRole('dialog', { name: '删除这台电脑的记录' });
    await expect(remove).toContainText('只删除这条已断开的记录');
    await remove.getByRole('button', { name: '删除记录' }).click();
    await expect(page.getByText('远端电脑', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /已断开的电脑/ })).toHaveCount(0);
  });

  test('这台电脑显示徽章、断开确认框，未停止时可以再试一次', async ({ page, request }) => {
    const computer = await createComputer(request, '壳上的电脑');
    const project = await bodyOf<{ id: string }>(await request.post(`${web}/api/projects`, { data: { name: '壳项目' } }));
    const located = await request.post(`${web}/api/projects/${project.id}/locations`, { data: { nodeId: computer.id, path: '/srv/shell-repo' } });
    expect(located.ok(), await located.text()).toBe(true);
    await page.addInitScript(() => localStorage.setItem('dovun-desktop-shell', '1'));
    await page.route('**/dovun-node-*', (route) => route.fulfill({ status: 204 }));
    installShellEvents(page, computer.id);

    await page.goto('/#/settings/local');
    const card = computerCard(page, '壳上的电脑');
    await expect(card.getByText('这台电脑', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(card.getByRole('button', { name: '在这台电脑上修改…' })).toBeVisible();
    await card.getByRole('button', { name: '断开这台电脑' }).click();
    const dialog = page.getByRole('dialog', { name: '断开这台电脑' });
    await expect(dialog).toContainText('将停止这台电脑上的进程，删除本机配置');
    await expect(dialog).toContainText('将取消 1 个进行中的任务');
    await expect(dialog).toContainText('1 个项目位置会失效');
    await expect(dialog).toContainText('/srv/shell-repo');
    await expect(dialog).toContainText('正在运行且用到这台电脑的编排会暂停');
    await expect(dialog).toContainText('Worktree 不会在这里清理。');
    await expect(dialog.getByRole('button', { name: '打开 Worktree 管理' })).toBeVisible();
    await dialog.getByRole('button', { name: '断开这台电脑' }).click();

    const result = page.getByRole('dialog', { name: '断开结果' });
    await expect(result).toBeVisible({ timeout: 15_000 });
    await expect(result).toContainText('令牌已吊销，本机进程未确认停止');
    await expect(result).toContainText('e2e-not-stopped');
    await expect(result.getByRole('button', { name: '再试一次' })).toBeVisible();
    await expect(result).toContainText('已取消 1 个任务');
  });

  test('通知开关在页面底部，并写明只对这台设备生效', async ({ page }) => {
    await page.goto('/#/settings/local');
    const section = page.getByRole('region', { name: '主控与电脑设置' });
    await expect(section).toBeVisible();
    const order = await page.locator('[data-settings-section]').evaluateAll((nodes) => nodes.map((node) => ({
      id: node.getAttribute('data-settings-section'),
      top: (node as HTMLElement).offsetTop,
    })));
    expect(order.map((item) => item.id)).toEqual(['computers', 'worktrees', 'notifications']);
    expect(order[2].top).toBeGreaterThan(order[1].top);
    expect(order[1].top).toBeGreaterThan(order[0].top);
    const notifications = page.locator('[data-settings-section="notifications"]');
    await expect(notifications).toContainText('只对这台设备生效。');
    await expect(notifications.getByRole('switch', { name: '编排待验收或暂停时发系统通知' })).toBeVisible();
  });

  test('项目可保存分支引擎和并行，超上限禁用，归档、替换位置、重新验证和清单绑定', async ({ page, request }) => {
    test.setTimeout(90_000);
    await createComputer(request, '上限电脑', capabilities({ maxConcurrent: 2 }));
    for (const name of ['清单甲', '清单乙', '清单丙']) await bodyOf(await request.post(`${web}/api/topics`, { data: { name } }));

    await page.goto('/#/settings/projects');
    const projects = page.getByRole('region', { name: '项目设置' });
    const unbound = unboundList(page);
    await expect(unbound).toContainText('清单甲');
    await expect(unbound).toContainText('清单乙');
    await expect(unbound).toContainText('清单丙');

    await projects.getByPlaceholder('项目名称').fill('仓库甲');
    await projects.getByRole('button', { name: '新建项目' }).click();
    const first = await projectCard(page, '仓库甲');
    await first.getByRole('textbox', { name: '路径' }).fill('/srv/repo-a');
    await first.getByRole('button', { name: '添加项目位置' }).click();
    await expect(first.getByText('/srv/repo-a')).toBeVisible();
    await expect(first).toContainText('不能超过电脑「上限电脑」的并发上限 2');
    await first.getByRole('combobox', { name: '默认并行' }).click();
    await expect(page.getByRole('option', { name: '3（超过并发上限 2）' })).toBeDisabled();
    await expect(page.getByRole('option', { name: '4（超过并发上限 2）' })).toBeDisabled();
    await page.getByRole('option', { name: '1', exact: true }).click();
    await first.getByRole('combobox', { name: '默认引擎' }).click();
    await page.getByRole('option', { name: 'Claude', exact: true }).click();
    await first.getByRole('textbox', { name: '默认分支' }).fill('release/e2e');
    await first.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('已保存')).toBeVisible();

    await page.reload();
    const saved = await projectCard(page, '仓库甲');
    await expect(saved.getByRole('textbox', { name: '默认分支' })).toHaveValue('release/e2e');
    await expect(saved.getByRole('combobox', { name: '默认引擎' })).toContainText('Claude');
    await expect(saved.getByRole('combobox', { name: '默认并行' })).toHaveText('1');

    await saved.getByRole('textbox', { name: '路径' }).fill('/srv/repo-b');
    await saved.getByRole('button', { name: '添加项目位置' }).click();
    const replace = page.getByRole('dialog', { name: '替换项目位置' });
    await expect(replace).toContainText('/srv/repo-a');
    await replace.getByRole('button', { name: '替换并验证' }).click();
    await expect(saved.getByText('/srv/repo-b')).toBeVisible();

    await e2eDatabase.nodeJob.updateMany({ where: { kind: 'probe', status: { in: ['queued', 'leased'] } }, data: { status: 'succeeded' } });
    await e2eDatabase.projectLocation.updateMany({ data: { status: 'verified' } });
    await page.reload();
    const verified = await projectCard(page, '仓库甲');
    await expect(verified.getByText('已验证', { exact: true })).toBeVisible();
    await verified.getByRole('button', { name: '重新验证' }).click();
    await expect(verified.getByText('待验证', { exact: true })).toBeVisible();

    await pickTopic(page, verified, '清单甲');
    await pickTopic(page, verified, '清单乙');
    await expect(unboundList(page).getByRole('listitem')).toHaveText(['清单丙']);

    await projects.getByPlaceholder('项目名称').fill('仓库乙');
    await projects.getByRole('button', { name: '新建项目' }).click();
    const second = await projectCard(page, '仓库乙');
    await second.getByRole('button', { name: '选择清单' }).click();
    await page.locator('[data-slot="popover-content"]').getByRole('button', { name: '清单甲', exact: true }).click();
    const bound = page.getByRole('dialog', { name: '这些清单已属于别的项目' });
    await expect(bound).toContainText('清单甲 当前属于 仓库甲');
    await bound.getByRole('button', { name: '改为这个项目' }).click();
    await expect(bound).toBeHidden();
    await expect(second.getByRole('button', { name: '移除 清单甲' })).toBeVisible();
    await expect(unboundList(page).getByRole('listitem')).toHaveText(['清单丙']);

    await second.getByRole('button', { name: '归档' }).click();
    const archive = page.getByRole('dialog', { name: '归档项目' });
    await expect(archive).toContainText('仓库乙');
    await archive.getByRole('button', { name: '归档', exact: true }).click();
    await expect(archive).toBeHidden();
    const folded = page.getByRole('button', { name: /已归档的项目/ });
    await folded.click();
    await expect(page.getByRole('button', { name: '取消归档' })).toBeVisible();
    const archivedTopics = unboundList(page).getByRole('listitem');
    await expect(archivedTopics.filter({ hasText: '清单甲' })).toBeVisible();
    await expect(archivedTopics.filter({ hasText: '清单丙' })).toBeVisible();
    await expect(archivedTopics.filter({ hasText: '清单乙' })).toHaveCount(0);
    await page.getByRole('button', { name: '取消归档' }).click();
    await expect(page.getByRole('button', { name: /已归档的项目/ })).toHaveCount(0);
    await expect(unboundList(page).getByRole('listitem')).toHaveText(['清单丙']);
    await expect(await projectCard(page, '仓库甲')).toBeVisible();
    await expect(await projectCard(page, '仓库乙')).toBeVisible();
  });

  test('主控与项目设置没有可见的原生 select 或 checkbox', async ({ page }) => {
    await page.goto('/#/settings/local');
    const local = page.getByTestId('settings-category');
    await expect(local.getByRole('region', { name: '主控与电脑设置' })).toBeVisible();
    await expect(local.locator('select:not([aria-hidden="true"]), input[type=checkbox]:not([aria-hidden="true"])')).toHaveCount(0);
    await page.goto('/#/settings/projects');
    const projects = page.getByTestId('settings-category');
    await expect(projects.getByRole('region', { name: '项目设置' })).toBeVisible();
    await expect(projects.locator('select:not([aria-hidden="true"]), input[type=checkbox]:not([aria-hidden="true"])')).toHaveCount(0);
  });

  test('深色主题下主控与项目设置没有控制台错误', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.stack || error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const location = message.location();
      errors.push(`console: ${message.text()} @ ${location.url}:${location.lineNumber}:${location.columnNumber}`);
    });
    await page.addInitScript(() => {
      localStorage.setItem('dovun.theme', 'dark');
      document.documentElement?.classList.add('dark');
    });
    await page.goto('/#/settings/local');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    const section = page.getByRole('region', { name: '主控与电脑设置' });
    await section.getByRole('button', { name: '主控上的 AI 命令' }).click();
    await expect(section.getByText('只用于定期回顾和交接')).toBeVisible();
    await page.goto('/#/settings/projects');
    await expect(page.getByRole('region', { name: '项目设置' })).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('手机', () => {
  test.describe.configure({ timeout: 60_000 });
  test.use({ viewport: { width: 390, height: 844 } });

  test('类别列表进入详情，卡片单列且确认框完整', async ({ page, request }) => {
    await createComputer(request, '手机电脑', capabilities({ maxConcurrent: 2 }));
    await bodyOf(await request.post(`${web}/api/projects`, { data: { name: '手机项目' } }));
    await page.goto('/#/settings');
    const list = page.getByRole('dialog').getByTestId('settings-category-list');
    await expect(list).toBeVisible();
    await list.getByRole('button', { name: '主控与电脑', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/local$/);
    const computers = page.getByRole('region', { name: '主控与电脑设置' });
    await expect(computers).toBeVisible();
    await expect(computerCard(page, '手机电脑')).toBeVisible();
    for (const count of await columnCounts(computers)) expect(count).toBe(1);
    const overflow = () => page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="workspace-modal-scroller"]');
      return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
        && !!scroller && scroller.scrollWidth <= scroller.clientWidth + 1;
    });
    expect(await overflow()).toBe(true);

    await computerCard(page, '手机电脑').getByRole('button', { name: '吊销', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '吊销这台电脑' });
    await expect(dialog.getByRole('button', { name: '取消' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '吊销', exact: true })).toBeVisible();
    await expectInsideViewport(page, dialog);
    await expectInsideViewport(page, dialog.getByRole('button', { name: '取消' }));
    await expectInsideViewport(page, dialog.getByRole('button', { name: '吊销', exact: true }));
    expect(await overflow()).toBe(true);
    await dialog.getByRole('button', { name: '取消' }).click();

    await page.goto('/#/settings/projects');
    const projects = page.getByRole('region', { name: '项目设置' });
    await expect(await projectCard(page, '手机项目')).toBeVisible();
    for (const count of await columnCounts(projects)) expect(count).toBe(1);
    expect(await overflow()).toBe(true);
  });
});
