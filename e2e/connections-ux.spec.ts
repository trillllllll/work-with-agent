import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());

test('创建连接明确显示必填条件，并在条件满足后可提交', async ({ page }) => {
  await page.goto('/#/connections');

  const create = page.getByRole('button', { name: '创建连接', exact: true });
  await expect(page.getByText('连接名称（必填）', { exact: true })).toBeVisible();
  await expect(page.getByText('请先填写连接名称。', { exact: true })).toBeVisible();
  await expect(create).toBeDisabled();

  await page.getByLabel('连接名称', { exact: true }).fill('我的 Claude Code');
  await page.getByLabel('AI 宿主', { exact: true }).selectOption('claude');
  await expect(page.getByText('请至少选择收集箱或一个清单。', { exact: true })).toBeVisible();
  await page.getByLabel('允许访问收集箱', { exact: true }).check();
  await expect(create).toBeEnabled();

  await create.click();
  await expect(page.getByRole('heading', { name: '连接凭据', exact: true })).toBeVisible();
  await expect(page.getByText(/claude mcp add work_with_agent/)).toBeVisible();
  await expect(page.getByText(/--scope user --env/)).toBeVisible();
  await expect(page.getByText(/http:\/\/127\.0\.0\.1:3015/).first()).toBeVisible();
  await expect(page.getByText(/项目绝对路径/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制 Claude Code 配置命令', exact: true })).toBeVisible();
  await expect.poll(() => e2eDatabase.connection.count()).toBe(1);
});
