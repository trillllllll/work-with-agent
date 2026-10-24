import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
import { mkdir } from 'node:fs/promises';

const api = process.env.E2E_API_URL!;
const evidence = 'docs/design/dovun/control-reuse/evidence';
const material = (el: Element) => {
  const s = getComputedStyle(el);
  return { paint: s.backgroundImage, shadow: s.boxShadow, border: s.borderTopColor, radius: s.borderTopLeftRadius };
};
test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());

test('settings and populated assistant compose shared materials in light and dark at desktop and phone widths', async ({ page, request }, info) => {
  test.setTimeout(120_000);
  const response = await request.post(`${api}/api/tasks`, { data: { title: '整理个人工作台的任务和资料' } });
  expect(response.ok()).toBe(true);
  const task = (await response.json()).data;
  const calls = ['list_tasks', 'list_topics'].map((name, i) => ({ id: `lookup-${i}`, function: { name, arguments: '{}' } }));
  await page.route('**/api/conversations/shared-controls/snapshot', route => route.fulfill({ json: { data: {
    messages: [
      { id: 'reply', role: 'assistant', content: '已经整理相关资料，下面是本次查询记录。', status: 'completed', toolCalls: JSON.stringify(calls), sources: [{ kind: 'task', id: task.id, title: task.title, revision: 1 }] },
      ...calls.map((call, i) => ({ id: `result-${i}`, role: 'tool', toolCallId: call.id, content: JSON.stringify({ success: true, data: [] }), status: 'completed' })),
    ], approvals: [], watermarks: {}, activeRun: null,
  } } }));
  await page.addInitScript(() => { localStorage.setItem('dovun.conversationId', 'shared-controls'); localStorage.setItem('dovun.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
  await mkdir(evidence, { recursive: true });
  for (const theme of ['light', 'dark']) for (const width of [1586, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 992 });
    await page.goto('/#/settings/ui');
    await page.reload();
    await page.evaluate(t => { document.documentElement.className = t; localStorage.setItem('dovun.theme', t); }, theme);
    const settings = page.getByTestId('mobile-navigation-settings');
    const first = settings.getByRole('switch').first();
    await expect(first).toBeVisible();
    const toggle = settings.getByRole('switch', { name: (await first.getAttribute('aria-label'))!, exact: true });
    await expect(toggle).toHaveClass(/surface-switch/);
    await expect(toggle).toHaveAttribute('data-slot', 'switch');
    const list = settings.locator('.mnav-list').first();
    await expect(list).toHaveAttribute('data-surface', 'card');
    const listStyle = await list.evaluate(material);
    expect(listStyle.paint).toContain('linear-gradient');
    expect(listStyle.shadow).not.toBe('none');
    const before = await toggle.isChecked();
    await toggle.focus(); await page.keyboard.press('Space');
    await expect(toggle).toBeChecked({ checked: !before });
    await expect(settings.getByTestId('mobile-navigation-save-status')).not.toContainText('保存中');
    await settings.locator('.mnav-preview').scrollIntoViewIfNeeded();
    if (width >= 1024) {
      await page.getByRole('button', { name: 'AI 助手', exact: true }).last().click();
    } else {
      if (info.project.name === 'chromium') await page.screenshot({ path: `${evidence}/settings-${theme}-${width}.png`, animations: 'disabled' });
      await page.goto('/#/chat');
    }
    const chat = page.getByTestId('ai-assistant');
    const sources = chat.locator('[data-variant="chip"]');
    await expect(sources.first()).toBeVisible();
    const lookup = chat.getByRole('button', { name: '查询了 2 项', exact: true });
    await lookup.click();
    const record = lookup.locator('..');
    await expect(record).toHaveAttribute('data-surface', 'subtle');
    expect((await record.evaluate(material)).shadow).not.toBe('none');
    await expect(chat.locator('.assistant-input-box')).toHaveAttribute('data-surface', 'input');
    expect((await chat.locator('.assistant-input-box').evaluate(material)).shadow).toContain('inset');
    await expect(lookup).toHaveAttribute('aria-expanded', 'true');
    await lookup.focus(); await page.keyboard.press('Enter');
    await expect(lookup).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    await expect(lookup).toHaveAttribute('aria-expanded', 'true');
    await page.mouse.move(5, 5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (info.project.name === 'chromium') await page.screenshot({ path: `${evidence}/settings-assistant-${theme}-${width}.png`, animations: 'disabled' });
  }
});

test('public choices, compact sizes and tabs preserve keyboard and state feedback', async ({ page }) => {
  await page.goto('/controls.html');
  for (const theme of ['浅色', '深色']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    const xs = page.getByRole('button', { name: 'XS', exact: true });
    expect(await xs.evaluate(el => getComputedStyle(el).fontSize)).toBe('12px');
    const checkbox = page.locator('[data-slot="checkbox"]').first();
    const before = await checkbox.isChecked();
    await checkbox.focus(); await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked({ checked: !before });
    await page.getByRole('radio').last().check();
    await expect(page.getByRole('radio').first()).not.toBeChecked();
    expect((await checkbox.evaluate(material)).shadow).not.toBe('none');
  }
  await page.goto('/#/knowledge/memories');
  const selected = page.getByRole('tab', { selected: true });
  await expect(selected).toHaveAttribute('data-variant', 'tab');
  const unselected = page.getByRole('tab', { selected: false }).first();
  expect(await selected.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(await unselected.evaluate(el => getComputedStyle(el).backgroundColor));
});

test('library menus do not open rows, mobile folder menus stay singular and workspace dialogs preserve assistant access', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 1586, height: 992 });
  const response = await request.post(`${api}/api/v1/commands`, { data: { requestId: crypto.randomUUID(), commands: [
    { kind: 'material.create', input: { topicId: null, kind: 'text', title: '公共控件验收资料', content: '隔离测试材料' } },
    { kind: 'libraryFolder.create', input: { parentId: null, name: '验收文件夹' } },
  ] } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto('/#/library');
  const row = page.locator('tr').filter({ hasText: '公共控件验收资料' });
  await row.getByRole('button', { name: '更多 公共控件验收资料', exact: true }).click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '重命名资料', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('library-preview')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // Reopen before the previous menu's exit animation has unmounted its layer.
  await row.getByRole('button', { name: '更多 公共控件验收资料', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '更多 公共控件验收资料', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: '更多 公共控件验收资料', exact: true }).press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '向 AI 提问', exact: true })).toBeFocused();
  await row.getByRole('button', { name: '更多 公共控件验收资料', exact: true }).click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const composer = page.getByRole('textbox', { name: '向 AI 提问', exact: true });
  await composer.fill('保留资料编辑时的工作上下文');
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!, chat = (await page.getByTestId('ai-assistant').boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(chat.x);
  if (info.project.name === 'chromium') await page.screenshot({ path: `${evidence}/library-dialog-assistant.png`, animations: 'disabled' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  // Reload resets presentation only. Keep the isolated server data.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/library'); await page.reload();
  await page.getByRole('button', { name: '文件夹', exact: true }).click();
  const folders = page.getByRole('dialog', { name: '文件夹', exact: true });
  await folders.getByRole('button', { name: '更多 验收文件夹', exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(1);
  const createFolder = page.getByRole('menuitem', { name: '新建子文件夹', exact: true });
  await expect(createFolder).toBeVisible();
  await createFolder.click();
  const childDialog = page.getByRole('dialog', { name: '新建子文件夹', exact: true });
  await expect(childDialog).toBeVisible();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await childDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(folders).toBeVisible();
  await folders.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(folders).toHaveCount(0);
});
