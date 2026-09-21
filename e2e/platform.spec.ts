import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';
const base = 'http://127.0.0.1:3015';
async function owner(request: APIRequestContext, path: string, input: unknown) {
  const response = await request.post(`${base}${path}`, { data: input });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}
async function connection(token: string, path: string, input?: unknown) {
  const response = await fetch(`${base}${path}`, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  return { status: response.status, ...(await response.json()) };
}
test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());

test('用户会话和连接权限覆盖旧 REST，提议经确认后才修改任务', async ({ page, request }) => {
  expect((await fetch(`${base}/api/tasks`)).status).toBe(401);
  const task = await owner(request, '/api/tasks', { title: '等待 AI 建议' });
  const access = await owner(request, '/api/v1/connections', { name: 'E2E Codex', host: 'codex', topicIds: [], includeInbox: true, autoActions: [] });
  expect((await connection(access.token, '/api/tasks')).status).toBe(403);
  const input = { requestId: crypto.randomUUID(), commands: [{ kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { title: '经用户确认的任务' } }] };
  const first = await connection(access.token, '/api/v1/commands', input);
  expect(first.data.status).toBe('pending_approval');
  expect((await connection(access.token, '/api/v1/commands', input)).data.proposalId).toBe(first.data.proposalId);
  expect((await e2eDatabase.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe('等待 AI 建议');
  await page.goto('/#/proposals');
  await expect(page.getByRole('heading', { name: '待确认', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认整组修改', exact: true }).click();
  await expect.poll(async () => (await e2eDatabase.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe('经用户确认的任务');
  await page.goto('/#/inbox');
  await expect(page.getByTestId(`task-row-${task.id}`)).toContainText('经用户确认的任务');
});

test('无需模型保存资料、修订原文、记录记忆和维护当前简报', async ({ page }) => {
  await page.goto('/#/knowledge');
  await page.getByRole('button', { name: '保存材料', exact: true }).click();
  await page.getByLabel('材料标题', { exact: true }).fill('项目约束');
  await page.getByLabel('材料正文', { exact: true }).fill('第一版必须支持中文资料。');
  await page.getByRole('button', { name: '保存材料', exact: true }).last().click();
  await expect.poll(() => e2eDatabase.material.count()).toBe(1);
  await page.getByRole('button', { name: /项目约束/ }).click();
  await page.getByRole('button', { name: '编辑材料', exact: true }).click();
  await page.getByLabel('材料正文', { exact: true }).fill('第一版必须支持中文资料和来源追溯。');
  await page.getByRole('button', { name: '保存材料', exact: true }).last().click();
  await expect.poll(() => e2eDatabase.materialVersion.count()).toBe(2);
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.getByRole('button', { name: '记录记忆', exact: true }).click();
  await page.getByLabel('记忆标题', { exact: true }).fill('中文检索决策');
  await page.getByLabel('记忆正文', { exact: true }).fill('先采用可解释的关键词检索。');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await expect.poll(() => e2eDatabase.memory.count()).toBe(1);
  await page.getByRole('button', { name: '当前简报', exact: true }).click();
  await expect(page.getByText(/先采用可解释的关键词检索/)).toBeVisible();
  await page.getByLabel('简报固定说明', { exact: true }).fill('优先保持 Todo 可用。');
  await page.getByRole('button', { name: '保存固定说明', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '当前简报', exact: true }).click();
  await expect(page.getByLabel('简报固定说明', { exact: true })).toHaveValue('优先保持 Todo 可用。');
  expect(await e2eDatabase.appSetting.count()).toBe(0);
});

test('已有会话交接返回后由用户采纳并完成任务', async ({ page, request }) => {
  const task = await owner(request, '/api/tasks', { title: '待验收的研究任务' });
  const access = await owner(request, '/api/v1/connections', { name: 'E2E Claude', host: 'claude', topicIds: [], includeInbox: true, autoActions: [] });
  const handoff = await owner(request, '/api/v1/handoffs', { taskId: task.id, expectedTaskRevision: task.revision, instruction: '提交有来源的研究摘要', provider: 'claude', mode: 'manual', permissions: { profile: 'read_only', allowShell: false } });
  const claimed = await connection(access.token, `/api/v1/handoffs/${handoff.id}/claim`, { requestId: crypto.randomUUID() });
  expect(claimed.status).toBe(200);
  const run = claimed.data.run ?? claimed.data;
  const report = { claimToken: claimed.data.claimToken, eventId: 'e2e-result-001', externalSessionId: 'e2e-explicit-session', result: { outcome: 'ready_for_review', summary: '研究结论已经整理完成', questions: [], artifacts: [], checks: [] } };
  expect((await connection(access.token, `/api/v1/runs/${run.id}/report`, report)).status).toBe(200);
  expect((await connection(access.token, `/api/v1/runs/${run.id}/report`, report)).status).toBe(200);
  expect((await e2eDatabase.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('todo');
  await page.goto('/#/runs');
  await page.getByRole('button', { name: /提交有来源的研究摘要/ }).click();
  await expect(page.getByText('研究结论已经整理完成', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '采纳并完成任务', exact: true }).click();
  await expect.poll(async () => (await e2eDatabase.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('done');
});

test('基础回顾无需模型，规则默认暂停且保留每次主动生成的历史', async ({ page }) => {
  await page.goto('/#/reviews');
  await page.getByLabel('回顾名称', { exact: true }).fill('每日收集箱回顾');
  await page.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect.poll(() => e2eDatabase.reviewRule.count()).toBe(1);
  expect((await e2eDatabase.reviewRule.findFirstOrThrow()).enabled).toBe(false);
  await page.getByRole('button', { name: '立即生成回顾', exact: true }).click();
  await expect.poll(() => e2eDatabase.reviewBatch.count()).toBe(1);
  await page.getByRole('button', { name: '立即生成回顾', exact: true }).click();
  await expect.poll(() => e2eDatabase.reviewBatch.count()).toBe(2);
  expect(await e2eDatabase.appSetting.count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});
