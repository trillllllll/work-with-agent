import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { e2eDatabase as db, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL!;
const question = '还能搞些啥呢？我在想。要是让 AI 把我的所有工作都接管了，我是想要最好是这样子，然后我只用去理解跟决策吧。';
const answer = '看过你 11-02 贴着周报计划列的那份清单（9 项工程 + 2 项文档维护），再对照你实际在跑的任务，我的判断是：[1](#source-1)\n\n**能交出去的，是“有边界、可验收、可回滚”的活；最该先交出去的不是写代码，是“复现 → 定位 → 验证”这条流水线。**\n\n### 把你的活分成四层\n\n| 工作类型 | 例子 | 现在的接管度 | 你还需要做什么 |\n| --- | --- | --- | --- |\n| 流程固定、产出物明确 | [Bug 复现](https://example.com/ticket)、定位报告、TR/PRD 文档、周报、每日排期 | 高，可以做成固定的 `skill` | 验收、决定要不要发 |\n| 有明确验收标准，但有不确定性 | 提交功能开发、发票页面集成、企喵转发 | 中，能力够，但需要有人盯着 | 定做什么、验收、上线与否 |\n| 需要业务判断 | 需求取舍、方案评审、跨团队沟通 | 可以整理依据和备选方案 | 理解取舍，做最后决定 |\n| 高影响、难撤回的操作 | 生产发布、数据处理、账号权限调整 | 可以准备和核对执行步骤 | 明确授权，确认结果 |';

test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  const id = randomUUID(), refId = randomUUID(), stamp = '2026-11-02T01:00:00.000Z';
  await db.conversation.createMany({ data: [{ id, createdAt: stamp, updatedAt: stamp }, { id: refId, createdAt: stamp, updatedAt: stamp }] });
  const source = await db.message.create({ data: { conversationId: refId, role: 'assistant', content: '9 项工程 + 2 项文档维护。', createdAt: stamp } });
  await db.message.createMany({ data: [
    { conversationId: id, role: 'user', content: question, createdAt: stamp },
    { conversationId: id, role: 'assistant', content: answer, partsJson: JSON.stringify([{ type: 'assistant_sources', sources: [{ kind: 'conversation', id: source.id, title: '11-02 周报与本周计划' }] }]), createdAt: '2026-11-02T01:00:01.000Z' },
  ] });
  await page.addInitScript(id => { localStorage.setItem('dovun.conversationId', id); (window as any).__REACT_GRAB_DISABLED__ = true; }, id);
});
test.afterAll(() => db.$disconnect());

test('same-content conversation stays readable across container widths and themes', async ({ page }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#/chat');
  const panel = page.getByTestId('ai-assistant');
  await expect(panel.getByLabel('向 AI 提问')).toHaveAttribute('placeholder', '继续聊聊…');
  await expect(panel.locator('.assistant-message[data-role=user]')).toContainText(question);
  await expect(panel.locator('.assistant-header')).toHaveCSS('position', 'relative');
  const evidence = '/tmp/dovun-chat-reading-acceptance'; await mkdir(evidence, { recursive: true });
  for (const width of [320, 390, 520, 1280]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(theme => { document.documentElement.classList.toggle('dark', theme === 'dark'); }, theme);
    const table = panel.locator('.markdown-responsive-table');
    const contentWidth = await panel.locator('.markdown-body').last().evaluate(element => element.getBoundingClientRect().width);
    if (contentWidth < 640) {
      await expect(table.locator('.markdown-table-rows')).toBeVisible();
      await expect(table.locator('.markdown-table-scroll')).toBeHidden();
      await expect(table.locator('.markdown-table-rows a')).toHaveAttribute('href', 'https://example.com/ticket');
      await expect(table.locator('.markdown-table-rows code')).toHaveText('skill');
    } else {
      await expect(table.locator('.markdown-table-scroll')).toBeVisible();
      await expect(table.locator('.markdown-table-rows')).toBeHidden();
    }
    expect(await panel.locator('.assistant-user-bubble').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width < 1024) await expect(page.getByTestId('mobile-bottom-navigation')).toHaveCount(0);
    await panel.locator('[data-chat-scroll]').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: `${evidence}/${info.project.name}-${theme}-${width}.png`, animations: 'disabled' });
  }
  await panel.getByRole('button', { name: '更多会话操作', exact: true }).click();
  await expect(page.getByText('mock-model', { exact: true })).toBeVisible();
  await page.getByTestId('context-usage-trigger').click();
  await expect(page.getByTestId('context-usage-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('button', { name: '更多会话操作', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: /查看来源 1/ }).click();
  await expect(page.getByRole('dialog')).toContainText('9 项工程 + 2 项文档维护。');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('mobile navigation returns to chat without losing its draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/chat');
  const panel = page.getByTestId('ai-assistant');
  await panel.getByLabel('向 AI 提问').fill('暂时不发送的草稿');
  await panel.getByRole('button', { name: '打开工作区导航', exact: true }).click();
  const navigation = page.getByRole('dialog');
  await expect(navigation.locator('.app-sidebar')).toBeVisible();
  await navigation.getByRole('button', { name: '收集箱', exact: true }).click();
  await expect(page).toHaveURL(/#\/inbox$/);
  await expect(page.getByTestId('mobile-bottom-navigation')).toBeVisible();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(panel.getByLabel('向 AI 提问')).toHaveValue('暂时不发送的草稿');
});

test('user tables and rich text blocks keep their content and copy the original Markdown', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/chat');
  const id = await page.evaluate(() => localStorage.getItem('dovun.conversationId'));
  const markdown = '| 类型 | 证据 | 处理 |\n| --- | --- | --- |\n| 调查 | [工单](https://example.com/ticket) | `验证` |';
  await db.message.createMany({ data: [
    { conversationId: id!, role: 'user', content: markdown, createdAt: '2026-11-02T01:00:02.000Z' },
    { conversationId: id!, role: 'assistant', content: markdown, blocksJson: JSON.stringify({ schemaVersion: 1, blocks: [{ id: 'reading-rich', index: 0, type: 'text', status: 'ready', markdown }] }), createdAt: '2026-11-02T01:00:03.000Z' },
  ] });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copiedReading = text; } } });
  });
  await page.reload();
  const panel = page.getByTestId('ai-assistant');
  const user = panel.locator('.assistant-user-message').last();
  await expect(user.locator('.markdown-table-rows')).toBeVisible();
  expect((await user.boundingBox())!.width).toBeGreaterThan(150);
  const block = panel.locator('[data-block-id="reading-rich"]');
  await expect(block.locator('.markdown-table-rows')).toBeVisible();
  await expect(block.locator('.markdown-table-rows a')).toHaveAttribute('href', 'https://example.com/ticket');
  await panel.getByRole('button', { name: '复制回复', exact: true }).last().click();
  expect(await page.evaluate(() => (window as any).__copiedReading)).toBe(markdown);
});

test('context settings navigation closes usage details and long model names fit the menu', async ({ page, request }) => {
  await request.patch(`${api}/api/settings`, { data: { model: `model-${'long-name-'.repeat(25)}` } });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/#/chat');
  await page.getByTestId('assistant-more-actions').click();
  const menu = page.getByRole('menu');
  const bounds = (await menu.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.getByTestId('context-usage-trigger').click();
  await page.getByTestId('context-usage-popover').getByRole('link').click();
  await expect(page).toHaveURL(/#\/settings\/model$/);
  await expect(page.getByTestId('context-usage-popover')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
});
