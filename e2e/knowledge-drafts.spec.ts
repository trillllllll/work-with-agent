import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

async function project(request: APIRequestContext, name: string) {
  const response = await request.post('http://127.0.0.1:3015/api/topics', { data: { name } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data.id as string;
}

/** Commit on the real server, then hold only the response to reproduce a late
 * completion while the user continues editing another draft. */
async function holdResponse(page: Page, path: string, method: string) {
  let release!: () => void;
  let captured!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { captured = resolve; });
  let held = false;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== method || held) { await route.continue(); return; }
    held = true;
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  return { started, release };
}

test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());

test('固定说明迟到保存只更新原清单，保留保存后的新输入及另一清单草稿', async ({ page, request }) => {
  const first = await project(request, '说明清单 A');
  const second = await project(request, '说明清单 B');
  await page.goto('/#/knowledge');
  const scope = page.getByLabel('资料所属清单', { exact: true });
  await scope.selectOption(first);
  await page.getByRole('button', { name: '当前简报', exact: true }).click();
  const notes = page.getByLabel('简报固定说明', { exact: true });
  await notes.fill('A 已提交的说明');
  const delayed = await holdResponse(page, '/api/v1/knowledge/brief', 'PUT');
  await page.getByRole('button', { name: '保存固定说明', exact: true }).click();
  await delayed.started;
  await notes.fill('A 保存之后继续输入的说明');
  await scope.selectOption(second);
  await notes.fill('B 尚未保存的说明');
  delayed.release();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await expect(notes).toHaveValue('B 尚未保存的说明');
  expect((await e2eDatabase.workingBrief.findUniqueOrThrow({ where: { id: `topic:${first}` } })).manualNotes).toBe('A 已提交的说明');
  expect((await e2eDatabase.workingBrief.findUniqueOrThrow({ where: { id: `topic:${second}` } })).manualNotes).toBe('');
  await page.getByRole('button', { name: '保存固定说明', exact: true }).click();
  await expect.poll(async () => (await e2eDatabase.workingBrief.findUniqueOrThrow({ where: { id: `topic:${second}` } })).manualNotes).toBe('B 尚未保存的说明');
  await scope.selectOption(first);
  await expect(notes).toHaveValue('A 保存之后继续输入的说明');
  await page.getByRole('button', { name: '保存固定说明', exact: true }).click();
  await expect.poll(async () => (await e2eDatabase.workingBrief.findUniqueOrThrow({ where: { id: `topic:${first}` } })).manualNotes).toBe('A 保存之后继续输入的说明');
});

test('材料保存锁住提交表单，切清单的新编辑实例不受旧响应关闭', async ({ page, request }) => {
  const first = await project(request, '材料清单 A');
  const second = await project(request, '材料清单 B');
  await page.goto('/#/knowledge');
  const scope = page.getByLabel('资料所属清单', { exact: true });
  await scope.selectOption(first);
  await page.getByRole('button', { name: '保存材料', exact: true }).click();
  await page.getByLabel('材料标题', { exact: true }).fill('A 的材料');
  await page.getByLabel('材料正文', { exact: true }).fill('A 的原始内容');
  const delayed = await holdResponse(page, '/api/v1/commands', 'POST');
  await page.getByRole('button', { name: '保存材料', exact: true }).last().click();
  await delayed.started;
  await expect(page.getByLabel('材料正文', { exact: true })).toBeDisabled();
  await scope.selectOption(second);
  await page.getByRole('button', { name: '保存材料', exact: true }).click();
  await page.getByLabel('材料标题', { exact: true }).fill('B 的新材料草稿');
  await page.getByLabel('材料正文', { exact: true }).fill('B 的未保存内容');
  delayed.release();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await expect(page.getByLabel('材料标题', { exact: true })).toHaveValue('B 的新材料草稿');
  await expect(page.getByLabel('材料正文', { exact: true })).toHaveValue('B 的未保存内容');
  expect(await e2eDatabase.material.count({ where: { topicId: first } })).toBe(1);
  expect(await e2eDatabase.material.count({ where: { topicId: second } })).toBe(0);
  await page.getByRole('button', { name: '保存材料', exact: true }).last().click();
  await expect.poll(() => e2eDatabase.material.count({ where: { topicId: second, title: 'B 的新材料草稿' } })).toBe(1);
  await expect(page.getByLabel('材料标题', { exact: true })).toHaveCount(0);
  expect((await e2eDatabase.material.findFirstOrThrow({ where: { topicId: first } })).title).toBe('A 的材料');
});
