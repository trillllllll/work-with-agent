import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { resetE2eDatabase } from './database.js';

test.beforeEach(resetE2eDatabase);

const names = ['登录', '清单', '记忆', '交接'];

async function project(request: APIRequestContext, name: string) {
  const response = await request.post('http://127.0.0.1:3015/api/topics', { data: { name } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data.id as string;
}

async function remember(request: APIRequestContext, topicId: string, name: string, title: string) {
  const response = await request.post('http://127.0.0.1:3015/api/v1/knowledge/memories', {
    data: { topicId, title, content: `${name}单独成团。`, kind: 'decision', labels: [name] },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function openTerrain(page: Page, topicId: string) {
  await page.goto('/#/knowledge');
  await page.getByLabel('资料所属清单', { exact: true }).selectOption(topicId);
  await page.getByRole('button', { name: '关系', exact: true }).click();
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.getByRole('button', { name: '地形', exact: true })).toBeVisible();
  const clusters = page.getByRole('group', { name: '聚类' });
  for (const name of names) await expect(clusters).toContainText(name);
  await expect(clusters.locator('span')).toHaveCount(4);
  await expect.poll(async () => page.getByLabel('知识关系图').evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d');
    if (!ctx || !canvas.width) return 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let index = 0; index < data.length; index += 64) if (data[index] + data[index + 1] + data[index + 2] > 90) lit += 1;
    return lit;
  })).toBeGreaterThan(30);
}

test('四团社区在三维地形上分开显示', async ({ page, request }) => {
  const topicId = await project(request, '项目记忆');
  for (const name of names) {
    await remember(request, topicId, name, `${name}的决定`);
    await remember(request, topicId, name, `${name}的约束`);
  }
  await page.addInitScript(() => { (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true; });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTerrain(page, topicId);
  await page.setViewportSize({ width: 390, height: 844 });
  await openTerrain(page, topicId);
});
