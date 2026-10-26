import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.beforeEach(() => resetE2eDatabase());
test.afterAll(() => e2eDatabase.$disconnect());

const stats = { topics: 13, items: 0, itemsDone: 0, itemsLearning: 0, averageMastery: null };
const maps = [
  { id: 'go', title: 'Go 基础', goal: '掌握 Go 基础语法', status: 'active', revision: 1, stats },
  { id: 'single', title: '单主题地图', goal: '单主题练习', status: 'active', revision: 1, stats: { ...stats, topics: 1, items: 1 } },
  { id: 'empty', title: '空地图', goal: '待规划', status: 'active', revision: 1, stats: { ...stats, topics: 0 } },
];
const node = (id: string, mapId: string, title: string) => ({ id, mapId, title, parentId: null, kind: 'topic', detail: `${title}的详情`, status: 'todo', mastery: 0, sortOrder: 0, revision: 1, children: [] as unknown[] });

test('learning map renders a forest and preserves selection, collapse, zoom and map switching', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => { localStorage.setItem('dovun.theme', 'dark'); (window as any).__REACT_GRAB_DISABLED__ = true; });
  await page.route('**/api/v1/learning/maps', (route) => route.fulfill({ json: { data: { maps } } }));
  await page.route('**/api/v1/learning/maps/*', (route) => {
    const id = route.request().url().split('/').pop();
    const map = maps.find((entry) => entry.id === id)!;
    const tree = id === 'go' ? Array.from({ length: 13 }, (_, i) => node(`topic-${i}`, 'go', i === 0 ? '环境与工具' : `主题 ${i + 1}`)) : id === 'single' ? [{ ...node('single-topic', 'single', '唯一主题'), children: [{ ...node('exercise', 'single', '练习条目'), parentId: 'single-topic', kind: 'item' }] }] : [];
    return route.fulfill({ json: { data: { map, tree, stats: map.stats, recentActivity: [] } } });
  });
  await page.goto('/#/learning');
  const graph = page.getByRole('img', { name: '学习地图结构图，颜色代表掌握度' });
  await expect(graph.locator('canvas')).toBeVisible();
  await expect(page.getByText('主题: 13', { exact: true })).toBeVisible();
  // With 13 sibling leaves ECharts spaces the centers evenly inside its 12% vertical margins.
  const box = (await graph.boundingBox())!;
  const leafY = (index: number) => box.height * (0.12 + 0.76 * (index + 0.5) / 13);
  await graph.click({ position: { x: box.width * 0.7, y: leafY(0) } });
  await expect(page.getByRole('heading', { name: '环境与工具', exact: true })).toBeVisible();
  await graph.click({ position: { x: box.width * 0.7, y: leafY(12) } });
  await expect(page.getByRole('heading', { name: '主题 13', exact: true })).toBeVisible();
  await graph.hover({ position: { x: box.width * 0.18, y: box.height / 2 } });
  await graph.click({ position: { x: box.width * 0.18, y: box.height / 2 } });
  await expect(page.getByRole('heading', { name: '主题 13', exact: true })).toBeVisible();
  // Restore the display root after confirming it did not change business selection.
  await graph.click({ position: { x: box.width * 0.18, y: box.height / 2 } });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath('13-topics.png'), fullPage: true });
  await page.getByRole('combobox', { name: '学习地图', exact: true }).click();
  await page.getByRole('option', { name: '单主题地图', exact: true }).click();
  await expect(graph).not.toHaveAttribute('data-selected');
  await expect(page.getByText('单主题练习', { exact: true })).toBeVisible();
  await expect(graph.locator('canvas')).toBeVisible();
  const singleBox = (await graph.boundingBox())!;
  // Root, topic and its item are initially expanded: click the topic at the middle column.
  await graph.click({ position: { x: singleBox.width * 0.44, y: singleBox.height / 2 } });
  await expect(page.getByRole('heading', { name: '唯一主题', exact: true })).toBeVisible();
  // Click again to expand, then select its checklist child.
  await graph.click({ position: { x: singleBox.width * 0.7, y: singleBox.height / 2 } });
  await graph.click({ position: { x: singleBox.width * 0.7, y: singleBox.height / 2 } });
  await expect(page.getByRole('heading', { name: '练习条目', exact: true })).toBeVisible();
  await graph.hover({ position: { x: singleBox.width * 0.5, y: singleBox.height * 0.8 } });
  const canvas = graph.locator('canvas');
  const beforeZoom = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await page.mouse.wheel(0, -150);
  await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(beforeZoom);
  await page.getByRole('combobox', { name: '学习地图', exact: true }).click();
  await page.getByRole('option', { name: '空地图', exact: true }).click();
  await expect(page.getByText('这张地图还没有主题，和学习助手聊聊要学什么。', { exact: true })).toBeVisible();
  await expect(graph).toHaveCount(0);
  expect(errors).toEqual([]);
});
