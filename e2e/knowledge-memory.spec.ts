import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { resetE2eDatabase } from './database.js';

test.beforeEach(resetE2eDatabase);

async function project(request: APIRequestContext, name: string) {
  const response = await request.post('http://127.0.0.1:3015/api/topics', { data: { name } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data.id as string;
}

async function openKnowledge(page: Page, topicId: string) {
  await page.goto('/#/knowledge');
  await page.getByLabel('资料所属清单', { exact: true }).selectOption(topicId);
}

test('记忆可以按重要度和标签浏览，并在知识树与关系图里出现', async ({ page, request }) => {
  const topicId = await project(request, '记忆清单');
  await openKnowledge(page, topicId);
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.getByRole('button', { name: '记录记忆', exact: true }).click();
  await page.getByLabel('记忆标题', { exact: true }).fill('采用 SQLite');
  await page.getByLabel('记忆正文', { exact: true }).fill('本地清单继续使用 SQLite。');
  await page.getByLabel('记忆类型', { exact: true }).selectOption('decision');
  await page.getByRole('radio', { name: '5 星', exact: true }).click();
  await page.getByLabel('记忆标签', { exact: true }).fill('存储 本地');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  const card = page.getByRole('button', { name: /采用 SQLite/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText('决策');
  await expect(card).toContainText('存储');
  await expect(card).toContainText('本地');
  await expect(card.getByLabel('重要度 5，满分 5')).toBeVisible();
  await page.getByRole('button', { name: '知识树', exact: true }).click();
  await page.getByRole('button', { name: /决策/ }).click();
  await expect(page.getByRole('button', { name: /采用 SQLite/ })).toBeVisible();
  await page.getByRole('button', { name: /工作记忆/ }).click();
  await expect(page.getByLabel('简报固定说明')).toBeVisible();
  await page.getByRole('button', { name: '关系', exact: true }).click();
  await expect(page.getByLabel('知识关系图')).toBeVisible();
  const clusters = page.getByRole('group', { name: '聚类' });
  await expect(clusters).toContainText(/存储|本地/);
  await expect(clusters.locator('span')).toHaveCount(1);
  await page.getByRole('button', { name: '采用 SQLite', exact: true }).click();
  await expect(page.getByRole('heading', { name: '采用 SQLite' })).toBeVisible();
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.getByRole('button', { name: '地形', exact: true })).toBeVisible();
  await expect(page.getByText('高处代表更重要、连接更强的知识。')).toBeVisible();
  await expect.poll(async () => page.getByLabel('知识关系图').evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d');
    if (!ctx || !canvas.width) return 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let index = 0; index < data.length; index += 64) if (data[index] + data[index + 1] + data[index + 2] > 90) lit += 1;
    return lit;
  })).toBeGreaterThan(30);
  await page.getByRole('button', { name: '增长', exact: true }).click();
  await expect(page.getByText('高处代表最近更新的知识。')).toBeVisible();
  await page.getByRole('button', { name: '结构', exact: true }).click();
  await expect(page.getByText('孤立的点贴在地面。')).toBeVisible();
  await page.getByRole('button', { name: '形态', exact: true }).click();
  await expect(page.getByText('各占一条脊。')).toBeVisible();
  await page.getByRole('button', { name: '知识星图', exact: true }).click();
  await expect(page.getByText('铺在透视平面上。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '采用 SQLite' })).toBeVisible();
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.getByRole('button', { name: /采用 SQLite/ }).click();
  await page.getByRole('button', { name: '设为历史', exact: true }).click();
  await expect(page.getByText('暂无记忆，可以先手动保存。')).toBeVisible();
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.getByRole('button', { name: /采用 SQLite/ })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: /采用 SQLite/ })).toBeVisible();
  await page.getByRole('button', { name: '关系', exact: true }).click();
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.getByRole('button', { name: '地形', exact: true })).toBeVisible();
  await expect(page.getByText('高度代表什么？')).toBeVisible();
});
