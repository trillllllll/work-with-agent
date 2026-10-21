/**
 * Browser E2E for the orchestration flow (run with `npm run e2e:orchestration`).
 * A real wwa-node process pulls jobs from the real server, runs the stub Codex CLI in worktrees it creates,
 * and the browser drives pairing, project binding, the one-time grant, acceptance, push, PR and worktree cleanup.
 * The server process never touches the repository: every git change below comes from the node process.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT ?? '3415'}`;
const composer = '例如：创建任务：整理 API 文档';
const mock = `http://127.0.0.1:${process.env.MOCK_OPENAI_PORT ?? '4410'}`;
const repoRoot = process.cwd();
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const at = () => new Date().toISOString();

let root = ''; let code = ''; let repo = ''; let remote = ''; let nodeData = '';
let agent: ChildProcess | null = null; let agentLog = ''; let token = ''; let holdId = '';
const state: { mainId: string; orchestrationId: string; integrationPath: string; integrationBranch: string } = { mainId: '', orchestrationId: '', integrationPath: '', integrationBranch: '' };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await resetE2eDatabase();
  root = await mkdtemp(join(tmpdir(), 'wwa-orch-e2e-'));
  code = join(root, 'code'); repo = join(code, 'demo'); remote = join(root, 'origin.git'); nodeData = join(root, 'node');
  await mkdir(repo, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(repo, 'init', '-q', '-b', 'main'); await writeFile(join(repo, 'README.md'), '# demo\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init'); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-q', 'origin', 'main');
  // Fake GitHub CLI for the optional PR step.
  const gh = join(root, 'gh.mjs');
  await writeFile(gh, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args = process.argv.slice(2); const f = ${JSON.stringify(join(root, 'gh-pr'))};\nif (args[0] === '--version') { console.log('gh 0.0.0'); process.exit(0); }\nif (args[1] === 'view') { if (fs.existsSync(f)) { console.log(fs.readFileSync(f, 'utf8')); process.exit(0); } process.exit(1); }\nif (args[1] === 'create') { const url = 'https://github.com/example/demo/pull/42'; fs.writeFileSync(f, url); console.log(url); process.exit(0); }\nprocess.exit(2);\n`);
  await chmod(gh, 0o755);
  process.env.WWA_GH_BIN = gh;
  // The orchestrator model is the mock model on its own port.
  const saved = await request.patch(`${api}/api/settings`, { data: { baseUrl: `${mock}/v1`, model: 'mock-model', apiKey: 'e2e-key' } });
  expect(saved.ok(), await saved.text()).toBe(true);
  // A main task with two independent subtasks, created directly in the database.
  const main = await e2eDatabase.task.create({ data: { title: 'E2E 编排功能', description: '端到端编排', createdAt: at(), updatedAt: at() } });
  state.mainId = main.id;
  for (const [index, title] of ['Task A', 'Task B'].entries()) await e2eDatabase.task.create({ data: { title, description: `write ${title}`, parentId: main.id, sortOrder: index, createdAt: at(), updatedAt: at() } });
});

test.afterAll(async () => {
  agent?.kill('SIGTERM');
  if (root) await rm(root, { recursive: true, force: true });
  delete process.env.WWA_GH_BIN;
});

function startAgent(issued: string, extra: Record<string, string> = {}) {
  agentLog = '';
  agent = spawn(process.execPath, ['--max-old-space-size=256', '--import', 'tsx', resolve(repoRoot, 'server/src/node-agent/index.ts'), '--server', api, '--token', issued, '--roots', code, '--data', nodeData, '--max', '2'], {
    cwd: repoRoot,
    env: { ...process.env, WWA_CODEX_BIN: resolve(repoRoot, 'server/test/stub-orchestration-cli.mjs'), STUB_DELAY_MS: '100', NODE_OPTIONS: '', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout?.on('data', (chunk) => { agentLog += chunk; });
  agent.stderr?.on('data', (chunk) => { agentLog += chunk; });
}

async function stopAgent() {
  const child = agent;
  agent = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const killer = setTimeout(() => child.kill('SIGKILL'), 12_000);
  await exited;
  clearTimeout(killer);
}

async function runIds() {
  const dir = join(nodeData, 'runner', 'runs');
  if (!existsSync(dir)) return [] as string[];
  return readdir(dir);
}

function lastReceipt(text: string): { state?: string; cancelled?: boolean; childPid?: number } | null {
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]) as { state?: string; cancelled?: boolean; childPid?: number }; } catch { /* torn trailing line */ }
  }
  return null;
}

async function runningControlDir(known: Set<string>) {
  for (const id of await runIds()) {
    if (known.has(id)) continue;
    const receiptPath = join(nodeData, 'runner', 'runs', id, 'receipt.jsonl');
    if (!existsSync(receiptPath)) continue;
    if (lastReceipt(await readFile(receiptPath, 'utf8'))?.state === 'running') return join(nodeData, 'runner', 'runs', id);
  }
  return '';
}

async function captureNotifications(page: Page) {
  // Record browser notifications; the page stays visible but unfocused, like a window in the background.
  await page.addInitScript(() => {
    const notes: Array<{ title: string; body?: string }> = [];
    (window as unknown as { __notes: typeof notes }).__notes = notes;
    class FakeNotification { static permission = 'granted'; static requestPermission = async () => 'granted'; constructor(title: string, options?: { body?: string }) { notes.push({ title, body: options?.body }); } }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
    document.hasFocus = () => false;
  });
}

test('pairs a local executor, runs a round through it, notifies, accepts, pushes and opens a PR', async ({ page }) => {
  await captureNotifications(page);
  await page.goto('/#/settings/local');
  const settings = page.getByRole('region', { name: '主控与电脑设置' });
  await settings.getByRole('button', { name: '添加电脑' }).click();
  const add = page.getByRole('dialog', { name: '添加电脑' });
  await add.getByRole('textbox', { name: '名称' }).fill('E2E 笔记本');
  await add.getByRole('button', { name: '生成连接命令' }).click();
  const command = await add.locator('code', { hasText: '--token' }).innerText();
  const issued = command.match(/--token (\S+)/)?.[1];
  expect(issued).toBeTruthy();
  token = issued!;
  await add.getByRole('button', { name: 'Close' }).click();
  startAgent(token);
  await expect(settings.getByText('在线')).toBeVisible({ timeout: 30_000 });

  // Project + location: the node (not the server) verifies the path.
  await page.goto('/#/settings/projects');
  const projects = page.getByRole('region', { name: '项目设置' });
  await projects.getByPlaceholder('项目名称').fill('demo');
  await projects.getByRole('button', { name: '新建项目' }).click();
  await projects.getByPlaceholder('这台电脑上的仓库绝对路径').fill(repo);
  await projects.getByRole('button', { name: '添加项目位置' }).click();
  await expect(projects.getByText('已验证')).toBeVisible({ timeout: 30_000 });

  // Open the main task and start a round from its detail.
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${state.mainId}`).getByRole('button', { name: 'E2E 编排功能', exact: true }).click();
  await page.getByRole('button', { name: '开始运行' }).click();
  const dialog = page.getByRole('dialog', { name: '主控编排' });
  await expect(dialog.locator('select').first().locator('option', { hasText: 'demo' })).toHaveCount(1);
  const savedBinding = page.waitForResponse((response) => response.url().includes(`/api/project-bindings/task/${state.mainId}`) && response.request().method() === 'PUT' && response.ok());
  await dialog.locator('select').first().selectOption({ label: 'demo' });
  await savedBinding;
  await dialog.getByRole('button', { name: '生成执行计划' }).click();
  await expect(dialog.getByText('mock 计划：互不依赖').first()).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText('可并行')).toHaveCount(2);
  await dialog.getByRole('button', { name: '确认并开始运行' }).click();

  await expect(dialog.getByText('待验收', { exact: true })).toBeVisible({ timeout: 120_000 });
  const row = await e2eDatabase.orchestration.findFirstOrThrow({ where: { taskId: state.mainId } });
  Object.assign(state, { orchestrationId: row.id, integrationPath: row.integrationPath!, integrationBranch: row.integrationBranch });
  expect(row.integrationPath!.startsWith(nodeData)).toBe(true);
  for (const file of ['Task-A.txt', 'Task-B.txt']) expect(git(row.integrationPath!, 'ls-files', file)).toBe(file);
  // The main checkout was never touched.
  expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(git(repo, 'status', '--porcelain')).toBe('');
  // System notification for "awaiting acceptance".
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __notes: Array<{ title: string }> }).__notes.map((item) => item.title))).toContain('任务待验收');

  await dialog.getByTestId('orchestration-accept').click();
  await page.getByTestId('accept-dialog').getByTestId('accept-confirm').click();
  await expect(dialog.getByText('已验收', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '推送集成分支' }).click();
  await expect.poll(() => { try { return git(remote, 'rev-parse', `refs/heads/${row.integrationBranch}`); } catch { return ''; } }, { timeout: 30_000 }).toBe(row.integrationHead);
  await dialog.getByRole('button', { name: '创建 PR' }).click();
  await expect(dialog.getByRole('link', { name: 'https://github.com/example/demo/pull/42' })).toBeVisible({ timeout: 30_000 });
});

test('worktree page lists the node worktrees and deletes only after the confirmation card', async ({ page }) => {
  expect(state.integrationPath).toBeTruthy();
  await page.goto('/#/worktrees');
  const section = page.getByRole('region', { name: '电脑 E2E 笔记本' });
  await section.getByRole('button', { name: '刷新' }).click();
  const integrationName = `${state.orchestrationId}/integration`;
  await expect(section.getByText(integrationName, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(section.getByRole('row').filter({ hasText: integrationName })).toContainText('集成 · 已验收（已推送）');

  // Cancel keeps everything.
  await section.getByRole('checkbox', { name: `选择 ${integrationName}` }).check();
  await section.getByRole('button', { name: '删除选中的 1 个…' }).click();
  let card = page.getByRole('dialog', { name: '确认删除 worktree' });
  await expect(card).toContainText(integrationName);
  await card.getByRole('button', { name: '取消' }).click();
  await expect(card).toBeHidden();
  expect(git(repo, 'worktree', 'list')).toContain(state.integrationPath);
  expect(await e2eDatabase.nodeJob.count({ where: { kind: 'cleanup' } })).toBe(0);

  // Confirm removes it on the node.
  await section.getByRole('checkbox', { name: `选择 ${integrationName}` }).check();
  await section.getByRole('button', { name: '删除选中的 1 个…' }).click();
  card = page.getByRole('dialog', { name: '确认删除 worktree' });
  await expect(card).toContainText('将删除 1 个 worktree');
  expect(git(repo, 'worktree', 'list')).toContain(state.integrationPath);
  await card.getByRole('button', { name: '确认删除 1 个' }).click();
  // The node removes it on its next lease; the page then shows the node's fresh listing.
  await expect.poll(() => git(repo, 'worktree', 'list'), { timeout: 30_000 }).not.toContain(state.integrationPath);
  await expect(section.getByText(integrationName, { exact: true })).toBeHidden({ timeout: 15_000 });
  await expect.poll(async () => (await e2eDatabase.worktreeCleanup.findFirstOrThrow({ where: { status: { not: 'cancelled' } } })).status).toBe('done');
  // Subtask worktrees are still listed; nothing else was removed.
  await expect(section.getByRole('row')).not.toHaveCount(1);
});

test('the assistant can only propose a worktree deletion; the user confirms it in the chat card', async ({ page }) => {
  const before = git(repo, 'worktree', 'list');
  const cleanupsBefore = await e2eDatabase.worktreeCleanup.count();
  await page.goto('/');
  if (!(await page.getByPlaceholder(composer).isVisible())) await page.getByRole('button', { name: '打开聊天', exact: true }).click();
  await page.getByPlaceholder(composer).fill('帮我清理已验收的 worktree');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const card = page.getByRole('group', { name: '待确认的删除' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('由 AI 助手发起');
  await expect(page.getByText('删除卡片已经生成，请在卡片上确认。')).toBeVisible();
  const row = await e2eDatabase.worktreeCleanup.findFirstOrThrow({ where: { source: 'assistant' } });
  expect(row.status).toBe('pending');
  expect(await e2eDatabase.worktreeCleanup.count()).toBe(cleanupsBefore + 1);
  // Nothing reached the node before the user's click.
  expect(await e2eDatabase.nodeJob.count({ where: { kind: 'cleanup', dispatchKey: `cleanup:${row.id}` } })).toBe(0);
  expect(git(repo, 'worktree', 'list')).toBe(before);
  const target = (JSON.parse(row.itemsJson) as Array<{ path: string; action: string }>).find((item) => item.action === 'remove')!.path;
  await card.getByRole('button', { name: '确认删除' }).click();
  await expect.poll(() => git(repo, 'worktree', 'list'), { timeout: 30_000 }).not.toContain(target);
  await expect(page.getByRole('status', { name: 'worktree 删除结果' })).toContainText('已删除 1 个 worktree', { timeout: 20_000 });
});

test('revoking the computer cancels the running stub and leaves no resume action', async ({ page }) => {
  await stopAgent();
  startAgent(token, { STUB_HOLD_MS: '120000' });
  await expect.poll(() => agentLog.includes('已连接') && agent?.exitCode == null, { timeout: 30_000 }).toBe(true);
  // Slug must differ from the earlier round: both "E2E …" titles become orch/e2e-r1, and setup refuses to overwrite that branch.
  const main = await e2eDatabase.task.create({ data: { title: 'Revoke Hold', description: '吊销时取消', createdAt: at(), updatedAt: at() } });
  holdId = main.id;
  await e2eDatabase.task.create({ data: { title: 'Hold Task', description: 'write Hold Task', parentId: main.id, sortOrder: 0, createdAt: at(), updatedAt: at() } });

  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${holdId}`).getByRole('button', { name: 'Revoke Hold', exact: true }).click();
  await page.getByRole('button', { name: '开始运行' }).click();
  const dialog = page.getByRole('dialog', { name: '主控编排' });
  await expect(dialog.locator('select').first().locator('option', { hasText: 'demo' })).toHaveCount(1);
  const savedBinding = page.waitForResponse((response) => response.url().includes(`/api/project-bindings/task/${holdId}`) && response.request().method() === 'PUT' && response.ok());
  await dialog.locator('select').first().selectOption({ label: 'demo' });
  await savedBinding;
  await dialog.getByRole('button', { name: '生成执行计划' }).click();
  await expect(dialog.getByText('mock 计划：互不依赖').first()).toBeVisible({ timeout: 30_000 });
  const known = new Set(await runIds());
  await dialog.getByRole('button', { name: '确认并开始运行' }).click();
  let controlDir = '';
  await expect.poll(async () => { controlDir = await runningControlDir(known); return controlDir; }, { timeout: 90_000 }).not.toBe('');

  await page.goto('/#/settings/local');
  const card = page.getByRole('region', { name: '主控与电脑设置' }).locator('article').filter({ hasText: 'E2E 笔记本' });
  await card.getByRole('button', { name: '吊销', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '吊销这台电脑' });
  const child = agent;
  expect(child).toBeTruthy();
  const exited = new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    child!.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  await confirm.getByRole('button', { name: '吊销', exact: true }).click();
  expect(await exited, agentLog.slice(-3000)).toBe(3);
  expect(existsSync(join(controlDir, 'cancel.request'))).toBe(true);
  const receipt = lastReceipt(await readFile(join(controlDir, 'receipt.jsonl'), 'utf8'));
  let stopped = receipt?.cancelled === true;
  if (!stopped && typeof receipt?.childPid === 'number') {
    try { process.kill(receipt.childPid, 0); } catch { stopped = true; }
  }
  expect(stopped).toBe(true);

  // Settings is a modal over the still-open round. Closing it leaves that panel in front, so the task row is not clickable.
  await page.goto('/#/inbox');
  const panel = page.getByRole('dialog', { name: '主控编排' });
  const row = page.getByTestId(`task-row-${holdId}`).getByRole('button', { name: 'Revoke Hold', exact: true });
  await expect(panel.or(row)).toBeVisible({ timeout: 30_000 });
  if (await row.isVisible()) {
    await row.click();
    await page.getByRole('button', { name: '编排 · 已暂停' }).click();
  }
  await expect(panel.getByRole('alert')).toContainText('电脑已断开');
  await expect(panel.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && agentLog) await info.attach('wwa-node.log', { body: agentLog.slice(-20_000), contentType: 'text/plain' });
});
