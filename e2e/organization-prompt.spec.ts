import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = 'http://127.0.0.1:3015';

async function owner(request: APIRequestContext, path: string, input: unknown) {
  const response = await request.post(`${base}${path}`, { data: input });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());

test('外部整理请求展示可复制提示词，已提交的请求不再展示', async ({ page, request }) => {
  const pending = await owner(request, '/api/v1/knowledge/organizations', { topicId: null, purpose: '待复制的整理', provider: 'external' });
  const submitted = await owner(request, '/api/v1/knowledge/organizations', { topicId: null, purpose: '已提交的整理', provider: 'external' });
  await owner(request, `/api/v1/knowledge/organizations/${submitted.id}/candidates`, { summary: '有一条待办', commands: [{ kind: 'task.create', input: { title: '整理产生的待办' } }] });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#/knowledge');
  await page.getByText('AI 辅助整理', { exact: true }).click();
  await expect(page.getByLabel('整理方式', { exact: true })).toHaveValue('external');
  await expect(page.getByRole('button', { name: '准备整理', exact: true })).toBeEnabled();
  const prompt = page.getByLabel(`整理提示词 ${pending.id}`, { exact: true });
  await expect(prompt).toContainText('待复制的整理');
  await expect(prompt).toContainText('get_organization_request');
  await expect(prompt).toContainText('submit_organization_result');
  await expect(prompt).toContainText('不要确认');
  await expect(page.getByLabel(`整理提示词 ${submitted.id}`, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '检查待确认建议', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `复制整理提示词 ${pending.id}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `复制整理提示词 ${pending.id}`, exact: true })).toHaveText('已复制');
  const shown = await prompt.innerText();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
});
