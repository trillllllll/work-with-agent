import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const api = 'http://127.0.0.1:3015';
test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('同一助手放大缩小保留输入、手动附件及页面，直接进入没有尺寸控件', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#/plan');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const assistant = page.getByTestId('ai-assistant');
  await assistant.getByLabel('向 AI 提问').fill('保留这段没有发送的草稿');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('wwa-open-assistant', { detail: { attachment: { id: 'reference-draft', title: '手动附加', kind: 'draft', text: '尚未保存', unsaved: true } } })));
  await assistant.getByRole('button', { name: '放大到独立页' }).click();
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(assistant).toHaveAttribute('data-presentation', 'expanded');
  await expect(assistant.getByLabel('向 AI 提问')).toHaveValue('保留这段没有发送的草稿');
  await expect(assistant.getByText('手动附加 · 未保存草稿', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开 AI 助手', exact: true })).toHaveCount(0);
  await assistant.getByRole('button', { name: '缩小回原页面' }).click();
  await expect(page).toHaveURL(/#\/plan$/);
  await expect(assistant).toHaveAttribute('data-presentation', 'side');
  await expect(assistant.getByLabel('向 AI 提问')).toHaveValue('保留这段没有发送的草稿');
  await page.goto('/#/chat');
  await expect(assistant).toHaveAttribute('data-presentation', 'direct');
  await expect(assistant.getByRole('button', { name: /放大|缩小|收起助手|返回/ })).toHaveCount(0);
  await page.keyboard.press('Control+Shift+L');
  await expect(assistant.getByLabel('向 AI 提问')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: `/tmp/wwa-assistant-direct-${test.info().project.name}.png`, fullPage: true });
});

test('工作区弹层在放大后恢复原来的设置表单', async ({ page }) => {
  await page.goto('/#/settings');
  const settings = page.getByRole('dialog');
  const field = settings.locator('input:not([type=hidden])').first();
  await expect(field).toBeVisible();
  await field.fill('https://example.invalid/preserve-draft');
  await settings.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await page.getByRole('button', { name: '放大到独立页' }).click();
  await expect(page.getByTestId('assistant-page')).toBeVisible();
  await page.getByRole('button', { name: '缩小回原页面' }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(field).toHaveValue('https://example.invalid/preserve-draft');
});

test('任务编辑器放大缩小时保留同一个节点和草稿', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  const task = (await (await request.post(`${api}/api/tasks`, { data: { title: '编辑中的任务' } })).json()).data;
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '编辑中的任务', exact: true }).click();
  const title = page.getByLabel('任务标题', { exact: true });
  await title.fill('保留编辑草稿');
  await title.evaluate((element) => (element as any).__retainedMarker = 'original');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.getByRole('button', { name: '放大到独立页' }).click();
  await expect(title).toBeHidden();
  await page.getByRole('button', { name: '缩小回原页面' }).click();
  await expect(title).toHaveValue('保留编辑草稿');
  expect(await title.evaluate((element) => (element as any).__retainedMarker)).toBe('original');
});


test('知识页放大缩小保留未保存材料及原子路由参数', async ({ page }) => {
  await page.goto('/#/knowledge/materials?topicId=inbox');
  await page.getByRole('button', { name: '保存材料', exact: true }).click();
  await page.getByLabel('材料标题', { exact: true }).fill('未提交材料标题');
  await page.getByLabel('材料正文', { exact: true }).fill('未提交正文需要完整保留');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.getByRole('button', { name: '放大到独立页' }).click();
  await page.getByRole('button', { name: '缩小回原页面' }).click();
  await expect(page).toHaveURL(/#\/knowledge\/materials\?topicId=inbox$/);
  await page.getByRole('button', { name: /^(关闭聊天|返回当前页面)$/ }).click();
  await expect(page.getByLabel('材料标题', { exact: true })).toHaveValue('未提交材料标题');
  await expect(page.getByLabel('材料正文', { exact: true })).toHaveValue('未提交正文需要完整保留');
});

test('规划日期、模式和时间网格滚动在放大缩小后保持', async ({ page }) => {
  await page.goto('/#/plan');
  await page.locator('[data-plan-mode=day]').click();
  await page.getByRole('button', { name: '下一段', exact: true }).click();
  await page.getByRole('button', { name: '下一段', exact: true }).click();
  const scroller = page.getByTestId('timeline-scroll');
  await scroller.evaluate((node) => { node.scrollTop = 350; (node as any).__preserved = true; });
  const day = await page.getByTestId('time-band-day').first().getAttribute('data-date');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.getByRole('button', { name: '放大到独立页' }).click();
  await page.getByRole('button', { name: '缩小回原页面' }).click();
  await page.getByRole('button', { name: /^(关闭聊天|返回当前页面)$/ }).click();
  await expect(page.locator('[data-plan-mode=day]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.getByTestId('time-band-day').first().getAttribute('data-date')).toBe(day);
  expect(await scroller.evaluate((node) => ({ top: node.scrollTop, retained: (node as any).__preserved }))).toEqual({ top: 350, retained: true });
});

test('Brave 设置保存后只回显遮罩，可刷新并清除', async ({ page }) => {
  await page.goto('/#/settings');
  const section = page.getByRole('region', { name: '图片搜索设置' });
  const field = section.getByLabel('Brave 图片搜索 API Key');
  await field.fill('e2e-brave-credential-9876');
  await section.getByRole('button', { name: '保存图片搜索密钥' }).click();
  await expect(field).toHaveValue(''); await expect(section).toContainText('当前密钥：••••9876');
  await page.reload();
  await expect(section).toContainText('当前密钥：••••9876'); await expect(field).toHaveValue('');
  expect(await section.textContent()).not.toContain('e2e-brave-credential');
  await section.getByRole('button', { name: '清除图片搜索密钥' }).click();
  await expect(section).toContainText('未配置时，助手会明确说明图片搜索不可用');
  await expect(section.getByRole('button', { name: '清除图片搜索密钥' })).toHaveCount(0);
});
