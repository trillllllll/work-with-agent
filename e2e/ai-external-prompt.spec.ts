import { test, expect, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const composer = '例如：创建任务：整理 API 文档';

async function openChat(page: Page) {
  if (!(await page.getByPlaceholder(composer).isVisible())) await page.getByRole('button', { name: '打开聊天', exact: true }).click();
}

async function ask(page: Page, message: string) {
  await openChat(page);
  await page.getByPlaceholder(composer).fill(message);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

function installClipboard(page: Page, writeText: (text: string) => Promise<void> | void) {
  return page.addInitScript((mode) => {
    const writes: string[] = [];
    (window as unknown as { __clipboardWrites?: string[] }).__clipboardWrites = writes;
    const clipboard = {
      writeText: async (text: string) => {
        writes.push(text);
        if (mode === 'throw') throw new Error('clipboard denied');
      },
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => clipboard });
  }, writeText ? 'keep' : 'throw');
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  const saved = await request.patch(`${api}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(() => {
    localStorage.setItem('dovun.theme', 'light');
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
  });
});
test.afterAll(() => e2eDatabase.$disconnect());

async function expectPromptCard(page: Page) {
  const card = page.getByTestId('external-prompt-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('heading', { name: '需要具备联网能力的 AI' })).toBeVisible();
  await expect(card).toContainText('我目前不能联网查资料。');
  await expect(card).not.toContainText('已查询');
  await expect(card).not.toContainText('已发送');
  await expect(card).not.toContainText('任务已完成');
  await expect(page.getByTestId('approval-card')).toHaveCount(0);
  return card;
}

test('复制的是纯提示词，刷新后仍可复制', async ({ page, isMobile }) => {
  test.skip(Boolean(isMobile), '外部提示词在桌面视口验收');
  await installClipboard(page, async () => undefined);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/inbox');
  await ask(page, '整理成外部提示词');
  const card = await expectPromptCard(page);
  await card.getByRole('button', { name: '查看提示词', exact: true }).click();
  const body = card.getByTestId('external-prompt-body');
  await expect(body).toContainText('目标');
  await expect(body).toContainText('请按以下格式返回');
  await expect(body).not.toContainText('我目前不能联网查资料。');
  const style = await card.evaluate((el) => {
    const value = getComputedStyle(el);
    return { radius: value.borderRadius, padding: value.padding, border: value.borderTopWidth, background: value.backgroundColor };
  });
  expect(style).toEqual({ radius: '12px', padding: '16px', border: '1px', background: 'rgb(255, 255, 255)' });
  const bodyBox = await body.evaluate((el) => ({ maxHeight: getComputedStyle(el).maxHeight, fontSize: getComputedStyle(el).fontSize, lineHeight: getComputedStyle(el).lineHeight }));
  expect(bodyBox).toEqual({ maxHeight: '320px', fontSize: '13px', lineHeight: '20px' });
  await card.screenshot({ path: '/tmp/wwa-external-light.png' });

  await card.getByRole('button', { name: '复制提示词', exact: true }).click();
  await expect(card.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  const copied = await page.evaluate(() => (window as unknown as { __clipboardWrites?: string[] }).__clipboardWrites ?? []);
  expect(copied).toHaveLength(1);
  expect(copied[0]).toContain('目标');
  expect(copied[0]).toContain('查询 k8s 文档第9节怎么使用');
  expect(copied[0]).toContain('请按以下格式返回');
  expect(copied[0]).not.toContain('我目前不能联网查资料。');
  expect(copied[0]).not.toContain('external_prompt');
  await expect(card.getByRole('button', { name: '复制提示词', exact: true })).toBeVisible();

  await page.reload();
  await openChat(page);
  const restored = await expectPromptCard(page);
  await restored.getByRole('button', { name: '复制提示词', exact: true }).click();
  await expect(restored.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('剪贴板失败时展开可手动复制的文本，不宣称成功', async ({ page, isMobile }) => {
  test.skip(Boolean(isMobile), '手动复制在桌面视口验收');
  await page.addInitScript(() => {
    const clipboard = { writeText: async () => { throw new Error('clipboard denied'); } };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => clipboard });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/inbox');
  await ask(page, '整理成外部提示词');
  const card = await expectPromptCard(page);
  await card.getByRole('button', { name: '复制提示词', exact: true }).click();
  await expect(card.getByRole('button', { name: '已复制', exact: true })).toHaveCount(0);
  const manual = card.getByRole('textbox', { name: '手动复制' });
  await expect(manual).toBeVisible();
  await expect(manual).toHaveValue(/目标/);
  await expect(card.locator('label', { hasText: '手动复制' })).toBeVisible();
});

test('深色和窄屏外部提示词卡保持中性样式', async ({ page, isMobile }) => {
  test.skip(Boolean(isMobile), '外部提示词视口在桌面项目里切换');
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'dark'); });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/inbox');
  await ask(page, '整理成外部提示词');
  const card = await expectPromptCard(page);
  const colors = await card.evaluate((el) => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
  expect(colors).toEqual({ background: 'rgb(23, 23, 23)', color: 'rgb(245, 245, 245)' });
  await card.screenshot({ path: '/tmp/wwa-external-dark.png' });

  await page.setViewportSize({ width: 390, height: 844 });
  await openChat(page);
  await expect(card).toBeVisible();
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await card.screenshot({ path: '/tmp/wwa-external-narrow.png' });
});
