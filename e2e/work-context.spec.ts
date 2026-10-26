import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
  });
});
test.afterAll(() => e2eDatabase.$disconnect());

async function command(request: APIRequestContext, commands: unknown[]) {
  const response = await request.post(`${base}/api/v1/commands`, { data: { requestId: crypto.randomUUID(), commands } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data.results[0];
}

async function project(request: APIRequestContext, name: string) {
  const response = await request.post(`${base}/api/topics`, { data: { name } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data.id as string;
}

async function proposeMemory(request: APIRequestContext, topicId: string | null, title: string) {
  const material = await command(request, [{ kind: 'material.create', input: { topicId, kind: 'text', title: `${title}的资料`, content: `${title}的原文` } }]) as { id: string; revision: number };
  const created = await request.post(`${base}/api/v1/knowledge/organizations`, { data: { topicId, purpose: title, provider: 'external', materialIds: [material.id] } });
  expect(created.ok(), await created.text()).toBe(true);
  const organization = (await created.json()).data as { id: string; snapshot: { sources: Array<{ type: string; id: string; revision: number; hash?: string }> } };
  const source = organization.snapshot.sources.find((item) => item.type === 'material' && item.id === material.id);
  expect(source?.revision).toBe(material.revision);
  expect(source?.hash).toBeTruthy();
  const submitted = await request.post(`${base}/api/v1/knowledge/organizations/${organization.id}/candidates`, {
    data: {
      summary: title,
      commands: [{
        kind: 'memory.create',
        input: {
          topicId,
          kind: 'fact',
          title,
          content: `${title}的建议正文`,
          evidence: [{ type: 'material', id: source!.id, revision: source!.revision, hash: source!.hash }],
          reason: '资料里写明了',
          importance: 3,
          labels: ['验收'],
        },
      }],
    },
  });
  expect(submitted.ok(), await submitted.text()).toBe(true);
  const proposalId = (await submitted.json()).data.proposalIds[0] as string;
  expect(proposalId).toBeTruthy();
  return { proposalId, material };
}

async function shot(page: Page, projectName: string, name: string) {
  if (projectName !== 'chromium') return;
  await page.screenshot({ path: `test-results/work-context/${name}.png`, fullPage: false });
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  const toggle = page.getByRole('button', { name: '切换主题', exact: true });
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await page.getByRole('menuitem', { name: theme === 'dark' ? '深色' : '浅色', exact: true }).click();
    return;
  }
  await page.evaluate((value) => {
    localStorage.setItem('dovun.theme', value);
    document.documentElement.classList.toggle('dark', value === 'dark');
  }, theme);
}

test('工作上下文默认显示当前进展，建议不会直接变成记忆', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const { proposalId } = await proposeMemory(request, null, '待确认的发布事实');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/knowledge');

  await expect(page.getByRole('heading', { name: '工作上下文', exact: true })).toBeVisible();
  const tabs = page.getByTestId('context-tabs');
  await expect(tabs.getByRole('tab')).toHaveText(['当前进展', '参考资料', '长期记忆']);
  await expect(tabs.getByRole('tab', { name: '当前进展', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('context-auto-status')).toBeVisible();
  await expect(page.getByText('资料、任务和本应用聊天发生变化后自动整理，建议确认后生效。', { exact: true })).toBeVisible();
  const wideBrief = await page.getByTestId('context-brief').boundingBox();
  const wideRail = await page.getByTestId('context-rail').boundingBox();
  expect(wideBrief && wideRail).toBeTruthy();
  expect(wideRail!.x).toBeGreaterThan(wideBrief!.x + 40);
  expect(wideRail!.y).toBeLessThan(wideBrief!.y + wideBrief!.height);
  if (testInfo.project.name === 'chromium') {
    await expect(page.getByRole('region', { name: '积累', exact: true }).getByRole('button')).toHaveText(['资料库', '工作上下文', '定期回顾']);
    await expect(page.getByRole('region', { name: 'AI 协作', exact: true }).getByRole('button')).toContainText(['AI 助手', '待确认', '技能', 'AI 连接', 'AI 执行']);
  }
  await setTheme(page, 'light');
  await shot(page, testInfo.project.name, '1440-light-brief');
  await setTheme(page, 'dark');
  await shot(page, testInfo.project.name, '1440-dark-brief');
  await setTheme(page, 'light');

  await tabs.getByRole('tab', { name: '长期记忆', exact: true }).click();
  await expect(page.getByTestId('context-memory-empty')).toBeVisible();
  await expect(page.getByLabel('搜索记忆', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('context-pagination')).toHaveCount(0);
  await expect(page.getByText('结果 0 条', { exact: true })).toHaveCount(0);
  await setTheme(page, 'dark');
  await shot(page, testInfo.project.name, '1440-dark-memory-empty');

  await page.setViewportSize({ width: 390, height: 844 });
  const root = page.getByTestId('work-context');
  expect(await root.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await tabs.getByRole('tab', { name: '当前进展', exact: true }).click();
  const narrowBrief = await page.getByTestId('context-brief').boundingBox();
  const narrowRail = await page.getByTestId('context-rail').boundingBox();
  expect(narrowBrief && narrowRail).toBeTruthy();
  expect(narrowRail!.y + narrowRail!.height).toBeLessThanOrEqual(narrowBrief!.y + 2);
  expect(await root.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await setTheme(page, 'light');
  await shot(page, testInfo.project.name, '390-light-tabs');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(root).toHaveCSS('background-color', 'rgb(39, 46, 53)');
  await shot(page, testInfo.project.name, '390-dark-tabs');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await tabs.getByRole('tab', { name: '当前进展', exact: true }).click();
  await expect(page.getByTestId(`context-proposal-${proposalId}`)).toBeVisible();
  expect(await e2eDatabase.memory.count({ where: { topicId: null } })).toBe(0);

  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: '资料库', exact: true })).toBeVisible();
});

test('旧路由、范围和标签在刷新、后退、前进后保持', async ({ page, request }) => {
  const topicId = await project(request, '范围清单');
  await page.goto(`/#/knowledge/brief?topicId=${topicId}`);
  const scope = page.getByLabel('所属清单', { exact: true });
  await expect(scope).toHaveValue(topicId);
  await page.getByTestId('context-toolbar').getByRole('button', { name: '更多', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '导出当前范围', exact: true })).toHaveAttribute('href', new RegExp(`/api/v1/knowledge/export\\?topicId=${topicId}`));
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: '参考资料', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/knowledge/materials\\?topicId=${topicId}$`));
  await page.reload();
  await expect(page.getByRole('tab', { name: '参考资料', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(scope).toHaveValue(topicId);
  await page.goBack();
  await expect(page.getByRole('tab', { name: '当前进展', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(scope).toHaveValue(topicId);
  await page.goForward();
  await expect(page.getByRole('tab', { name: '参考资料', exact: true })).toHaveAttribute('aria-selected', 'true');

  await page.goto('/#/knowledge/memories?topicId=inbox');
  await expect(page.getByTestId('context-memory-empty')).toBeVisible();
  await page.goto('/#/knowledge/search?topicId=inbox');
  await expect(page.getByLabel('搜索上下文', { exact: true })).toBeVisible();
  await page.goto('/#/knowledge/tree?topicId=inbox');
  await expect(page.getByRole('navigation', { name: '知识树', exact: true })).toBeVisible();
  await page.goto('/#/knowledge/graph?topicId=inbox');
  await expect(page.getByLabel('知识关系图', { exact: true })).toBeVisible();
  await page.goto('/#/knowledge/missing?topicId=inbox');
  await expect(page.getByRole('tab', { name: '当前进展', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goto('/#/knowledge/brief?topicId=missing-topic');
  await expect(page.getByRole('alert')).toHaveText('这个清单不存在。');
  await expect(page.getByLabel('所属清单', { exact: true })).toHaveValue('missing-topic');
  await expect(page.getByTestId('context-auto-status')).toHaveCount(0);
});

test('搜索无命中、历史筛选和请求失败使用不同文案', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const topicId = await project(request, '记忆文案清单');
  const created = await request.post(`${base}/api/v1/knowledge/memories`, { data: { topicId, title: '已经确认的事实', content: '这条记忆仍然有效。', kind: 'fact', reason: '人工记录' } });
  expect(created.ok(), await created.text()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/#/knowledge/memories?topicId=${topicId}`);
  await expect(page.getByRole('button', { name: /已经确认的事实/ })).toBeVisible();
  await setTheme(page, 'dark');
  await shot(page, testInfo.project.name, '1440-dark-memory-records');

  const search = page.getByLabel('搜索记忆', { exact: true });
  await search.fill('不存在的关键词');
  await expect(page.getByText('没有找到匹配的记忆。', { exact: true })).toBeVisible();
  await expect(page.getByTestId('context-memory-empty')).toHaveCount(0);
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('button', { name: /已经确认的事实/ })).toBeVisible();

  await page.getByRole('button', { name: /已经确认的事实/ }).click();
  await page.getByRole('button', { name: '设为历史', exact: true }).click();
  await expect(page.getByText('当前没有活跃记忆。', { exact: true })).toBeVisible();
  await expect(page.getByTestId('context-memory-empty')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '历史', exact: true })).toBeVisible();
  await shot(page, testInfo.project.name, '1440-dark-memory-filtered');
  await page.getByRole('button', { name: '查看历史', exact: true }).click();
  await expect(page.getByRole('button', { name: /已经确认的事实/ })).toBeVisible();

  await page.route('**/api/v1/knowledge/memories**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ data: null, error: '记忆列表暂时不可用', code: 'UNAVAILABLE' }) }));
  await page.getByLabel('搜索记忆', { exact: true }).fill('请求会失败');
  await expect(page.getByRole('alert')).toContainText('记忆列表暂时不可用');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await expect(page.getByTestId('context-memory-empty')).toHaveCount(0);
  await expect(page.getByText('没有找到匹配的记忆。', { exact: true })).toHaveCount(0);
  await expect(page.getByText('当前没有活跃记忆。', { exact: true })).toHaveCount(0);
});

test('中文组词期间不搜索，后返回的其他清单不会覆盖当前清单', async ({ page, request }) => {
  const topicA = await project(request, '清单甲');
  const topicB = await project(request, '清单乙');
  for (const [topicId, title] of [[topicA, '甲清单独有记忆'], [topicB, '乙清单独有记忆']] as const) {
    const created = await request.post(`${base}/api/v1/knowledge/memories`, { data: { topicId, title, content: `${title}的正文`, kind: 'fact', reason: '人工记录' } });
    expect(created.ok(), await created.text()).toBe(true);
  }
  await page.goto(`/#/knowledge/memories?topicId=${topicA}`);
  const search = page.getByLabel('搜索记忆', { exact: true });
  await expect(search).toBeVisible();
  const during: string[] = [];
  const onRequest = (req: { url(): string }) => {
    if (!req.url().includes('/api/v1/knowledge/memories')) return;
    during.push(new URL(req.url()).searchParams.get('q') ?? '');
  };
  page.on('request', onRequest);
  await search.evaluate((el) => {
    const input = el as HTMLInputElement;
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '工作');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '工作', inputType: 'insertCompositionText', isComposing: true }));
  });
  await expect(search).toHaveValue('工作');
  await page.waitForTimeout(400);
  expect(during.filter((query) => query.length > 0)).toEqual([]);
  page.off('request', onRequest);
  const sent = page.waitForRequest((req) => req.url().includes('/api/v1/knowledge/memories') && new URL(req.url()).searchParams.get('q') === '工作');
  await search.evaluate((el) => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '工作' })));
  await sent;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route('**/api/v1/knowledge/memories**', async (route) => {
    const url = new URL(route.request().url());
    if (held || url.searchParams.get('topicId') !== topicA || url.searchParams.get('status') !== 'active') {
      await route.continue();
      return;
    }
    held = true;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.reload();
  await expect.poll(() => held).toBe(true);
  await page.getByLabel('所属清单', { exact: true }).selectOption(topicB);
  await expect(page.getByRole('button', { name: /乙清单独有记忆/ })).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: /乙清单独有记忆/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /甲清单独有记忆/ })).toHaveCount(0);
});

test('确认建议后刷新进展和记忆，版本冲突保留卡片', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const stale = await proposeMemory(request, null, '过期来源的建议');
  const fresh = await proposeMemory(request, null, '可以确认的建议');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/knowledge/brief?topicId=inbox');
  const staleCard = page.getByTestId(`context-proposal-${stale.proposalId}`);
  const freshCard = page.getByTestId(`context-proposal-${fresh.proposalId}`);
  await expect(staleCard).toBeVisible();
  await expect(freshCard).toBeVisible();
  expect(await e2eDatabase.memory.count({ where: { topicId: null } })).toBe(0);

  await command(request, [{ kind: 'material.update', targetId: stale.material.id, expectedRevision: stale.material.revision, input: { content: '原文已经改过' } }]);
  await staleCard.getByRole('button', { name: '确认', exact: true }).click();
  await expect(staleCard.getByRole('alert')).toContainText('来源已变化');
  await expect(staleCard).toBeVisible();
  expect(await e2eDatabase.memory.count({ where: { topicId: null } })).toBe(0);

  await page.setViewportSize({ width: 1024, height: 768 });
  await setTheme(page, 'dark');
  await shot(page, testInfo.project.name, '1024-dark-proposal-error');

  await freshCard.getByRole('button', { name: '确认', exact: true }).click();
  await expect(freshCard).toHaveCount(0);
  await expect.poll(() => e2eDatabase.memory.count({ where: { topicId: null } })).toBe(1);
  await expect(page.getByText('可以确认的建议', { exact: false }).first()).toBeVisible();
  await page.getByRole('tab', { name: '长期记忆', exact: true }).click();
  await expect(page.getByRole('button', { name: /可以确认的建议/ })).toBeVisible();
  await expect(page.getByTestId('context-memory-empty')).toHaveCount(0);
});

test('键盘可以切换标签、关闭菜单，并在关闭编辑后回到触发按钮', async ({ page, request }) => {
  const { proposalId } = await proposeMemory(request, null, '键盘编辑的建议');
  await page.goto('/#/knowledge/brief?topicId=inbox');
  await page.getByRole('tab', { name: '当前进展', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '参考资料', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: '参考资料', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: '当前进展', exact: true })).toHaveAttribute('aria-selected', 'true');

  const view = page.getByRole('button', { name: '查看方式', exact: true });
  await view.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: '关系图', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: '关系图', exact: true })).toHaveCount(0);
  await expect(view).toBeFocused();

  const edit = page.getByTestId(`context-proposal-${proposalId}`).getByRole('button', { name: '编辑后确认', exact: true });
  await edit.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '编辑后确认', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
});

test('任务关联资料弹窗可以编辑资料，不出现工作上下文标题和自动提炼', async ({ page, request }) => {
  const created = await request.post(`${base}/api/tasks`, { data: { title: '需要弹窗资料的任务' } });
  expect(created.ok(), await created.text()).toBe(true);
  const taskId = (await created.json()).data.id as string;
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await page.getByRole('button', { name: '任务操作：需要弹窗资料的任务', exact: true }).click();
  await page.getByRole('menuitem', { name: '关联资料', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '关联资料', exact: true });
  await expect(dialog.getByRole('heading', { name: '工作上下文', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('自动提炼')).toHaveCount(0);
  await expect(dialog.getByText('所属清单的长期记忆', { exact: true })).toHaveCount(0);
  await dialog.getByRole('tab', { name: '参考资料', exact: true }).click();
  await dialog.getByRole('button', { name: '保存材料', exact: true }).click();
  await dialog.getByLabel('材料标题', { exact: true }).fill('弹窗里的资料');
  await dialog.getByLabel('材料正文', { exact: true }).fill('从任务弹窗保存的原文');
  await dialog.getByRole('button', { name: '保存材料', exact: true }).last().click();
  await expect(dialog.getByRole('button', { name: '弹窗里的资料', exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: '长期记忆', exact: true }).click();
  await expect(dialog.getByText('所属清单的长期记忆', { exact: true })).toBeVisible();
  await expect(dialog.getByText('自动提炼')).toHaveCount(0);
  expect(taskId).toBeTruthy();
});
