import { type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';

// 行为基准：单行 ≈ 28px（20px 行高 + 8px 上下内边距），展开 3 行 ≈ 68px，8 行封顶 ≈ 168px。
const COLLAPSED_MAX = 34;
const EXPANDED_MIN = 58;
const EXPANDED_MAX = 174;

test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  expect((await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } })).ok()).toBe(true);
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'light'); (window as any).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(() => e2eDatabase.$disconnect());

const heightOf = (loc: Locator) => loc.evaluate((el) => el.getBoundingClientRect().height);

test('空输入框失焦收起时，按下后松开仍能打开会移动的参考来源', async ({ page }) => {
  const id = randomUUID();
  const stamp = '2026-11-07T00:00:00.000Z';
  await e2eDatabase.conversation.create({ data: { id, createdAt: stamp, updatedAt: stamp } });
  const original = await e2eDatabase.message.create({ data: { conversationId: id, role: 'assistant', content: '来源原文。', createdAt: stamp } });
  await e2eDatabase.message.createMany({ data: [
    ...Array.from({ length: 16 }, (_, index) => ({ conversationId: id, role: index % 2 ? 'assistant' : 'user', content: `历史 ${index}：${'把会话撑满，使底部来源的位置随输入框高度变化。'.repeat(4)}`, createdAt: `2026-11-07T00:00:${String(index + 1).padStart(2, '0')}.000Z` })),
    { conversationId: id, role: 'assistant', content: '展开下面的参考来源。', partsJson: JSON.stringify([{ type: 'assistant_sources', sources: [{ kind: 'conversation', id: original.id, title: '可打开的来源' }] }]), createdAt: '2026-11-07T00:01:00.000Z' },
  ] });
  await page.addInitScript(value => localStorage.setItem('dovun.conversationId', value), id);
  // Remove height interpolation so the regression is independent of animation speed.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/chat');
  const panel = page.getByTestId('ai-assistant');
  const input = panel.getByLabel('向 AI 提问');
  const sources = panel.getByTestId('assistant-sources').last();
  const trigger = sources.locator(':scope > summary');
  await expect(trigger).toBeVisible();
  const scroller = panel.locator('[data-chat-scroll]');
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
  const collapsed = await trigger.boundingBox();
  expect(collapsed).not.toBeNull();
  await input.focus();
  await expect.poll(() => heightOf(input)).toBeGreaterThanOrEqual(EXPANDED_MIN);
  await expect.poll(async () => Math.abs((await trigger.boundingBox())!.y - collapsed!.y)).toBeGreaterThan(20);
  const target = (await trigger.boundingBox())!;
  await expect(sources).not.toHaveAttribute('open');
  // A single real press/release at fixed coordinates; Locator.click could hide the race by retrying.
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.mouse.down();
  try {
    await expect(input).not.toBeFocused();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  } finally { await page.mouse.up(); }
  await expect(sources).toHaveAttribute('open', '');
  await expect(sources.getByRole('button', { name: /可打开的来源/ })).toBeVisible();
  await expect.poll(() => heightOf(input)).toBeLessThanOrEqual(COLLAPSED_MAX);
});

test('输入框默认单行，聚焦展开、随内容长高、失焦与清空收回', async ({ page }) => {
  await page.goto('/#/chat');
  const panel = page.getByTestId('ai-assistant');
  const input = panel.getByLabel('向 AI 提问');
  await expect(input).toBeVisible();
  const collapsed = await heightOf(input);
  expect(collapsed).toBeLessThanOrEqual(COLLAPSED_MAX);

  await input.focus();
  await expect.poll(() => heightOf(input)).toBeGreaterThanOrEqual(EXPANDED_MIN);
  const expanded = await heightOf(input);

  // 展开后底边不得超出可视区（键盘遮挡防护，与 global-assistant 同一底线）。
  const bottom = await input.evaluate((el) => el.getBoundingClientRect().bottom);
  expect(bottom).toBeLessThanOrEqual((await page.evaluate(() => visualViewport.height)) + 1);

  // 多行内容继续长高，封顶后改为框内滚动。
  await input.fill(Array.from({ length: 12 }, (_, index) => `第${index}行内容`).join('\n'));
  await expect.poll(() => heightOf(input)).toBeLessThanOrEqual(EXPANDED_MAX);
  expect(await heightOf(input)).toBeGreaterThan(expanded);
  expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  // 点击覆盖式磨砂头部下方的空白区；有内容时失焦保持展开。
  await page.locator('[data-chat-scroll]').click({ position: { x: 10, y: 100 } });
  expect(await heightOf(input)).toBeGreaterThanOrEqual(EXPANDED_MIN);

  // 清空并失焦收回单行。
  await input.fill('');
  await page.locator('[data-chat-scroll]').click({ position: { x: 10, y: 100 } });
  await expect.poll(() => heightOf(input)).toBeLessThanOrEqual(COLLAPSED_MAX);
});

test('Enter 发送后即使保持焦点也收回单行，再输入重新展开', async ({ page }) => {
  await page.goto('/#/chat');
  const panel = page.getByTestId('ai-assistant');
  const input = panel.getByLabel('向 AI 提问');
  await input.fill('对话思考验收：开始');
  await page.keyboard.press('Enter');
  await expect.poll(() => heightOf(input), { timeout: 5_000 }).toBeLessThanOrEqual(COLLAPSED_MAX);
  await expect(panel.getByText('先完成计数器练习。', { exact: true })).toBeVisible({ timeout: 15_000 });
  await input.pressSequentially('再');
  await expect.poll(() => heightOf(input)).toBeGreaterThanOrEqual(EXPANDED_MIN);
});
