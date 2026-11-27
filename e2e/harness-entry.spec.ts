import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const updated = {
  archived: '2026-11-27T03:00:00.000Z',
  recent: '2026-11-27T02:00:00.000Z',
  offline: '2026-11-27T01:00:00.000Z',
  older: '2026-11-26T02:00:00.000Z',
};
const harnesses = [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude Code' }];
const nodes = [{
  id: 'node-mac', name: '验收 Mac', online: true, supportsHarness: true, harnessLibrary: true, harnessWorkspace: true,
  harnessOrganization: false, harnesses: ['codex', 'claude'], zcodeCreate: false, canBrowse: false,
}];
const directories = [
  { id: 'location-dovun', nodeId: 'node-mac', path: '/synthetic/Dovun', projectName: 'Dovun', computerName: '验收 Mac' },
  { id: 'location-docs', nodeId: 'node-mac', path: '/synthetic/Docs', projectName: '文档站', computerName: '验收 Mac' },
];

type FixtureSession = {
  id: string; nodeId: string; nodeName: string; online: boolean; projectName: string; threadId: string; epoch: number;
  status: string; error: string | null; startCommandId: string; harness: string; locationId: string; title: string;
  activity: 'approval' | 'running' | null; updatedAt: string; archived?: boolean; historyAvailable: boolean;
  settingsAvailable: boolean; workspaceAvailable: boolean; messageOriginAvailable: boolean;
};
function fixtureSessions(offlineMostRecent = false): FixtureSession[] {
  const base = {
    nodeId: 'node-mac', nodeName: '验收 Mac', epoch: 1, status: 'ready', error: null, activity: null,
    archived: false, historyAvailable: false, settingsAvailable: false, workspaceAvailable: false, messageOriginAvailable: true,
  };
  return [
    { ...base, id: 'session-archived', online: true, projectName: 'Dovun', threadId: 'thread-archived', startCommandId: 'start-archived',
      harness: 'codex', locationId: 'location-dovun', title: '不应打开的归档会话', updatedAt: updated.archived, archived: true },
    { ...base, id: 'session-claude', online: true, projectName: 'Dovun', threadId: 'thread-claude', startCommandId: 'start-claude',
      harness: 'claude', locationId: 'location-dovun', title: '最近的 Claude 会话', updatedAt: offlineMostRecent ? updated.older : updated.recent },
    { ...base, id: 'session-offline', online: false, projectName: 'Dovun', threadId: 'thread-offline', startCommandId: 'start-offline',
      harness: 'codex', locationId: 'location-dovun', title: '离线只读历史', updatedAt: offlineMostRecent ? updated.recent : updated.offline },
    { ...base, id: 'session-codex', online: true, projectName: '文档站', threadId: 'thread-codex', startCommandId: 'start-codex',
      harness: 'codex', locationId: 'location-docs', title: '较早的 Codex 会话', updatedAt: updated.older },
  ];
}
function detail(session: FixtureSession) {
  return {
    ...session, current: true,
    snapshot: {
      type: 'snapshot', threadId: session.threadId, epoch: session.epoch, seq: 0,
      view: {
        messages: [
          { id: 'message-user-' + session.id, turnId: 'turn-' + session.id, role: 'user', text: '历史锚点：' + session.title, order: 1 },
          { id: 'message-assistant-' + session.id, turnId: 'turn-' + session.id, role: 'assistant', text: '同一 Harness 会话的虚构历史', order: 2 },
        ],
        turn: null, approvals: [], error: null,
      },
    },
  };
}
async function mockHarness(page: Page, options: { offlineMostRecent?: boolean; listError?: boolean } = {}) {
  const sessions = fixtureSessions(Boolean(options.offlineMostRecent));
  await page.route(/\/api\/v1\/harness-sessions(?:\?.*)?$/, route => {
    if (options.listError) return route.fulfill({ status: 503, json: { data: null, error: '合成列表不可用' } });
    const url = new URL(route.request().url());
    const harness = url.searchParams.get('harness');
    const project = url.searchParams.get('locationId');
    const archived = url.searchParams.get('archived') === '1';
    const rows = sessions.filter(session => (!harness || session.harness === harness) && (!project || session.locationId === project) && Boolean(session.archived) === archived);
    return route.fulfill({ json: { data: { harnesses, nodes, directories, projectPins: [], sessions: rows, nextCursor: null } } });
  });
  await page.route(/\/api\/v1\/harness-sessions\/[^/?]+(?:\?.*)?$/, route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!);
    const session = sessions.find(item => item.id === id);
    if (!session) return route.fulfill({ status: 404, json: { data: null, error: '未知合成会话' } });
    return route.fulfill({ json: { data: detail(session) } });
  });
  await page.route(/\/api\/v1\/harness-sessions\/[^/]+\/events(?:\?.*)?$/, route => route.abort());
  await page.route(/\/api\/v1\/harness-sessions\/native\/index(?:\?.*)?$/, route => route.fulfill({ json: { data: { nextCursor: {} } } }));
  await page.route(/\/api\/projects(?:\?.*)?$/, route => route.fulfill({ json: { data: [] } }));
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '入口测试自行覆盖 390px 与桌面视口。');
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('desktop finds Harness sessions under AI collaboration and reuses the real start dialog', async ({ page }, testInfo) => {
  await mockHarness(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#/today');
  await page.getByText('AI 协作', { exact: true }).click();
  const entry = page.getByTestId('sidebar-harness-sessions');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page).toHaveURL(/#\/runs\?tab=sessions$/);
  await expect(entry).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'AI 执行', exact: true })).not.toHaveAttribute('aria-current', 'page');
  await page.getByRole('radio', { name: 'Claude Code', exact: true }).click();
  const row = page.getByRole('button', { name: /最近的 Claude 会话/ });
  await expect(row).toContainText('Claude Code · Dovun · 验收 Mac');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建会话' });
  await expect(dialog).toContainText('选择要运行 Claude Code 的项目和电脑');
  const project = dialog.getByRole('radio', { name: /Dovun.*验收 Mac/ });
  await expect(project).toBeVisible();
  await project.click();
  await expect(dialog.getByRole('button', { name: '开启 Claude Code 会话' })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('desktop-harness-entry.png'), fullPage: true });
});

test('390px More page opens the list and continues the latest permitted unarchived session across Harnesses', async ({ page }, testInfo) => {
  await mockHarness(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const recentRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/v1/harness-sessions' && url.searchParams.get('order') === 'recent';
  });
  await page.goto('/#/more');
  await recentRequest;
  const main = page.getByTestId('more-harness-sessions');
  const recent = page.getByTestId('more-harness-recent');
  await expect(main).toBeVisible();
  await expect(recent).toBeVisible();
  await expect(recent).toHaveAttribute('data-session-id', 'session-claude');
  await expect(recent).toContainText('最近的 Claude 会话 · Claude Code · Dovun · 验收 Mac');
  expect(await recent.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThan(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('phone-390-harness-entry.png'), fullPage: true });
  await main.click();
  await expect(page).toHaveURL(/#\/runs\?tab=sessions$/);
  await page.goto('/#/more');
  await recent.click();
  await expect(page).toHaveURL(/#\/runs\?tab=sessions&sessionId=session-claude&harness=claude&project=location-dovun$/);
  const chat = page.getByRole('region', { name: '会话详情' });
  await expect(chat.getByText('历史锚点：最近的 Claude 会话', { exact: true })).toBeVisible();
  await expect(chat.locator('header')).toContainText('Claude Code · 验收 Mac');
  await expect(chat.locator('header')).not.toContainText('不应打开的归档会话');
  await page.reload();
  await expect(chat.getByText('历史锚点：最近的 Claude 会话', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#\/more$/);
  await expect(recent).toHaveAttribute('data-session-id', 'session-claude');
  await page.goForward();
  await expect(chat.getByText('历史锚点：最近的 Claude 会话', { exact: true })).toBeVisible();
});

test('offline recent session opens only itself and never enables sending', async ({ page }) => {
  await mockHarness(page, { offlineMostRecent: true });
  const mutations: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.url().includes('/api/v1/harness-sessions') && ['POST', 'PATCH', 'DELETE'].includes(request.method()) &&
      (path.endsWith('/commands') || path.endsWith('/native/open') || path.endsWith('/harness-sessions'))) mutations.push(request.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/more');
  const recent = page.getByTestId('more-harness-recent');
  await expect(recent).toHaveAttribute('data-session-id', 'session-offline');
  await expect(recent).toContainText('查看最近会话');
  await expect(recent).toContainText('电脑离线');
  await recent.click();
  await expect(page).toHaveURL(/sessionId=session-offline/);
  const chat = page.getByRole('region', { name: '会话详情' });
  await expect(chat.getByText('历史锚点：离线只读历史', { exact: true })).toBeVisible();
  await expect(chat.locator('header [role=status]')).toHaveText('电脑离线');
  const composer = chat.getByRole('textbox', { name: '输入消息' });
  await composer.fill('离线状态不应发送');
  await expect(chat.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  expect(mutations).toEqual([]);
});

test('old session deep links and recent-list failure fallback remain compatible', async ({ page }) => {
  await mockHarness(page);
  await page.goto('/#/runs?tab=handoffs');
  await expect(page.getByRole('heading', { name: 'AI 执行', exact: true })).toBeVisible();
  await page.goto('/#/runs?tab=sessions&sessionId=session-claude&harness=claude&project=location-dovun');
  await expect(page.getByRole('region', { name: '会话详情' }).getByText('历史锚点：最近的 Claude 会话', { exact: true })).toBeVisible();
  await mockHarness(page, { listError: true });
  await page.goto('/#/more');
  const recent = page.getByTestId('more-harness-recent');
  await expect(recent).toContainText('暂时无法读取最近会话');
  expect(await recent.getAttribute('data-session-id')).toBeNull();
  await recent.click();
  await expect(page).toHaveURL(/#\/runs\?tab=sessions$/);
});

test('recent-list refresh failure cannot open an old cached session', async ({ page }) => {
  const state = { listError: false };
  await mockHarness(page, state);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/more');
  const recent = page.getByTestId('more-harness-recent');
  await expect(recent).toHaveAttribute('data-session-id', 'session-claude');
  state.listError = true;
  await expect(recent).toContainText('暂时无法读取最近会话', { timeout: 20_000 });
  await expect(recent).not.toHaveAttribute('data-session-id');
  await recent.click();
  await expect(page).toHaveURL(/#\/runs\?tab=sessions$/);
});

test('recent API orders across the page boundary without changing normal pin order', async ({ request }) => {
  const root = process.env.E2E_API_URL;
  if (!root) throw new Error('Missing isolated E2E API URL');
  const prefix = 'harness-entry-recent-e2e-';
  const older = '2026-11-26T01:00:00.000Z';
  const newer = '2026-11-27T01:00:00.000Z';
  const base = { nodeId: prefix + 'node', locationId: prefix + 'location', projectName: 'Synthetic Dovun', createdAt: older, title: 'Synthetic', status: 'ready' };
  const rows = Array.from({ length: 100 }, (_, i) => ({
    ...base, id: prefix + i, startCommandId: prefix + 'start-' + i, nativePinOrder: i, updatedAt: older,
  }));
  try {
    await e2eDatabase.harnessSession.createMany({ data: [
      ...rows,
      { ...base, id: prefix + 'latest', startCommandId: prefix + 'start-latest', harness: 'claude', updatedAt: newer },
      { ...base, id: prefix + 'archived', startCommandId: prefix + 'start-archived', updatedAt: newer, archivedAt: newer },
    ] });
    const ordinary = await request.get(root + '/api/v1/harness-sessions');
    const recent = await request.get(root + '/api/v1/harness-sessions?order=recent');
    expect(ordinary.ok()).toBeTruthy();
    expect(recent.ok()).toBeTruthy();
    const ordinaryRows = (await ordinary.json()).data.sessions;
    const recentRows = (await recent.json()).data.sessions;
    expect(ordinaryRows[0].id).toBe(prefix + 0);
    expect(ordinaryRows.some((row: { id: string }) => row.id === prefix + 'latest')).toBe(false);
    expect(recentRows[0].id).toBe(prefix + 'latest');
    expect(recentRows.some((row: { id: string }) => row.id === prefix + 'archived')).toBe(false);
  } finally {
    await e2eDatabase.harnessSession.deleteMany({ where: { id: { startsWith: prefix } } });
  }
});
