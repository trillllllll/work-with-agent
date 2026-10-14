import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = 'http://127.0.0.1:3015';

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
});
test.afterAll(async () => { await e2eDatabase.$disconnect(); });

test('详情里的代码块立即渲染，压缩后的图片上传后立即显示', async ({ page, request }) => {
  const created = await request.post(`${apiUrl}/api/tasks`, { data: { title: '记一段代码' } });
  expect(created.ok(), await created.text()).toBe(true);
  const task = (await created.json()).data as { id: string };
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '记一段代码', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  const body = detail.getByLabel('详情', { exact: true });
  // 输入围栏后回车即成代码块，无需失焦。
  await body.click();
  await page.keyboard.type('```');
  await page.keyboard.press('Enter');
  await page.keyboard.type('const n = 1;');
  await page.keyboard.press('Escape');
  await expect(detail.locator('pre')).toContainText('const n = 1;');

  await page.setViewportSize({ width: 800, height: 800 });
  await expect(detail.locator('pre')).toContainText('const n = 1;');
  const uploaded = page.waitForResponse((call) => call.request().method() === 'POST' && call.url().includes(`/api/tasks/${task.id}/images`));
  const fetched = page.waitForResponse((call) => call.request().method() === 'GET' && call.url().includes(`/api/tasks/${task.id}/images/`));
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1800;
    canvas.height = 1000;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('没有画布');
    const gradient = context.createLinearGradient(0, 0, 1800, 1000);
    gradient.addColorStop(0, '#234');
    gradient.addColorStop(1, '#ec8');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1800, 1000);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('没有图片');
    const file = new File([blob], 'wide.png', { type: 'image/png' });
    const input = document.querySelector('input[aria-label="选择图片"]') as HTMLInputElement | null;
    if (!input) throw new Error('没有图片选择框');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const requestBody = (await uploaded).request().postDataBuffer();
  expect(requestBody!.byteLength).toBeLessThan(200_000);
  const payload = requestBody!.toString('utf8');
  // WebKit 的画布不能编码 WebP 时，压缩会按契约退回 JPEG。能编码的浏览器仍必须上传 WebP。
  const canWebp = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
    return blob?.type === 'image/webp';
  });
  const mime = canWebp ? 'image/webp' : 'image/jpeg';
  expect(payload).toContain(mime);
  const imageResponse = await fetched;
  expect(imageResponse.status()).toBe(200);
  expect(imageResponse.headers()['content-type']).toContain(mime);
  // 上传成功立即显示，无需失焦。
  const image = detail.locator('.task-image img');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThanOrEqual(1700);
  await image.hover();
  await image.click({ button: 'right' });
  const zoom = page.getByRole('dialog', { name: '图片预览', exact: true });
  await expect(zoom.locator('img')).toBeVisible();
  await expect.poll(() => zoom.locator('img').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThanOrEqual(1700);
  const percent = zoom.locator('span.tabular-nums');
  await expect(percent).toBeVisible();
  const before = (await percent.textContent()) ?? '';
  await zoom.getByRole('button', { name: '放大', exact: true }).click();
  await expect(percent).not.toHaveText(before);
  await zoom.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(zoom).toBeHidden();
  await expect(detail).toBeVisible();

  await page.setViewportSize({ width: 390, height: 800 });
  const box = await detail.boundingBox();
  expect(box?.width ?? 390).toBeLessThan(350);
  await expect(detail.locator('.task-image img')).toBeVisible();
  await expect(detail.locator('pre')).toContainText('const n = 1;');
});

test('纯文本的 file 路径能直接改，标题块始终排版显示', async ({ page, request }) => {
  const fileUrl = 'file:///Users/byc/WorkSpace/AfterSend/.codex-visuals/im-code-logic-branch-graph.html';
  const created = await request.post(`${apiUrl}/api/tasks`, { data: { title: '本地文件', description: `${fileUrl}\n\n# 标题\n` } });
  expect(created.ok(), await created.text()).toBe(true);
  const task = (await created.json()).data as { id: string };
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '本地文件', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  const body = detail.getByLabel('详情', { exact: true });
  await expect(detail.getByRole('heading', { name: '标题', exact: true })).toBeVisible();
  // 正文始终是排版结果：点击 file 路径直接编辑，不切换源码。
  await body.getByText('im-code-logic-branch-graph.html').click();
  await page.keyboard.type('改');
  await expect.poll(async () => (await body.getAttribute('data-value'))?.split('\n')[0] ?? '').toContain('改');
  await expect(detail.getByRole('heading', { name: '标题', exact: true })).toBeVisible();
});

test('删除正文中的图片后，图片记录仍可访问直到任务永久删除', async ({ page, request }) => {
  const created = await request.post(`${apiUrl}/api/tasks`, { data: { title: '图片生命周期' } });
  const task = (await created.json()).data as { id: string };
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${task.id}`).getByRole('button', { name: '图片生命周期', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  const body = detail.getByLabel('详情', { exact: true });
  const uploaded = page.waitForResponse((call) => call.request().method() === 'POST' && call.url().includes(`/api/tasks/${task.id}/images`));
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 40;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('没有画布');
    context.fillStyle = '#468';
    context.fillRect(0, 0, 80, 40);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('没有图片');
    const file = new File([blob], 'small.png', { type: 'image/png' });
    const input = document.querySelector('input[aria-label="选择图片"]') as HTMLInputElement | null;
    if (!input) throw new Error('没有图片选择框');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const uploadedBody = await (await uploaded).json() as { data?: { url?: string } };
  const uploadedUrl = uploadedBody.data?.url;
  expect(uploadedUrl).toBeTruthy();
  await expect(detail.locator('.task-image img')).toBeVisible();
  // 全选删除正文（含图片引用），保存。
  await body.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await expect.poll(async () => {
    const response = await request.get(`${apiUrl}/api/tasks/${task.id}`);
    return (await response.json()).data.description;
  }).toBe('');
  // 保存不含图片的正文后图片仍可访问；撤销可恢复引用。
  const stillThere = await request.get(`${apiUrl}${uploadedUrl}`);
  expect(stillThere.status()).toBe(200);
});
