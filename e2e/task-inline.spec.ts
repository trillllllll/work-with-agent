import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const evidence = resolve(process.env.DOVUN_EVIDENCE_DIR ? `${process.env.DOVUN_EVIDENCE_DIR}/task-inline` : 'docs/design/dovun/task-inline/evidence');
test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());

test('48px inline cards adapt tags to available space and expose all names without opening detail', async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);
  const names = ['AI提效', '青鸟售后', '青鸟QA', '👩🏽‍💻开发', '异常排查', '文档整理', '客户沟通', '接口联调'];
  const tagIds: string[] = [];
  for (const [index, name] of names.entries()) {
    const response = await request.post(`${api}/api/tags`, { data: { name, color: index === 0 ? 'teal' : 'violet' } });
    expect(response.ok()).toBe(true);
    tagIds.push((await response.json()).data.id);
  }
  const create = async (title: string, extra: object = {}) => {
    const response = await request.post(`${api}/api/tasks`, { data: { title, ...extra } });
    expect(response.ok()).toBe(true);
    return (await response.json()).data;
  };
  const short = await create('整理工作', { tagIds: tagIds.slice(0, 2) });
  const long = await create('核对接口文档与重试逻辑，确认异常情况下的处理方式及下一步安排'.repeat(3), { tagIds, priority: 'high', scheduledStart: '2026-12-31T23:30', scheduledEnd: '2027-01-01T01:00' });
  await create('没有标签的普通任务');
  await create('售后线服务调用这里的架构图，整理阅读结论', { tagIds: tagIds.slice(1, 3), dueDate: '2026-10-24' });
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'dark'); (window as any).__REACT_GRAB_DISABLED__ = true; });
  const errors: string[] = [], browserNotifications: { phase: string; message: string }[] = [];
  let phase = 'list';
  page.on('pageerror', error => {
    if (error.message === 'ResizeObserver loop completed with undelivered notifications.') browserNotifications.push({ phase, message: error.message });
    else errors.push(error.message);
  });
  await page.goto('/#/inbox');
  const shortRow = page.getByTestId(`task-row-${short.id}`), longRow = page.getByTestId(`task-row-${long.id}`);
  await expect(longRow).toBeVisible();
  const results: unknown[] = [];
  await mkdir(evidence, { recursive: true });
  for (const language of ['zh-CN', 'en']) {
    await page.evaluate(language => localStorage.setItem('dovun.language', language), language);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    for (const theme of ['light', 'dark']) for (const width of [1586, 1280, 1024, 578, 390, 320]) {
      await page.setViewportSize({ width, height: 992 });
      await page.evaluate(theme => { document.documentElement.className = theme; }, theme);
      await expect(longRow).toHaveCSS('height', '48px');
      await expect(longRow.locator('.task-inline-content')).toHaveAttribute('data-short-tags', 'true');
      // Wait for the resize observer's scheduled measurement to settle.
      await page.waitForTimeout(80);
      const metrics = await longRow.evaluate(row => {
        const title = row.querySelector('.task-inline-title')!.getBoundingClientRect();
        const tags = row.querySelector('.task-inline-tags')!.getBoundingClientRect();
        const time = row.querySelector('time')!.getBoundingClientRect();
        return { rowHeight: row.getBoundingClientRect().height, titleWidth: title.width, sameLine: Math.abs(title.top + title.height / 2 - tags.top - tags.height / 2) < 2 && Math.abs(title.top + title.height / 2 - time.top - time.height / 2) < 2, overflow: document.documentElement.scrollWidth > innerWidth, rowOverflow: row.scrollWidth > row.clientWidth + 1 };
      });
      expect(metrics.sameLine).toBe(true);
      expect(metrics.overflow).toBe(false);
      expect(metrics.rowOverflow).toBe(false);
      expect(metrics.titleWidth).toBeGreaterThan(35);
      if (width === 390) await expect(longRow.locator('.task-tag-count')).toBeVisible();
      results.push({ language, theme, width, ...metrics });
      if (testInfo.project.name === 'chromium' && [1586, 390].includes(width)) await page.screenshot({ path: `${evidence}/inbox-${language}-${theme}-${width}.png`, animations: 'disabled' });
    }
  }
  await page.setViewportSize({ width: 1586, height: 992 });
  await expect(shortRow.locator('.task-inline-content')).not.toHaveAttribute('data-short-tags');
  await page.setViewportSize({ width: 390, height: 992 });
  const trigger = longRow.locator('button.task-inline-tags');
  phase = 'tagPopover';
  await trigger.focus();
  await page.keyboard.press('Enter');
  const popover = page.locator('.task-tag-popover');
  await expect(popover).toBeVisible();
  for (const name of names) await expect(popover.getByText(`#${name}`, { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Task title', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(popover).toHaveCount(0);
  // Touch/click follows the same accessible Popover path.
  await trigger.click();
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  phase = 'detail';
  await longRow.getByRole('button', { name: long.title, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue(long.title);
  await expect(longRow.locator('.task-inline-schedule time')).toHaveText('12/31 23:30 ↗');
  expect(errors).toEqual([]);
  expect(browserNotifications.filter(item => item.phase !== 'detail')).toEqual([]);
  expect(browserNotifications.length).toBeLessThanOrEqual(1);
  await writeFile(`${evidence}/audit-${testInfo.project.name}.json`, JSON.stringify({ results, errors, browserNotifications, tagPopover: true, fullTitle: true }, null, 2) + '\n');
});

test('inline card controls keep completion, AI selection, menus and detail autosave independent', async ({ page, request }) => {
  const response = await request.post(`${api}/api/tasks`, { data: { title: '单行交互回归' } });
  const task = (await response.json()).data;
  await page.goto('/#/inbox');
  const row = page.getByTestId(`task-row-${task.id}`);
  await row.hover();
  const ai = row.getByRole('button', { name: '选入 AI 上下文：单行交互回归' });
  await ai.click();
  await expect(ai).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveCount(0);
  await row.getByRole('button', { name: '任务操作：单行交互回归', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: task.title, exact: true }).click();
  await page.getByRole('textbox', { name: '任务标题', exact: true }).fill('中文输入与自动保存');
  await expect.poll(async () => (await (await request.get(`${api}/api/tasks/${task.id}`)).json()).data.title).toBe('中文输入与自动保存');
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await row.getByRole('checkbox').click();
  await page.getByText('已完成 · 1', { exact: true }).click();
  await expect(row).toHaveCSS('height', '48px');
  await row.getByRole('checkbox').click();
  await expect(row.getByRole('checkbox')).not.toBeChecked();
});

test('parent cards, today source labels and right rail preserve the same inline geometry', async ({ page, request }, testInfo) => {
  const today = new Date().toLocaleDateString('sv-SE');
  const topicResponse = await request.post(`${api}/api/topics`, { data: { name: '交付与日常工作' } });
  const topicId = (await topicResponse.json()).data.id;
  const parentResponse = await request.post(`${api}/api/tasks`, { data: { title: '整理本轮交付与资料', topicId, dueDate: today } });
  const parent = (await parentResponse.json()).data;
  const labelIds = [];
  for (const name of ['交付', '异常', '代码', '文档', '测试', '待处理']) labelIds.push((await (await request.post(`${api}/api/tags`, { data: { name } })).json()).data.id);
  const childResponse = await request.post(`${api}/api/tasks`, { data: { title: '核对截图和测试证据', topicId, parentId: parent.id, tagIds: labelIds, priority: 'high', scheduledStart: '2026-12-31T23:30', scheduledEnd: '2027-01-01T01:00' } });
  expect(childResponse.ok(), await childResponse.text()).toBe(true);
  const child = (await childResponse.json()).data;
  for (const status of ['doing', 'blocked']) {
    const response = await request.patch(`${api}/api/tasks/${child.id}`, { data: { status } });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.addInitScript(topicId => localStorage.setItem('dovun.selectedTopic', topicId), topicId);
  await page.goto('/#/board');
  const parentRow = page.getByTestId(`task-row-${parent.id}`), childRow = page.getByTestId(`task-row-${child.id}`);
  await expect(childRow).toHaveCSS('height', '48px');
  await parentRow.getByRole('button', { name: '收起子任务：整理本轮交付与资料' }).click();
  await expect(childRow).toHaveCount(0);
  await parentRow.getByRole('button', { name: '展开子任务：整理本轮交付与资料' }).click();
  await expect(childRow).toHaveCSS('height', '48px');
  await mkdir(evidence, { recursive: true });
  for (const width of [1586, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 992 });
    await page.evaluate(theme => { document.documentElement.className = theme; }, theme);
    await expect(parentRow).toHaveCSS('height', '48px');
    if (testInfo.project.name === 'chromium') await page.screenshot({ path: `${evidence}/children-${theme}-${width}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1586, height: 992 });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 992 });
    await page.waitForTimeout(100);
    expect(await childRow.locator('.task-inline-title').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(30);
  }
  const schedule = childRow.locator('.task-inline-schedule');
  if (testInfo.project.name === 'mobile') await schedule.tap();
  else await schedule.focus();
  const dateTip = page.locator('[data-slot="tooltip-content"]');
  await expect(dateTip).toBeVisible();
  await dateTip.click({ position: { x: 3, y: 3 } });
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveCount(0);
  await expect(page.locator('.task-drag-overlay')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await request.patch(`${api}/api/tasks/${child.id}`, { data: { scheduledStart: `${today}T23:30`, scheduledEnd: `${new Date(Date.now() + 86_400_000).toLocaleDateString('sv-SE')}T01:00` } });
  await page.setViewportSize({ width: 1586, height: 992 });
  await page.goto('/#/today');
  await expect(parentRow.locator('.task-place-chip').first()).toBeVisible();
  for (const width of [390, 360, 320, 1586]) {
    await page.setViewportSize({ width, height: 992 });
    await page.waitForTimeout(100);
    const geometry = await childRow.evaluate(row => {
      const title = row.querySelector('.task-inline-title')!.getBoundingClientRect();
      const info = row.querySelector('.task-inline-info:not(.task-info-full):not(.task-info-short):not(.task-info-summary)')?.getBoundingClientRect();
      const tags = row.querySelector('.task-inline-tags')!.getBoundingClientRect();
      const time = row.querySelector('.task-inline-schedule')!.getBoundingClientRect();
      return { title: title.width, separate: (info ? title.right <= info.left + 1 && info.right <= tags.left + 1 : title.right <= tags.left + 1) && tags.right <= time.left + 1 };
    });
    expect(geometry.title).toBeGreaterThan(30);
    expect(geometry.separate).toBe(true);
  }
  await parentRow.getByRole('button', { name: parent.title, exact: true }).click();
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(parent.title);
  await expect(parentRow).toHaveCSS('height', '48px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (testInfo.project.name === 'chromium') await page.screenshot({ path: `${evidence}/today-detail-dark-1586.png`, animations: 'disabled' });
});
