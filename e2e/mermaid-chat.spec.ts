import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const panel = (page: Page) => page.getByTestId('ai-assistant');

async function open(page: Page) {
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

async function send(page: Page, text: string) {
  await panel(page).getByRole('textbox', { name: '向 AI 提问' }).fill(text);
  await panel(page).getByRole('button', { name: '发送', exact: true }).click();
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  const response = await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  expect(response.ok()).toBe(true);
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => e2eDatabase.$disconnect());

test('completed chat messages render mermaid diagrams', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/#/inbox');
  await open(page);
  await send(page, '画出这些图');
  const chat = panel(page);
  const labels = ['开始', '排期任务', '问好', 'Task', 'Ready', 'USER', '完成', '主题', '上线', '提交'];
  for (const label of labels) {
    await expect(chat.locator('[data-mermaid-block] svg').filter({ hasText: label }).first()).toBeVisible({ timeout: 20_000 });
  }
  await expect(chat.locator('pre', { hasText: 'const keep = 1' })).toBeVisible();
  await expect(chat.locator('[data-mermaid-block]', { hasText: 'const keep = 1' })).toHaveCount(0);

  const flow = chat.locator('[data-mermaid-block]').first();
  await flow.getByRole('button', { name: '源码', exact: true }).click();
  await expect(flow.locator('svg')).toHaveCount(0);
  await expect(flow.getByText('flowchart TD')).toBeVisible();
  await flow.getByRole('button', { name: '图', exact: true }).click();
  await expect(flow.locator('svg').filter({ hasText: '开始' })).toBeVisible();

  const gantt = chat.locator('[data-mermaid-block]').filter({ has: page.locator('svg', { hasText: '排期任务' }) });
  const enlarge = gantt.getByRole('button', { name: '放大', exact: true });
  await enlarge.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await enlarge.click();
  const dialog = page.getByRole('dialog', { name: '图' });
  await expect(dialog.getByText('排期任务')).toBeVisible();
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box).toBeTruthy();
  expect(viewport).toBeTruthy();
  expect(box!.width).toBeLessThan(viewport!.width - 8);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await send(page, '画一张坏图');
  await expect(chat.getByText('这张图画不出来')).toBeVisible();
  await expect(chat.getByText('not-a-diagram')).toBeVisible();
});
