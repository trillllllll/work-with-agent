import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
const composer = '例如：创建任务：整理 API 文档';

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`${api}${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

async function linkedTasks(request: APIRequestContext, materialId: string) {
  const response = await request.get(`${api}/api/v1/library/materials/${materialId}/tasks`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as { items: Array<{ id: string }> };
}

async function openChat(page: Page) {
  if (!(await page.getByPlaceholder(composer).isVisible())) await page.getByRole('button', { name: '打开聊天', exact: true }).click();
}

async function ask(page: Page, message: string) {
  await openChat(page);
  await page.getByPlaceholder(composer).fill(message);
  await page.getByRole('button', { name: '发送', exact: true }).click();
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

test('读取项目资料不出现审核卡', async ({ page, isMobile }) => {
  test.skip(Boolean(isMobile), '资料工具在桌面视口验收，窄屏只检查审核按钮');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/inbox');
  await ask(page, '读取项目资料');
  await expect(page.getByText('我先查看项目资料。', { exact: true })).toBeVisible();
  await expect(page.getByTestId('assistant-process').getByText('查询 1 项', { exact: true })).toBeVisible();
  await expect(page.getByText('当前任务已读取完成。', { exact: true })).toBeVisible();
  await expect(page.getByText('需要审核')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '批准执行' })).toHaveCount(0);
  await expect(page.getByTestId('approval-card')).toHaveCount(0);
});

test('拒绝项目资料关联后数据不变，窄屏仍能点审核按钮', async ({ page, isMobile, request }) => {
  test.skip(Boolean(isMobile), '资料工具在桌面视口验收，窄屏只检查审核按钮');
  const material = await post(request, '/api/v1/commands', { requestId: crypto.randomUUID(), commands: [{ kind: 'material.create', input: { topicId: null, kind: 'text', title: '待关联合同', content: '合同正文不进聊天工具' } }] }) as { results: Array<{ id: string; revision: number; organizationRevision: number }> };
  const created = material.results[0];
  const task = await post(request, '/api/tasks', { title: '需要关联的任务' }) as { id: string };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/inbox');
  await ask(page, `关联这份项目资料 materialId=${created.id} materialRevision=${created.revision} organizationRevision=${created.organizationRevision} taskId=${task.id}`);
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-state', 'pending');
  await expect(card.getByRole('button', { name: '确认修改', exact: true })).toBeVisible();
  expect((await linkedTasks(request, created.id)).items).toEqual([]);

  await page.setViewportSize({ width: 390, height: 800 });
  const reject = card.getByRole('button', { name: '取消', exact: true });
  const approve = card.getByRole('button', { name: '确认修改', exact: true });
  await reject.scrollIntoViewIfNeeded();
  await expect(reject).toBeVisible();
  await expect(approve).toBeEnabled();
  const boxes = await Promise.all([reject.boundingBox(), approve.boundingBox()]);
  expect(boxes.every((box) => box && box.width >= 24 && box.height >= 24 && box.y >= 0 && box.y + box.height <= 800)).toBe(true);
  await reject.click();
  await expect(card).toHaveAttribute('data-state', 'rejected');
  await expect(card.getByRole('status')).toContainText('已取消，未修改数据');
  expect((await linkedTasks(request, created.id)).items).toEqual([]);
  const stored = await request.get(`${api}/api/v1/library/materials/${created.id}`);
  expect(stored.ok(), await stored.text()).toBe(true);
  expect((await stored.json()).data.title).toBe('待关联合同');
});
