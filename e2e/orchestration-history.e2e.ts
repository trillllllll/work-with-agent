/**
 * AI history and the orchestration-rounds tab.
 * A real wwa-node runs the stub CLI; the browser then opens history for the main task and a subtask,
 * and opens the round again from the runs page. The server process never touches the repository.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT ?? '3415'}`;
const composer = '例如：创建任务：整理 API 文档';
const mock = `http://127.0.0.1:${process.env.MOCK_OPENAI_PORT ?? '4410'}`;
const repoRoot = process.cwd();
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const at = () => new Date().toISOString();

let root = '';
let agent: ChildProcess | null = null;
let agentLog = '';
const state: { mainId: string; subA: string; subB: string } = { mainId: '', subA: '', subB: '' };

test.describe.configure({ timeout: 420_000 });

async function bodyOf(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  const text = await response.text();
  if (!response.ok()) throw new Error(`HTTP ${response.status()} ${text.slice(0, 800)}`);
  return JSON.parse(text) as { data: any };
}

async function waitFor(label: string, ready: () => Promise<boolean>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const row = state.mainId ? await e2eDatabase.orchestration.findFirst({ where: { taskId: state.mainId } }) : null;
  throw new Error(`timed out waiting for ${label} (status=${row?.status ?? 'none'} pause=${row?.pauseReason ?? ''} comment=${row?.finalComment ?? ''})\n${agentLog.slice(-2000)}`);
}

test.beforeAll(async ({ request }) => {
  await resetE2eDatabase();
  root = await mkdtemp(join(tmpdir(), 'wwa-orch-history-'));
  const code = join(root, 'code');
  const repo = join(code, 'demo');
  const remote = join(root, 'origin.git');
  const nodeData = join(root, 'node');
  await mkdir(repo, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');

  const saved = await request.patch(`${api}/api/settings`, { data: { baseUrl: `${mock}/v1`, model: 'mock-model', apiKey: 'e2e-key' } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const main = await e2eDatabase.task.create({ data: { title: 'E2E 履历', description: '履历端到端', createdAt: at(), updatedAt: at() } });
  state.mainId = main.id;
  const titles = ['Task A', 'Task B'];
  for (const [index, title] of titles.entries()) {
    const child = await e2eDatabase.task.create({ data: { title, description: `write ${title}`, parentId: main.id, sortOrder: index, createdAt: at(), updatedAt: at() } });
    if (index === 0) state.subA = child.id;
    else state.subB = child.id;
  }

  const node = await bodyOf(await request.post(`${api}/api/nodes`, { data: { name: 'E2E 笔记本' } }));
  agent = spawn(process.execPath, ['--max-old-space-size=256', '--import', 'tsx', resolve(repoRoot, 'server/src/node-agent/index.ts'), '--server', api, '--token', node.data.token, '--roots', code, '--data', nodeData, '--max', '2'], {
    cwd: repoRoot,
    env: { ...process.env, DOVUN_CODEX_BIN: resolve(repoRoot, 'server/test/stub-orchestration-cli.mjs'), STUB_DELAY_MS: '100', NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout?.on('data', (chunk) => { agentLog += chunk; });
  agent.stderr?.on('data', (chunk) => { agentLog += chunk; });

  const project = await bodyOf(await request.post(`${api}/api/projects`, { data: { name: 'demo' } }));
  await bodyOf(await request.post(`${api}/api/projects/${project.data.id}/locations`, { data: { nodeId: node.data.node.id, path: repo } }));
  await waitFor('verified location', async () => (await e2eDatabase.projectLocation.findFirst({ where: { projectId: project.data.id } }))?.status === 'verified', 30_000);
  await bodyOf(await request.put(`${api}/api/project-bindings/task/${main.id}`, { data: { projectId: project.data.id } }));
  const preview = await bodyOf(await request.post(`${api}/api/orchestrations/preview`, { data: { taskId: main.id } }));
  const locationId = preview.data.locations[0].id as string;
  await bodyOf(await request.post(`${api}/api/orchestrations/${preview.data.id}/start`, { data: { expectedRevision: preview.data.revision, locationId, maxParallel: 2 } }));
  await waitFor('awaiting_acceptance', async () => (await e2eDatabase.orchestration.findFirst({ where: { taskId: main.id } }))?.status === 'awaiting_acceptance');
});

test.afterAll(async () => {
  agent?.kill('SIGTERM');
  if (root) await rm(root, { recursive: true, force: true });
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && agentLog) await info.attach('wwa-node.log', { body: agentLog.slice(-20_000), contentType: 'text/plain' });
});

async function openTask(page: Page, id: string, title: string) {
  await page.getByTestId(`task-row-${id}`).getByRole('button', { name: title, exact: true }).click();
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(detail).toBeVisible();
  return detail;
}

test('shows AI history for the main task and a subtask, and opens the round from the runs tab', async ({ page }) => {
  await page.goto('/#/inbox');
  const detail = await openTask(page, state.mainId, 'E2E 履历');
  await detail.getByTestId('task-ai-history').click();
  const history = page.getByTestId('ai-history-dialog');
  await expect(history.getByText('开发', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(history.getByText('合入', { exact: true }).first()).toBeVisible();
  await expect(history.getByText('独立核对', { exact: true }).first()).toBeVisible();
  await expect(history.getByTestId('ai-history-round')).toHaveCount(1);
  await expect(history.getByTestId('ai-history-step')).toHaveCount(6);
  await expect(history).toContainText(/1[,.]?200|1\.2/);
  await expect(history).toContainText('退出码 0');
  await expect(history).toContainText(/费用\s*—/);
  await expect(history.getByText('Task A', { exact: true }).first()).toBeVisible();
  await expect(history.getByText('Task B', { exact: true }).first()).toBeVisible();

  await history.getByRole('button', { name: 'Close' }).click();
  await expect(history).toBeHidden();
  await detail.getByRole('button', { name: '关闭任务详情' }).click();
  await expect(detail).toBeHidden();

  const subDetail = await openTask(page, state.subA, 'Task A');
  await subDetail.getByTestId('task-ai-history').click();
  const subHistory = page.getByTestId('ai-history-dialog');
  await expect(subHistory.getByText('独立核对', { exact: true })).toBeVisible();
  await expect(subHistory.getByTestId('ai-history-step')).toHaveCount(3);
  await expect(subHistory.getByText('Task A', { exact: true }).first()).toBeVisible();
  await expect(subHistory.getByText('Task B')).toHaveCount(0);
  await expect(subHistory.getByText('建集成分支')).toHaveCount(0);
  await subHistory.getByRole('button', { name: 'Close' }).click();
  await subDetail.getByRole('button', { name: '关闭任务详情' }).click();
  await expect(subDetail).toBeHidden();

  await page.goto('/#/runs');
  await expect(page.getByTestId('runs-tab-orchestrations')).toHaveAttribute('aria-selected', 'true');
  const card = page.getByTestId('orchestration-feed-item').filter({ hasText: 'E2E 履历' });
  await expect(card).toBeVisible();
  await page.getByTestId('runs-tab-handoffs').click();
  await expect(page).toHaveURL(/#\/runs\?tab=handoffs/);
  await expect(page.getByText('还没有交接记录。')).toBeVisible();
  await page.getByTestId('runs-tab-orchestrations').click();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByRole('dialog', { name: '主控编排' })).toBeVisible();
});

test('rejects with a required reason, redispatches with that summary, and accepts the next round with a note', async ({ page }) => {
  test.setTimeout(240_000);
  const reason = '合入范围不对';
  const note = '可以合并';
  await page.goto('/#/inbox');
  const detail = await openTask(page, state.mainId, 'E2E 履历');
  await detail.getByRole('button', { name: '编排 · 待验收' }).click();
  const dialog = page.getByRole('dialog', { name: '主控编排' });
  await dialog.getByTestId('orchestration-reject').click();
  const reject = page.getByTestId('reject-dialog');
  await expect(reject.getByText('打回必须写理由')).toBeVisible();
  await expect(reject.getByTestId('reject-confirm')).toBeDisabled();
  await reject.getByTestId('reject-reason').fill('   ');
  await expect(reject.getByTestId('reject-confirm')).toBeDisabled();
  await reject.getByTestId('reject-reason').fill(reason);
  await expect(reject.getByTestId('reject-confirm')).toBeEnabled();
  await reject.getByTestId('reject-confirm').click();
  await expect(dialog.getByText('已打回', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText(reason);
  await dialog.getByRole('button', { name: '改完任务后重新派发' }).click();
  const summary = dialog.getByTestId('prior-summary');
  await summary.locator('summary').click();
  await expect(summary).toContainText(reason);
  await dialog.getByRole('button', { name: '确认并开始运行' }).click();
  await waitFor('second awaiting_acceptance', async () => !!(await e2eDatabase.orchestration.findFirst({ where: { taskId: state.mainId, status: 'awaiting_acceptance' } })));
  await expect(dialog.getByText('待验收', { exact: true })).toBeVisible({ timeout: 20_000 });
  await dialog.getByTestId('orchestration-accept').click();
  const accept = page.getByTestId('accept-dialog');
  await accept.getByPlaceholder('可选，写下验收意见').fill(note);
  await accept.getByTestId('accept-confirm').click();
  await expect(dialog.getByText('已验收', { exact: true })).toBeVisible();
  await expect(page.getByTestId('accept-dialog')).toBeHidden();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await detail.getByTestId('task-ai-history').click();
  const history = page.getByTestId('ai-history-dialog');
  await expect(history.getByTestId('ai-history-round')).toHaveCount(2);
  await expect(history.getByTestId('ai-history-verdict').filter({ hasText: reason })).toBeVisible();
  await expect(history.getByTestId('ai-history-verdict').filter({ hasText: note })).toBeVisible();
});

test('stats tab counts the rounds from this run, including the rejection', async ({ page }) => {
  await page.goto('/#/runs?tab=stats');
  await expect(page.getByTestId('runs-tab-stats')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/tab=stats/);
  const rounds = page.getByTestId('stats-card-rounds');
  await expect(rounds).toBeVisible();
  await expect.poll(async () => Number((await rounds.locator('.text-2xl').innerText()).replace(/[^\d]/g, ''))).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('stats-rejected')).toHaveText('1');
  await expect(page.getByTestId('dispatch-stats')).toBeVisible();
  await expect(page.getByTestId('stats-card-pass')).toBeVisible();
  await expect(page.getByTestId('stats-failures')).toBeVisible();
  await expect(page.getByTestId('stats-top-duration')).toBeVisible();
});

test('the assistant answers a dispatch-stats question from orchestration_stats', async ({ page }) => {
  await page.goto('/');
  if (!(await page.getByPlaceholder(composer).isVisible())) await page.getByRole('button', { name: '打开聊天', exact: true }).click();
  await page.getByPlaceholder(composer).fill('统计这周 AI 派发');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText(/本周派发 \d+ 轮/)).toBeVisible({ timeout: 30_000 });
  const lookup = page.getByRole('button', { name: '查询了 1 项' });
  await lookup.click();
  await expect(lookup).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /派发统计/ })).toBeVisible();
});
