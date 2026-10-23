import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const panel = (page: Page) => page.getByTestId('ai-assistant');

async function openAssistant(page: Page) {
  if (await panel(page).isVisible()) return;
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

async function ask(page: Page, text: string, reply?: string | RegExp) {
  await openAssistant(page);
  await panel(page).getByRole('textbox', { name: '向 AI 提问' }).fill(text);
  await panel(page).getByRole('button', { name: '发送', exact: true }).click();
  if (reply) await expect(panel(page).getByText(reply).last()).toBeVisible({ timeout: 15_000 });
}

async function skills(request: APIRequestContext, query = '') {
  const response = await request.get(`${api}/api/skills${query}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as Array<{ id: string; name: string; revision: number; origin: string; enabled: boolean }>;
}

async function createInEditor(page: Page, input: { name: string; description: string; instructions: string; enabled?: boolean }) {
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const editor = page.getByTestId('skill-editor');
  await expect(editor).toBeVisible();
  await editor.getByLabel('技能名称').fill(input.name);
  await editor.getByLabel('技能描述').fill(input.description);
  await editor.getByLabel('技能正文').fill(input.instructions);
  if (input.enabled) await editor.getByLabel('启用技能').check();
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toHaveCount(0);
}

async function selectSkill(page: Page, name: string) {
  await page.getByTestId('skill-row').filter({ hasText: name }).getByRole('button').first().click();
  await expect(page.getByTestId('skill-detail').getByRole('heading', { name })).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  const response = await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  expect(response.ok()).toBe(true);
  await page.addInitScript(() => { localStorage.setItem('agent-studio.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('skill loading: catalog, 使用技能 row, and old conversations keep the version they used', async ({ page, request, isMobile }) => {
  test.skip(isMobile, 'covered on desktop; the page test runs on mobile');
  await page.goto('/#/skills');
  await expect(page.getByRole('heading', { name: '技能', exact: true })).toBeVisible();
  await createInEditor(page, { name: '验收周报', description: '每周五整理本周任务时使用', instructions: '第一版正文：先列出完成的任务', enabled: true });
  await expect(page.getByTestId('skill-row').filter({ hasText: '验收周报' })).toContainText('v1');

  await ask(page, '技能加载验收', '已按技能 验收周报 v1 处理。');
  const usage = panel(page).getByTestId('skill-usage').last();
  await expect(usage).toContainText('使用技能');
  await expect(usage).toContainText('验收周报 v1');
  await expect(panel(page).getByText(/^查询了 \d+ 项$/)).toHaveCount(0);
  await usage.getByRole('button').click();
  await expect(usage.getByTestId('skill-usage-body')).toContainText('第一版正文');

  await selectSkill(page, '验收周报');
  await page.getByTestId('skill-detail').getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByTestId('skill-editor');
  await editor.getByLabel('技能正文').fill('第二版正文：再写下周计划');
  await editor.getByLabel('修改说明').fill('改成第二版');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId('skill-detail')).toContainText('v2');
  await page.getByTestId('skill-detail').getByRole('tab', { name: '版本历史' }).click();
  await expect(page.getByTestId('skill-version')).toHaveCount(2);
  await expect(page.getByTestId('skill-version').first()).toContainText('改成第二版');
  await page.getByLabel('对比 v1').check();
  await page.getByLabel('对比 v2').check();
  await expect(page.getByTestId('skill-diff').locator('[data-type="remove"]')).toContainText('第一版正文');
  await expect(page.getByTestId('skill-diff').locator('[data-type="add"]')).toContainText('第二版正文');

  await page.reload();
  await openAssistant(page);
  const old = panel(page).getByTestId('skill-usage').last();
  await expect(old).toContainText('验收周报 v1');
  await old.getByRole('button').click();
  await expect(old.getByTestId('skill-usage-body')).toContainText('第一版正文');
  await expect(old.getByTestId('skill-usage-body')).not.toContainText('第二版正文');

  await ask(page, '技能加载验收 再来一次', '已按技能 验收周报 v2 处理。');
  expect((await skills(request))[0].revision).toBe(2);
});

test('drafting a skill: nothing is written until confirm or editor save', async ({ page, request, isMobile }) => {
  test.skip(isMobile, 'chat cards are covered on desktop');
  await page.goto('/#/inbox');
  await ask(page, '起草技能验收 名称=验收起草');
  const card = panel(page).getByTestId('approval-card').filter({ hasText: '验收起草' });
  await expect(card.getByTestId('skill-proposal')).toContainText('验收起草');
  await expect(card.getByTestId('skill-proposal')).toContainText('新建技能');
  expect(await skills(request)).toHaveLength(0);

  await card.getByRole('button', { name: '在编辑器中修改', exact: true }).click();
  const editor = page.getByTestId('skill-editor');
  await expect(editor.getByLabel('技能名称')).toHaveValue('验收起草');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await skills(request)).toHaveLength(0);
  await expect(card).toHaveAttribute('data-state', 'pending');

  await card.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'executed');
  const saved = await skills(request);
  expect(saved.map((skill) => [skill.name, skill.origin, skill.enabled])).toEqual([['验收起草', 'assistant', true]]);

  await expect(panel(page).getByText('技能草稿已放在确认卡里。').last()).toBeVisible({ timeout: 15_000 });
  await ask(page, '起草技能验收 名称=编辑器起草');
  const second = panel(page).getByTestId('approval-card').filter({ hasText: '编辑器起草' });
  await expect(second.getByTestId('skill-proposal')).toContainText('编辑器起草');
  await second.getByRole('button', { name: '在编辑器中修改', exact: true }).click();
  await editor.getByLabel('技能正文').fill('编辑器里改过的正文');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(second.getByText('已在编辑器中修改并保存为 v1')).toBeVisible();
  expect((await skills(request)).map((skill) => skill.name).sort()).toEqual(['编辑器起草', '验收起草'].sort());
  const edited = (await skills(request)).find((skill) => skill.name === '编辑器起草')!;
  const detail = await (await request.get(`${api}/api/skills/${edited.id}`)).json();
  expect(detail.data.instructions).toBe('编辑器里改过的正文');
  expect(detail.data.versions[0].source).toBe('editor-from-proposal');
});

test('skills page: toggle, delete and restore, import SKILL.md, and the More page entry', async ({ page, request, isMobile }) => {
  await page.goto(isMobile ? '/#/more' : '/#/skills');
  if (isMobile) {
    await page.getByRole('navigation', { name: '工作区导航' }).getByRole('button', { name: '技能' }).click();
    await expect(page).toHaveURL(/#\/skills$/);
  }
  await createInEditor(page, { name: '页面技能', description: '页面验收', instructions: '正文' });
  const row = page.getByTestId('skill-row').filter({ hasText: '页面技能' });
  await expect(row.getByRole('switch', { name: '启用 页面技能' })).not.toBeChecked();
  await row.getByRole('switch', { name: '启用 页面技能' }).click();
  await expect(row.getByRole('switch', { name: '启用 页面技能' })).toBeChecked();
  await expect(row).toContainText('v2');
  expect((await skills(request))[0].enabled).toBe(true);

  await selectSkill(page, '页面技能');
  await page.getByTestId('skill-detail').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('已删除');
  await page.getByRole('dialog').getByRole('button', { name: '确认' }).click();
  await expect(page.getByTestId('skill-row')).toHaveCount(0);
  expect(await skills(request)).toHaveLength(0);
  await page.getByLabel('技能状态').selectOption('deleted');
  await selectSkill(page, '页面技能');
  await page.getByTestId('skill-detail').getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByText('技能已恢复')).toBeVisible();
  if (isMobile && await page.getByRole('button', { name: '返回列表' }).isVisible()) await page.getByRole('button', { name: '返回列表' }).click();
  await page.getByLabel('技能状态').selectOption('all');
  await expect(page.getByTestId('skill-row').filter({ hasText: '页面技能' })).toBeVisible();

  const input = page.getByTestId('skill-import-input');
  await input.setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: 页面技能\n---\n正文') });
  await expect(page.getByText('SKILL.md 缺少：description')).toBeVisible();
  await input.setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: 页面技能\ndescription: 导入的描述\n---\n导入的正文') });
  const conflict = page.getByTestId('skill-import-conflict');
  await expect(conflict).toContainText('页面技能');
  await conflict.getByRole('button', { name: '覆盖为新版本' }).click();
  await expect(conflict).toHaveCount(0);
  await expect(page.getByTestId('skill-detail')).toContainText('导入的正文');
  await page.getByTestId('skill-detail').getByRole('tab', { name: '版本历史' }).click();
  await expect(page.getByTestId('skill-version').first()).toContainText('导入 SKILL.md 覆盖');
  await input.setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: 导入新技能\ndescription: "带引号的描述"\n---\n全新正文') });
  await expect(page.getByTestId('skill-detail').getByRole('heading', { name: '导入新技能' })).toBeVisible();
  expect((await skills(request, '?origin=import')).map((skill) => skill.name)).toEqual(['导入新技能']);
});

test('no enabled skills: the catalog and load_skill stay out of the request', async ({ page, request, isMobile }) => {
  test.skip(isMobile, 'desktop only');
  const created = await request.post(`${api}/api/skills`, { data: { name: '停用的技能', description: '不会出现', instructions: '正文', enabled: false } });
  expect(created.status()).toBe(201);
  await page.goto('/#/inbox');
  await ask(page, '技能加载验收', '没有可用技能。');
  await expect(panel(page).getByTestId('skill-usage')).toHaveCount(0);
  await ask(page, 'AI验收零技能', 'AI验收完成，已读取当前页面与功能说明。');
  await expect(panel(page).getByTestId('skill-usage')).toHaveCount(0);
});

test('存为技能 drafts from the conversation and writes only on save', async ({ page, request, isMobile }) => {
  test.skip(isMobile, 'desktop only');
  await page.goto('/#/inbox');
  await ask(page, 'AI验收存为技能', 'AI验收完成，已读取当前页面与功能说明。');
  const openDraft = async () => {
    await panel(page).getByRole('button', { name: '更多会话操作' }).click();
    await page.getByRole('menuitem', { name: '存为技能' }).click();
    await expect(page.getByTestId('skill-editor').getByLabel('技能名称')).toHaveValue('会话起草技能');
  };
  await openDraft();
  await expect(page.getByTestId('skill-editor').getByLabel('启用技能')).toBeChecked();
  await page.getByTestId('skill-editor').getByRole('button', { name: '取消', exact: true }).click();
  expect(await skills(request)).toHaveLength(0);
  await openDraft();
  await page.getByTestId('skill-editor').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('skill-editor')).toHaveCount(0);
  expect((await skills(request)).map((skill) => [skill.name, skill.origin, skill.enabled])).toEqual([['会话起草技能', 'manual', true]]);
});
