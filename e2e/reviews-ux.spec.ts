import type { Locator, Page } from '@playwright/test';
import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = 'http://127.0.0.1:3015';

test.use({ timezoneId: 'Asia/Shanghai' });
test.beforeEach(resetE2eDatabase);
// react-grab is a dev-only overlay; on a phone it covers the bottom of a fullscreen dialog.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; }); });
test.afterAll(() => e2eDatabase.$disconnect());

async function owner<T>(request: APIRequestContext, path: string, input: unknown) {
  const response = await request.post(`${base}${path}`, { data: input });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as T;
}

async function runRule(request: APIRequestContext, id: string) {
  const response = await request.post(`${base}/api/v1/reviews/rules/${id}/run`, { data: {} });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as { id: string; status: string };
}

function ruleCard(page: Page, name: string) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

function recordsSection(page: Page) {
  return page.getByRole('heading', { name: '回顾记录', exact: true }).locator('xpath=ancestor::section[1]');
}

function scopeScroller(dialog: Locator) {
  return dialog.locator('[class*="max-h-[216px]"]');
}

function hashBatchId(url: string) {
  const hash = new URL(url).hash;
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  return new URLSearchParams(query).get('batch');
}

async function shownLabels(button: Locator) {
  return button.locator('span').evaluateAll((nodes) => nodes.flatMap((node) => {
    const text = node.textContent?.trim() ?? '';
    return text && getComputedStyle(node).display !== 'none' ? [text] : [];
  }));
}

async function settledBox(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate((node) => node.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  return box!;
}

test('空状态展示三步说明，模板只预填对话框', async ({ page }, testInfo) => {
  await page.goto('/#/reviews');
  const create = page.getByRole('button', { name: '新建回顾', exact: true });
  await expect(page.getByRole('heading', { name: '还没有回顾规则', exact: true })).toBeVisible();
  expect(await shownLabels(create)).toEqual([testInfo.project.name === 'mobile' ? '新建' : '新建回顾']);
  for (const text of ['选范围和时间', '收集箱或某几个清单，每天或每周几点', '本机服务按时生成', '统计新增、完成、逾期和阻塞，保存成报告', '建议进入待确认', '选了 AI 整理时，建议由你确认后才生效']) {
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  }

  await page.getByRole('button', { name: '每周项目回顾' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '新建回顾规则', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('回顾名称', { exact: true })).toHaveValue('每周项目回顾');
  await expect(dialog.getByRole('button', { name: '每周', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: '星期五', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByLabel('回顾时间', { exact: true })).toHaveValue('18:00');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await e2eDatabase.reviewRule.count()).toBe(0);
});

test('新建回顾可以搜索范围、选择每周和时区，保存后默认启用', async ({ page }) => {
  const stamp = new Date().toISOString();
  for (const name of ['海盐清单', '甲清单', '乙清单']) await e2eDatabase.topic.create({ data: { name, createdAt: stamp, updatedAt: stamp } });
  const salt = await e2eDatabase.topic.findFirstOrThrow({ where: { name: '海盐清单' } });
  await page.goto('/#/reviews');
  await page.getByRole('button', { name: '新建回顾', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('回顾名称', { exact: true }).fill('海盐周回顾');
  await expect(dialog.getByLabel('搜索清单', { exact: true })).toHaveAttribute('placeholder', '搜索 3 个清单');
  const scroller = scopeScroller(dialog);
  await dialog.getByLabel('搜索清单', { exact: true }).fill('海盐');
  await expect(scroller.getByRole('checkbox')).toHaveCount(1);
  await expect(dialog.getByRole('checkbox', { name: '纳入清单：海盐清单', exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: '纳入清单：甲清单', exact: true })).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: '纳入清单：海盐清单', exact: true }).check();
  await dialog.getByRole('group', { name: '回顾范围', exact: true }).getByRole('button', { name: '已选 2', exact: true }).click();
  await dialog.getByLabel('搜索清单', { exact: true }).fill('');
  await expect(scroller.getByRole('checkbox')).toHaveCount(1);
  await expect(dialog.getByRole('checkbox', { name: '纳入清单：海盐清单', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: '纳入清单：乙清单', exact: true })).toHaveCount(0);

  await dialog.getByRole('button', { name: '每周', exact: true }).click();
  const wednesday = dialog.getByRole('group', { name: '回顾星期', exact: true }).getByRole('button', { name: '星期三', exact: true });
  await wednesday.click();
  await expect(wednesday).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: '更改', exact: true }).click();
  await page.getByLabel('搜索时区', { exact: true }).fill('Asia/Tokyo');
  await page.getByRole('button', { name: 'Asia/Tokyo', exact: true }).click();
  await expect(dialog.getByText('按 Asia/Tokyo', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: '基础回顾（无需模型）', exact: true })).toBeChecked();
  await expect(dialog.getByRole('switch', { name: '保存后立即启用', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const card = ruleCard(page, '海盐周回顾');
  await expect(card).toBeVisible();
  await expect(card).toContainText('下次');
  const saved = await e2eDatabase.reviewRule.findFirstOrThrow();
  expect(saved.enabled).toBe(true);
  expect(saved.frequency).toBe('weekly');
  expect(saved.weekDay).toBe(3);
  expect(saved.timeZone).toBe('Asia/Tokyo');
  expect(JSON.parse(saved.topicIds) as string[]).toContain(salt.id);
});

test('编辑可以直接进入第 2 步，保存后版本加一', async ({ page, request }) => {
  const rule = await owner<{ id: string }>(request, '/api/v1/reviews/rules', { name: '要编辑的规则', includeInbox: true, provider: 'none', enabled: true });
  await page.goto('/#/reviews');
  await ruleCard(page, '要编辑的规则').getByRole('button', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '编辑回顾规则', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '第 2 步：怎么整理', exact: true }).click();
  await expect(dialog.getByText('第 2 步：怎么整理', { exact: true })).toBeVisible();
  await dialog.getByRole('radio', { name: '基础回顾 + 外部 AI 待整理请求', exact: true }).check();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saved = await e2eDatabase.reviewRule.findUniqueOrThrow({ where: { id: rule.id } });
  expect(saved.revision).toBe(2);
  expect(saved.provider).toBe('external');
});

test('关闭开关后不会自动运行，再打开恢复', async ({ page, request }) => {
  const rule = await owner<{ id: string }>(request, '/api/v1/reviews/rules', { name: '可暂停的回顾', includeInbox: true, provider: 'none', enabled: true });
  await page.goto('/#/reviews');
  const card = ruleCard(page, '可暂停的回顾');
  const toggle = card.getByRole('switch', { name: '启用或暂停 可暂停的回顾', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(card).toContainText('不会自动运行');
  await expect.poll(async () => (await e2eDatabase.reviewRule.findUniqueOrThrow({ where: { id: rule.id } })).enabled).toBe(false);
  await toggle.click();
  await expect(card).not.toContainText('不会自动运行');
  await expect(card).toContainText('下次');
  await expect.poll(async () => (await e2eDatabase.reviewRule.findUniqueOrThrow({ where: { id: rule.id } })).enabled).toBe(true);
});

test('生成中只锁当前这张卡', async ({ page, request }) => {
  const ruleA = await owner<{ id: string }>(request, '/api/v1/reviews/rules', { name: '规则甲', includeInbox: true, provider: 'none', enabled: true });
  await owner(request, '/api/v1/reviews/rules', { name: '规则乙', includeInbox: true, provider: 'none', enabled: true });
  await page.goto('/#/reviews');
  await page.route(`**/api/v1/reviews/rules/${ruleA.id}/run`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  const cardA = ruleCard(page, '规则甲');
  const cardB = ruleCard(page, '规则乙');
  await cardA.getByRole('button', { name: '立即生成', exact: true }).click();
  await expect(cardA.getByRole('button', { name: '生成中…', exact: true })).toBeDisabled();
  await expect(cardB.getByRole('button', { name: '立即生成', exact: true })).toBeEnabled();
  await expect(cardB.getByRole('switch', { name: '启用或暂停 规则乙', exact: true })).toBeEnabled();
  const running = recordsSection(page).locator('[aria-busy="true"]');
  await expect(running).toContainText('生成中');
  await expect(running).toContainText('规则甲');
  await expect(cardA.getByRole('button', { name: '立即生成', exact: true })).toBeEnabled();
  await expect(running).toHaveCount(0);
});

test('回顾记录打开抽屉，可以重新生成，深链能打开', async ({ page, request }) => {
  const rule = await owner<{ id: string }>(request, '/api/v1/reviews/rules', { name: '抽屉回顾', includeInbox: true, provider: 'none', enabled: true });
  const batch = await runRule(request, rule.id);
  await page.goto('/#/reviews');
  await recordsSection(page).getByRole('button', { name: '抽屉回顾' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('pre')).toHaveCount(0);
  await expect(dialog.locator('.markdown-body').getByRole('heading', { name: '抽屉回顾', exact: true })).toBeVisible();
  for (const label of ['新增', '完成', '逾期', '阻塞']) await expect(dialog.getByText(label, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect.poll(() => e2eDatabase.reviewBatch.count()).toBe(2);
  // The server finishes before the page switches the drawer to the new batch. Closing earlier gets overwritten.
  await expect.poll(() => hashBatchId(page.url())).not.toBe(batch.id);
  const refreshed = page.getByRole('dialog');
  await expect(refreshed).toBeVisible();
  await refreshed.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto(`/#/reviews?batch=${batch.id}`);
  const linked = page.getByRole('dialog');
  await expect(linked).toBeVisible();
  await expect(linked.locator('.markdown-body').getByRole('heading', { name: '抽屉回顾', exact: true })).toBeVisible();
});

test('失效清单导致失败，移除后才能保存，需处理只剩这一条', async ({ page, request }) => {
  const topic = await owner<{ id: string }>(request, '/api/topics', { name: '清单 X' });
  // Paused rules keep API order. The failed rule is created later so its card stays first.
  const normal = await owner<{ id: string }>(request, '/api/v1/reviews/rules', { name: '正常周报', includeInbox: true, provider: 'none', enabled: false });
  await runRule(request, normal.id);
  const failed = await owner<{ id: string }>(request, '/api/v1/reviews/rules', { name: '失效范围', topicIds: [topic.id], includeInbox: true, provider: 'none', enabled: false });
  await e2eDatabase.reviewRule.update({ where: { id: normal.id }, data: { createdAt: '2026-10-20T00:00:00.000Z' } });
  await e2eDatabase.reviewRule.update({ where: { id: failed.id }, data: { createdAt: '2026-10-20T00:00:01.000Z' } });
  await e2eDatabase.topic.delete({ where: { id: topic.id } });
  expect((await runRule(request, failed.id)).status).toBe('failed');

  await page.goto('/#/reviews');
  const records = recordsSection(page);
  await expect(records.getByText('失败', { exact: true })).toBeVisible();
  await expect(page.getByRole('article').getByRole('heading').nth(0)).toHaveText('失效范围');
  await expect(page.getByRole('article').getByRole('heading').nth(1)).toHaveText('正常周报');
  const card = ruleCard(page, '失效范围');
  const alert = card.getByRole('alert');
  await expect(alert).toHaveClass(/destructive/);
  await expect(alert).toContainText('清单不存在');
  await expect(alert.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await alert.getByRole('button', { name: '编辑范围，移除失效清单', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('第 1 步：回顾什么、什么时候', { exact: true })).toBeVisible();
  const missing = dialog.getByRole('checkbox', { name: '纳入清单：已失效清单', exact: true });
  await expect(missing).toBeVisible();
  await expect(missing).toBeChecked();
  await expect(dialog.getByRole('button', { name: '下一步', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '第 2 步：怎么整理', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '上一步', exact: true }).click();
  // Unchecking drops the id from the draft, so the invalid row unmounts instead of staying unchecked.
  await missing.evaluate((element) => { (element as HTMLInputElement).click(); });
  await expect(missing).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '下一步', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '下一步', exact: true }).click();
  const save = dialog.getByRole('button', { name: '保存', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(JSON.parse((await e2eDatabase.reviewRule.findUniqueOrThrow({ where: { id: failed.id } })).topicIds) as string[]).not.toContain(topic.id);

  await page.getByRole('group', { name: '记录筛选', exact: true }).getByRole('button', { name: '需处理', exact: true }).click();
  const list = records.locator('.glass-subtle');
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list.getByRole('button')).toContainText('失败');
  await expect(list.getByRole('button')).toContainText('失效范围');
  await expect(list.getByRole('button')).not.toContainText('正常周报');
});

test('删除规则后卡片消失，记录仍在并标成已删除', async ({ page, request }) => {
  const rule = await owner<{ id: string }>(request, '/api/v1/reviews/rules', { name: '要删除的回顾', includeInbox: true, provider: 'none', enabled: true });
  await runRule(request, rule.id);
  await page.goto('/#/reviews');
  const card = ruleCard(page, '要删除的回顾');
  await card.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByRole('heading', { name: '删除「要删除的回顾」？', exact: true })).toBeVisible();
  await confirm.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(0);
  expect((await e2eDatabase.reviewRule.findUniqueOrThrow({ where: { id: rule.id } })).deletedAt).toEqual(expect.any(String));
  const records = recordsSection(page);
  await expect(records.getByText('要删除的回顾', { exact: true })).toBeVisible();
  await expect(records.getByText('已删除', { exact: true })).toBeVisible();
  expect(await e2eDatabase.reviewBatch.count()).toBe(1);
});

test('没配置模型时内置回顾不能启用', async ({ page, request }) => {
  expect(await e2eDatabase.appSetting.count()).toBe(0);
  await page.goto('/#/reviews');
  await page.getByRole('button', { name: '新建回顾', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('回顾名称', { exact: true }).fill('内置模型回顾');
  await dialog.getByRole('button', { name: '下一步', exact: true }).click();
  await dialog.getByRole('radio', { name: '基础回顾 + 内置模型建议', exact: true }).check();
  await expect(dialog.getByText('还没配置模型').first()).toBeVisible();
  const enable = dialog.getByRole('switch', { name: '保存后立即启用', exact: true });
  await expect(enable).toBeDisabled();
  await expect(enable).not.toBeChecked();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saved = await e2eDatabase.reviewRule.findFirstOrThrow();
  expect(saved.enabled).toBe(false);
  expect(saved.provider).toBe('builtin');

  const response = await request.post(`${base}/api/v1/reviews/rules`, { data: { name: '接口门闩', includeInbox: true, provider: 'builtin', enabled: true } });
  expect(response.status()).toBe(400);
  expect((await response.json()).code).toBe('MODEL_NOT_CONFIGURED');
  expect(await e2eDatabase.reviewRule.count()).toBe(1);
});

test('有待确认建议时从记录跳到待确认', async ({ page, request }) => {
  const rule = await owner<{ id: string }>(request, '/api/v1/reviews/rules', { name: '带建议的回顾', includeInbox: true, provider: 'none', enabled: true });
  const batch = await runRule(request, rule.id);
  const stamp = new Date().toISOString();
  const proposal = await e2eDatabase.proposal.create({ data: { actorId: 'e2e', status: 'pending', commands: '[]', preconditions: '[]', preview: '[]', createdAt: stamp, updatedAt: stamp } });
  const organization = await e2eDatabase.organizationRequest.create({ data: { proposalIds: JSON.stringify([proposal.id]), status: 'proposed', snapshot: '{}', purpose: 'x', provider: 'builtin', createdAt: stamp, updatedAt: stamp } });
  await e2eDatabase.reviewBatch.update({ where: { id: batch.id }, data: { organizationIds: JSON.stringify([organization.id]) } });
  await page.goto('/#/reviews');
  const link = recordsSection(page).getByRole('link', { name: '1 条建议待确认', exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/proposals');
});

test('手机对话框和抽屉铺满视口，桌面抽屉不超过 520', async ({ page, request }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  const first = await owner<{ id: string }>(request, '/api/v1/reviews/rules', { name: '首屏规则', includeInbox: true, provider: 'none', enabled: true });
  await owner(request, '/api/v1/reviews/rules', { name: '第二条规则', includeInbox: true, provider: 'none', enabled: false });
  const batch = await runRule(request, first.id);
  await page.goto('/#/reviews');
  if (mobile) {
    const card = page.getByRole('article').first();
    await expect(card).toBeVisible();
    const cardBox = await card.boundingBox();
    const viewport = page.viewportSize();
    expect(cardBox && viewport && cardBox.y >= 0 && cardBox.y < viewport.height).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await page.getByRole('button', { name: '新建回顾', exact: true }).click();
    const dialog = page.getByRole('dialog');
    expect((await settledBox(dialog)).width).toBe(page.viewportSize()!.width);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.goto(`/#/reviews?batch=${batch.id}`);
  const width = (await settledBox(page.getByRole('dialog'))).width;
  if (mobile) expect(width).toBe(page.viewportSize()!.width);
  else expect(width).toBeLessThanOrEqual(520);
});
