import { test, expect, devices, type APIResponse } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import type { HarnessSnapshot } from '../server/src/node-agent/harness-protocol.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const listUrl = '/#/runs?tab=sessions';
const apiUrl = '/api/v1/harness-sessions';

async function data<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as T;
}

test('opens a project ZCode history on a phone and continues its original session', async ({ browser, page, request, baseURL, extraHTTPHeaders }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The test opens a phone viewport itself.');
  test.setTimeout(65_000);
  await resetE2eDatabase();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dovun-zcode-browser-')));
  const context = await browser.newContext({ ...devices['iPhone 13'], baseURL, extraHTTPHeaders, locale: 'zh-CN',
    storageState: await page.context().storageState() });
  let agent: ChildProcess | undefined;
  let nodeId: string | undefined;
  try {
    const project = join(root, 'zcode-project');
    const other = join(root, 'zcode-other-project');
    await Promise.all([mkdir(project), mkdir(other)]);
    const threadId = 'sess_zcode_mac_original';
    const store = join(root, 'zcode-store.json');
    const finishTool = join(root, 'finish-zcode-tool');
    const state = join(root, 'zcode-guard.db');
    const db = new DatabaseSync(state);
    db.exec('CREATE TABLE session_runtime_presence (session_id TEXT, process_id INTEGER)');
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, permission TEXT, time_deleted INTEGER)');
    db.prepare('INSERT INTO session (id) VALUES (?)').run(threadId);
    db.close();
    await writeFile(store, JSON.stringify([project, other].map((cwd, index) => ({
      sessionId: index ? 'sess_zcode_other' : threadId,
      workspace: { workspacePath: cwd, workspaceKey: cwd }, updatedAt: Date.now(),
      title: index ? '另一个项目的 ZCode 对话' : 'Mac 上的原 ZCode 对话',
      rows: Array.from({ length: 44 }, (_, i) => [
        { kind: 'userInput', turnId: 'turn-history-' + i, entityId: 'input-history-' + i, text: 'ZCode 历史消息 ' + i },
        ...(!index && i === 0 ? Array.from({ length: 60 }, (_, tool) => ({
          kind: 'toolCall', turnId: 'turn-history-0', entityId: 'history-tool-' + tool, toolName: 'Bash', status: 'success',
          input: { command: 'printf history-' + tool }, output: { text: 'ZCode 历史输出 ' + tool },
        })) : []),
      ]).flat().map((row, position) => ({ ...row, rowId: position + 1 })),
    }))));
    const node = await data<{ node: { id: string }; token: string }>(await request.post('/api/nodes', { data: { name: 'ZCode 测试 Mac' } }));
    nodeId = node.node.id;
    agent = spawn(process.execPath, ['--import', 'tsx', resolve('server/src/node-agent/index.ts'), '--server', process.env.E2E_API_URL!,
      '--roots', root, '--data', join(root, 'node')], { stdio: 'ignore', env: {
      ...process.env, DOVUN_NODE_TOKEN: node.token, DOVUN_CODEX_BIN: resolve('server/test/stub-harness-codex.mjs'),
      DOVUN_ZCODE_BIN: resolve('server/test/stub-harness-zcode.mjs'), ZCODE_SESSION_DB_PATH: state, HARNESS_TEST_ZCODE_STORE: store,
      HARNESS_TEST_ZCODE_TOOL_FINISH: finishTool,
    } });
    const phone = await context.newPage();
    await phone.goto(listUrl);
    const choice = phone.getByRole('radio', { name: 'ZCode', exact: true });
    await expect(choice).toBeVisible({ timeout: 18_000 });
    await choice.tap();
    const original = phone.getByRole('button', { name: /Mac 上的原 ZCode 对话/ });
    await expect(original).toBeVisible({ timeout: 15_000 });
    await expect(phone.getByRole('heading', { name: /^zcode-project/ })).toBeVisible();
    await expect(phone.getByRole('heading', { name: /^zcode-other-project/ })).toBeVisible();
    await original.tap();
    const chat = phone.getByRole('region', { name: '会话详情' });
    await expect(chat.locator('header [role=status]')).toHaveText('已连接', { timeout: 15_000 });
    await expect(chat.getByText('ZCode 历史消息 43', { exact: true })).toBeVisible();
    const oldest = chat.getByText('ZCode 历史消息 0', { exact: true });
    const more = chat.getByRole('button', { name: '加载更早的消息' });
    // WebKit can load the older page while scrolling the button into view.
    await expect.poll(async () => {
      if (await oldest.count()) return true;
      if (await more.count()) await more.click({ timeout: 1_000 }).catch(() => undefined);
      return (await oldest.count()) > 0;
    }, { timeout: 18_000 }).toBe(true);
    const oldProcess = chat.locator('[data-harness-turn="turn-history-0"] [data-harness-process]');
    await expect(oldProcess.locator('[data-harness-tool]')).toHaveCount(60);
    await oldProcess.locator(':scope > summary').tap();
    const oldTool = oldProcess.locator('[data-harness-tool="history-tool-0"]');
    await oldTool.locator('summary').tap();
    await expect(oldTool.getByLabel('命令输出')).toHaveText('ZCode 历史输出 0');
    const composer = chat.getByRole('textbox', { name: '输入消息' });
    await expect(composer).toHaveAttribute('placeholder', '发消息给 ZCode');
    await composer.fill('从手机接着聊');
    await chat.getByRole('button', { name: '发送', exact: true }).tap();
    const liveTurn = chat.locator('[data-harness-turn]').filter({ hasText: '从手机接着聊' });
    await expect(liveTurn.getByLabel('命令输出')).toHaveText('正在执行命令');
    await expect(liveTurn.locator('[data-tool-status]')).toHaveText('执行中');
    await expect(composer).toHaveAttribute('placeholder', '发消息给 ZCode');
    await writeFile(finishTool, '');
    await expect(chat.getByText('ZCode remembers ZCode 历史消息 0 · 从手机接着聊', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(chat.getByRole('status').getByText('ZCode 已受理', { exact: true })).toBeVisible();
    const id = new URLSearchParams(new URL(phone.url()).hash.split('?')[1]).get('sessionId');
    const detail = async () => data<{ threadId: string; snapshot: HarnessSnapshot | null }>(await request.get(apiUrl + '/' + id + '?timeline=1'));
    expect((await detail()).threadId).toBe(threadId);
    await expect.poll(async () => (await detail()).snapshot?.view.turn?.id).toMatch(/^stored-/);
    await phone.reload();
    await expect(chat.getByText('ZCode remembers ZCode 历史消息 0 · 从手机接着聊', { exact: true })).toHaveCount(1);
    const completedProcess = liveTurn.locator('[data-harness-process]');
    await completedProcess.locator(':scope > summary').tap();
    await expect(completedProcess.locator('[data-harness-tool]')).toHaveCount(1);
    await completedProcess.locator('[data-harness-tool] summary').tap();
    await expect(completedProcess.getByLabel('命令输出')).toHaveText('命令执行完成');
    await expect(completedProcess.locator('[data-tool-status]')).toHaveText('已完成');
  } finally {
    if (agent && agent.exitCode === null && agent.signalCode === null) {
      const exited = once(agent, 'exit');
      agent.kill('SIGTERM');
      await exited;
    }
    if (nodeId) {
      await e2eDatabase.harnessSession.deleteMany({ where: { nodeId } });
      await e2eDatabase.harnessDirectory.deleteMany({ where: { nodeId } });
    }
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop and phone open and control the same Harness session', async ({ browser, page, request, baseURL, extraHTTPHeaders }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The test opens desktop and mobile viewports in the same browser project.');
  test.setTimeout(120_000);
  await resetE2eDatabase();
  const folder = await mkdtemp(join(tmpdir(), 'dovun-harness-browser-'));
  const phoneContext = await browser.newContext({
    ...devices['iPhone 13'], baseURL, extraHTTPHeaders, locale: 'zh-CN',
    storageState: await page.context().storageState(),
  });
  let agent: ChildProcess | undefined;
  let nodeId: string | undefined;
  try {
    const workspace = join(folder, 'workspace');
    const repo = join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    execFileSync('git', ['init', '--quiet', repo]);
    const root = await realpath(workspace);
    const sibling = join(await realpath(folder), '另一组项目,共享目录');
    const customPath = join(sibling, '手机自选项目');
    await mkdir(customPath, { recursive: true });
    const node = await data<{ node: { id: string }; token: string }>(await request.post('/api/nodes', { data: { name: '测试电脑' } }));
    nodeId = node.node.id;
    const project = await data<{ id: string }>(await request.post('/api/projects', { data: { name: '会话测试项目', defaultParallel: 1 } }));
    const registeredPath = await realpath(repo);
    const registered = await data<{ location: { id: string } }>(await request.post('/api/projects/' + project.id + '/locations', { data: { nodeId: node.node.id, path: registeredPath } }));
    const nodeDir = join(folder, 'desktop', 'node');
    await mkdir(nodeDir, { recursive: true });
    const configFile = join(nodeDir, 'config.json');
    async function shareFolders(roots: string[]) {
      await writeFile(configFile + '.tmp', JSON.stringify({ server: process.env.E2E_API_URL!, token: node.token, roots, maxConcurrent: 1 }), { mode: 0o600 });
      await rename(configFile + '.tmp', configFile);
    }
    await shareFolders([root]);
    agent = spawn(process.execPath, ['--import', 'tsx', resolve('server/src/node-agent/index.ts'), '--data', nodeDir], {
      stdio: 'ignore',
      env: {
        ...process.env, DOVUN_NODE_MANAGED: 'desktop',
        DOVUN_CODEX_BIN: resolve('server/test/stub-harness-codex.mjs'),
        DOVUN_CLAUDE_BIN: join(folder, 'missing-claude'),
        HARNESS_TEST_CALLS: join(folder, 'calls'), HARNESS_TEST_HISTORY: join(folder, 'history.json'),
      },
    });
    const poll = async <T,>(check: () => Promise<T>, expected: T) => {
      await expect.poll(check, { timeout: 15_000 }).toEqual(expected);
    };
    await poll(async () => {
      const saved = await data<{ locations: Array<{ status: string }> }>(await request.get('/api/projects/' + project.id));
      return saved.locations[0].status;
    }, 'verified');

    const phone = await phoneContext.newPage();
    await phone.goto(listUrl);
    const phoneHarness = phone.getByRole('radiogroup', { name: 'Harness' });
    await expect(phoneHarness.getByRole('radio', { name: 'Codex' })).toBeChecked();
    await expect(phoneHarness.locator('select')).toHaveCount(0);
    await phone.getByRole('button', { name: '新建会话' }).tap();
    const phoneDialog = phone.getByRole('dialog', { name: '新建会话' });
    const phoneProject = phoneDialog.getByRole('radio', { name: /会话测试项目.*测试电脑/ });
    await expect(phoneProject).toBeVisible();
    await expect(phoneDialog.locator('select, [role=combobox]')).toHaveCount(0);
    await expect(phoneDialog.getByRole('button', { name: '开启 Codex 会话' })).toBeDisabled();
    await phoneProject.tap();
    await expect(phoneProject).toBeChecked();
    await expect(phoneDialog.getByRole('button', { name: '开启 Codex 会话' })).toBeEnabled();
    await phone.screenshot({ path: testInfo.outputPath('phone-projects.png'), scale: 'css', animations: 'disabled' });
    await phoneDialog.getByRole('button', { name: '取消' }).tap();
    await expect(phoneDialog).toBeHidden();

    await phone.getByRole('button', { name: '选择项目', exact: true }).tap();
    const projectPicker = phone.getByRole('dialog');
    await projectPicker.getByRole('button', { name: '测试电脑', exact: true }).tap();
    const pathInput = projectPicker.getByRole('textbox', { name: '电脑上的目录' });
    await expect(projectPicker.getByRole('button', { name: /^workspace/ })).toBeVisible({ timeout: 12_000 });
    await pathInput.fill(customPath);
    await projectPicker.getByRole('button', { name: '前往' }).tap();
    await expect(projectPicker.getByRole('alert')).toContainText('路径不在这台电脑允许的目录内', { timeout: 12_000 });
    await expect(projectPicker.getByRole('button', { name: '添加此目录' })).toBeDisabled();
    await shareFolders([root, sibling]);
    await projectPicker.getByRole('button', { name: '选择项目' }).tap();
    await projectPicker.getByRole('button', { name: '测试电脑', exact: true }).tap();
    await projectPicker.getByRole('button', { name: /^另一组项目,共享目录/ }).tap({ timeout: 12_000 });
    await projectPicker.getByRole('button', { name: '手机自选项目', exact: true }).tap();
    await expect(pathInput).toHaveValue(customPath);
    await phone.screenshot({ path: testInfo.outputPath('phone-folders.png'), scale: 'css', animations: 'disabled' });
    const trust = phone.getByRole('dialog', { name: '信任并添加项目？' });
    await projectPicker.getByRole('button', { name: '添加此目录' }).tap();
    await expect(trust).toContainText(customPath);
    expect(await e2eDatabase.harnessDirectory.count({ where: { nodeId, path: customPath } })).toBe(0);
    await trust.getByRole('button', { name: '取消' }).tap();
    await expect(trust).toBeHidden();
    await expect(pathInput).toHaveValue(customPath);
    await projectPicker.getByRole('button', { name: '添加此目录' }).tap();
    await trust.getByRole('button', { name: '信任并添加', exact: true }).tap();
    await expect(projectPicker).toBeHidden();
    await expect(phone.getByRole('button', { name: '选择项目', exact: true })).toContainText('手机自选项目');
    await phone.reload();
    await expect(phone.getByText('「手机自选项目」还没有 Codex 会话。')).toBeVisible();
    const savedId = new URLSearchParams(new URL(phone.url()).hash.split('?')[1]).get('project');
    for (const [path, expected] of [[customPath, savedId], [registeredPath, registered.location.id]]) {
      const chosen = await data<{ id: string }>(await request.post(apiUrl + '/directories/select', { data: { nodeId, path } }));
      expect(chosen.id).toBe(expected);
    }

    await page.goto(listUrl);
    const harness = page.getByRole('radiogroup', { name: 'Harness' });
    await expect(harness.getByRole('radio')).toHaveCount(1);
    await expect(harness.getByRole('radio', { name: 'Codex' })).toBeChecked();
    await page.getByRole('button', { name: '新建会话' }).click();
    const dialog = page.getByRole('dialog', { name: '新建会话' });
    const location = dialog.getByRole('radiogroup', { name: '本机项目' }).getByRole('radio', { name: /手机自选项目.*测试电脑/ });
    await location.focus();
    await location.press('Space');
    await expect(location).toBeChecked();
    await dialog.getByRole('button', { name: '开启 Codex 会话' }).click();
    await expect(page).toHaveURL(/sessionId=/);
    const sessionHash = new URL(page.url()).hash;
    const sessionId = new URLSearchParams(sessionHash.split('?')[1]).get('sessionId');
    expect(sessionId).toBeTruthy();
    const detail = async () => data<{ threadId: string | null; snapshot: HarnessSnapshot | null }>(await request.get(apiUrl + '/' + sessionId));
    await poll(async () => (await detail()).threadId, 'fixture-thread');
    expect((await readFile(join(folder, 'calls'), 'utf8')).split('\n')).toContain('cwd ' + customPath);
    const desktopChat = page.getByRole('region', { name: '会话详情' });
    await expect(desktopChat).toBeVisible();
    await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
    await desktopChat.getByRole('textbox', { name: '输入消息' }).fill('电脑发出的第一条消息');
    await desktopChat.getByRole('button', { name: '发送', exact: true }).click();
    await poll(async () => (await detail()).snapshot?.view.turn?.status, 'inProgress');
    await expect(desktopChat.getByText('streamed', { exact: true })).toBeVisible();

    await phone.reload();
    await phone.getByRole('button', { name: /电脑发出的第一条消息/ }).click();
    const phoneChat = phone.getByRole('region', { name: '会话详情' });
    await expect(phone).toHaveURL(/sessionId=/);
    const phoneHash = new URL(phone.url()).hash;
    expect(new URLSearchParams(phoneHash.split('?')[1]).get('sessionId')).toBe(sessionId);
    await phone.goBack();
    await expect(phone.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
    await phone.goForward();
    await expect(phone).toHaveURL(/sessionId=/);
    await expect(phone.getByRole('heading', { name: '会话', exact: true })).toBeHidden();
    await expect(phone.locator('.mobile-global-assistant')).toHaveCount(0);
    await expect(phoneChat.getByText('streamed', { exact: true })).toBeVisible();
    const input = phoneChat.getByRole('textbox', { name: '输入消息' });
    const steerText = 'stream another chunk';
    await input.fill(steerText);
    await phoneChat.getByRole('button', { name: '追加到当前轮' }).click();
    await poll(async () => (await detail()).snapshot?.view.messages.some((message) => message.text === steerText), true);
    await expect(desktopChat.getByText(steerText, { exact: true })).toBeVisible();
    const reply = phoneChat.locator('[data-role=assistant] .markdown-body').last();
    await expect(reply).toHaveText('streamed 新增正文');
    await expect(reply.locator('.markdown-arrival')).toHaveText(['新', '增', '正', '文']);
    await phone.reload();
    await expect(phoneChat.getByRole('button', { name: '打断当前轮' })).toBeEnabled();
    await expect(reply).toHaveText('streamed 新增正文');
    await expect(reply.locator('.markdown-arrival')).toHaveCount(0);
    await phoneChat.getByRole('button', { name: '打断当前轮' }).click();
    await poll(async () => (await detail()).snapshot?.view.turn?.status, 'interrupted');

    await input.fill('permission');
    await phoneChat.getByRole('button', { name: '发送', exact: true }).click();
    await poll(async () => (await detail()).snapshot?.view.approvals.length, 1);
    const approval = phoneChat.getByRole('region', { name: 'Codex 请求执行命令' });
    await expect(approval.getByText('printf fixture', { exact: true })).toBeVisible();
    await approval.getByRole('button', { name: '允许一次' }).click();
    await poll(async () => (await detail()).snapshot?.view.approvals.length, 0);
    await expect(desktopChat.getByRole('region', { name: 'Codex 请求执行命令' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /电脑发出的第一条消息/ })).not.toContainText('待确认');

    await input.fill('刷新后保留的草稿');
    const stream = /\/api\/v1\/harness-sessions\/[^/]+\/events(?:\?|$)/;
    await phone.route(stream, (route) => route.abort());
    await phone.reload();
    await expect(input).toHaveValue('刷新后保留的草稿');
    await expect(phoneChat.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    await phone.unroute(stream);
    await phone.reload();
    await expect(input).toHaveValue('刷新后保留的草稿');
    await expect(phoneChat.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    expect((await detail()).threadId).toBe('fixture-thread');
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await phone.evaluate(() => innerWidth));
    await phone.screenshot({ path: testInfo.outputPath('phone-chat.png'), scale: 'css', animations: 'disabled' });
    await phoneChat.getByRole('button', { name: '返回会话列表' }).click();
    await expect(phone.getByRole('button', { name: /电脑发出的第一条消息/ })).toBeVisible();
    await expect(desktopChat.getByText('Codex 已受理', { exact: true })).toBeVisible();
    await phone.screenshot({ path: testInfo.outputPath('phone-list.png'), scale: 'css', animations: 'disabled' });
    await page.screenshot({ path: testInfo.outputPath('desktop.png'), scale: 'css', animations: 'disabled' });
    await phone.getByRole('button', { name: '新建会话' }).tap();
    await expect(phoneDialog.getByRole('button', { name: '开启 Codex 会话' })).toBeEnabled();
    await phoneDialog.getByRole('button', { name: '取消' }).tap();
    await phone.getByRole('button', { name: /电脑发出的第一条消息.*测试电脑/ }).tap();
    await expect(phoneChat).toBeVisible();
    expect(new URL(phone.url()).hash).toBe(phoneHash);
    await phoneChat.getByRole('button', { name: '选择项目，当前为 手机自选项目' }).tap();
    await projectPicker.getByRole('button', { name: /^会话测试项目.*测试电脑/ }).tap();
    await expect(phoneChat).toBeHidden();
    await expect(phone.getByText('「会话测试项目」还没有 Codex 会话。')).toBeVisible();
    await phone.getByRole('button', { name: '选择项目', exact: true }).tap();
    await projectPicker.getByRole('button', { name: /^手机自选项目.*测试电脑/ }).tap();
    await phone.getByRole('button', { name: /电脑发出的第一条消息/ }).tap();
    await expect(input).toHaveValue('刷新后保留的草稿');
    expect(new URL(phone.url()).hash).toBe(phoneHash);
    const listed = await data<{ sessions: Array<{ id: string; nodeId: string }> }>(await request.get(apiUrl));
    expect(listed.sessions.filter((session) => session.nodeId === nodeId).map((session) => session.id)).toEqual([sessionId]);

    await input.fill('画一张 SVG 测试图');
    await phoneChat.getByRole('button', { name: '发送', exact: true }).tap();
    const diagram = phoneChat.locator('[data-harness-turn]').filter({ hasText: '画一张 SVG 测试图' });
    const activity = diagram.locator('[data-harness-process]');
    const output = diagram.getByLabel('命令输出');
    const command = diagram.locator('[data-harness-tool]').first();
    await expect(output).toHaveText('正在画框');
    await expect(command.locator('[data-tool-status]')).toHaveText('执行中');
    await writeFile(join(folder, 'diagram-next'), '');
    await expect(output).toContainText('连线已写入');
    await expect(command.locator('[data-tool-status]')).toHaveText('执行中');
    expect(await command.locator('summary').evaluate((element) =>
      element.getBoundingClientRect().right <= element.closest('[data-chat-scroll]')!.getBoundingClientRect().right)).toBe(true);
    await expect(diagram.locator('.harness-turn-byline')).toHaveCount(1);
    await phone.screenshot({ path: testInfo.outputPath('phone-command-stream.png'), scale: 'css' });
    await writeFile(join(folder, 'diagram-finish'), '');
    await expect(diagram.getByText('画好了。', { exact: false })).toBeVisible();
    await expect(diagram).not.toContainText('visualize');
    await writeFile(join(folder, 'diagram-reply'), '');
    await expect(activity).not.toHaveAttribute('open', '');
    const inline = diagram.locator('[data-svg-block]').first();
    await expect(inline.locator('img')).toBeVisible();
    await expect.poll(() => inline.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    await expect(diagram).not.toContainText('architecture.html');
    await expect(inline.getByRole('alert')).toHaveCount(0);
    const artifact = diagram.locator('[data-harness-artifact]');
    await expect(artifact).toContainText('architecture.svg');
    await artifact.locator('summary').tap();
    await expect(artifact.locator('[data-svg-block] img')).toBeVisible();
    await phone.screenshot({ path: testInfo.outputPath('phone-svg-artifact.png'), scale: 'css' });
    await phone.reload();
    await expect(diagram.locator('.harness-turn-byline')).toHaveCount(1);
    await expect(inline.locator('img')).toBeVisible();
    await expect(diagram).not.toContainText('visualize');
    await expect(artifact).toHaveCount(1);
    await activity.locator(':scope > summary').tap();
    await command.locator('summary').tap();
    await expect(output).toContainText('连线已写入');
    await expect(command.getByText('退出码 0')).toBeVisible();
    await expect(diagram.locator('[data-harness-tool]')).toHaveCount(2);
    const legacy = await data<{ snapshot: { view: { messages: Array<{ text: string }> } } }>(await request.get(`${apiUrl}/${sessionId}`));
    expect(legacy.snapshot.view.messages.some((message) => message.text.includes('画好了。'))).toBe(true);
    expect(legacy.snapshot.view).not.toHaveProperty('tools');
    expect(legacy.snapshot.view).not.toHaveProperty('artifacts');
    expect((await detail()).threadId).toBe('fixture-thread');

    await shareFolders([root]);
    const restricted = await request.post(apiUrl + '/directories/browse', { data: { nodeId, path: customPath } });
    expect(restricted.status()).toBe(409);
    expect((await restricted.json()).error).toContain('路径不在这台电脑允许的目录内');
    await input.fill('停止共享后的新消息');
    await phoneChat.getByRole('button', { name: '发送', exact: true }).tap();
    await expect(phoneChat.getByText(/操作已拒绝.*路径不在这台电脑允许的目录内/)).toBeVisible({ timeout: 12_000 });
  } finally {
    if (agent && agent.exitCode === null && agent.signalCode === null) {
      const exited = once(agent, 'exit');
      agent.kill('SIGTERM');
      await exited;
    }
    if (nodeId) {
      await e2eDatabase.harnessSession.deleteMany({ where: { nodeId } });
      await e2eDatabase.harnessDirectory.deleteMany({ where: { nodeId } });
    }
    await rm(folder, { recursive: true, force: true });
    await phoneContext.close();
  }
});

test('opens saved Codex history and keeps multiple chats in the same project independent', async ({ browser, page, request, baseURL, extraHTTPHeaders }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The test opens a phone viewport itself.');
  test.setTimeout(120_000);
  await resetE2eDatabase();
  const folder = await mkdtemp(join(tmpdir(), 'dovun-codex-library-'));
  const phoneContext = await browser.newContext({ ...devices['iPhone 13'], baseURL, extraHTTPHeaders, locale: 'zh-CN',
    storageState: await page.context().storageState() });
  let agent: ChildProcess | undefined;
  let nodeId: string | undefined;
  try {
    const root = await realpath(folder);
    const repo = join(root, 'repo'), sibling = join(root, 'other-project'), library = join(root, 'codex-history');
    await Promise.all([mkdir(repo), mkdir(sibling), mkdir(library)]);
    execFileSync('git', ['init', '--quiet', repo]);
    const nativeId = 'codex-desktop-history';
    const turnCount = 36;
    const turns = Array.from({ length: turnCount }, (_, index) => ({
      id: `turn-${index + 1}`, status: 'completed', items: [
        { type: 'userMessage', id: `native-question-${index}`, content: [{ type: 'text', text: `历史问题 ${index + 1}` }] },
        { type: 'agentMessage', id: `native-answer-${index}`, phase: 'final_answer', text: `历史回答 ${index + 1}` },
      ],
    }));
    const updatedAt = Math.floor(Date.now() / 1000);
    await writeFile(join(library, `${nativeId}.json`), JSON.stringify({
      thread: { id: nativeId, cwd: repo, name: 'Mac 上的原 Codex 对话', updatedAt, modelProvider: 'original-codex' }, turns,
    }));
    await writeFile(join(library, 'other-thread.json'), JSON.stringify({
      thread: { id: 'other-thread', cwd: sibling, name: '另一个项目的私有对话', updatedAt }, turns,
    }));
    const node = await data<{ node: { id: string }; token: string }>(await request.post('/api/nodes', { data: { name: '历史测试 Mac' } }));
    nodeId = node.node.id;
    const startAgent = () => spawn(process.execPath, ['--import', 'tsx', resolve('server/src/node-agent/index.ts'), '--server', process.env.E2E_API_URL!,
      '--roots', root, '--data', join(root, 'node')], { stdio: 'ignore', env: {
      ...process.env, CODEX_HOME: join(root, 'codex-home'), DOVUN_NODE_TOKEN: node.token, DOVUN_CODEX_BIN: resolve('server/test/stub-harness-codex.mjs'),
      DOVUN_CLAUDE_BIN: resolve('server/test/stub-harness-claude.mjs'), CLAUDE_CONFIG_DIR: join(root, 'claude-home'),
      HARNESS_TEST_LIBRARY: library, HARNESS_TEST_CALLS: join(root, 'calls'), HARNESS_TEST_HISTORY: join(root, 'unused.json'),
      HARNESS_TEST_TURNS: join(root, 'turns'),
    } });
    agent = startAgent();
    await expect.poll(async () => (await data<{ nodes: Array<{ id: string; harnessLibrary?: boolean }> }>(await request.get(apiUrl)))
      .nodes.find((entry) => entry.id === node.node.id)?.harnessLibrary, { timeout: 15_000 }).toBe(true);
    const location = await data<{ id: string }>(await request.post(apiUrl + '/directories/select', { data: { nodeId: node.node.id, path: repo } }));
    const projectUrl = `${listUrl}&project=${location.id}`;
    const phone = await phoneContext.newPage();
    await phone.goto(listUrl);
    await expect(phone.getByRole('heading', { name: /^repo/ })).toBeVisible({ timeout: 12_000 });
    await expect(phone.getByRole('button', { name: /Mac 上的原 Codex 对话/ })).toBeVisible();
    await phone.goto(projectUrl);
    const original = phone.getByRole('button', { name: /Mac 上的原 Codex 对话/ });
    await expect(original).toBeVisible({ timeout: 12_000 });
    await expect(phone.getByText('另一个项目的私有对话')).toHaveCount(0);
    expect((await request.post(apiUrl + '/native/open', { data: { nodeId: node.node.id, locationId: location.id, threadId: 'other-thread' } })).status()).toBe(409);
    const nativeSelection = { nodeId, locationId: location.id, threadId: nativeId };
    const [, simultaneous] = await Promise.all([
      original.tap(),
      request.post(apiUrl + '/native/open', { data: nativeSelection }).then(data<{ sessionId: string }>),
    ]);
    const chat = phone.getByRole('region', { name: '会话详情' });
    const ready = () => expect(chat.locator('header [role=status]')).toHaveText('已连接', { timeout: 15_000 });
    const back = () => chat.getByRole('button', { name: '返回会话列表' }).tap();
    const sessionId = () => new URLSearchParams(new URL(phone.url()).hash.split('?')[1]).get('sessionId')!;
    const details = (id: string) => request.get(`${apiUrl}/${id}?timeline=1`).then((response) => data<{ threadId: string }>(response));
    const fullDetail = async (id: string) => (await data<{ snapshot: HarnessSnapshot }>(
      await request.get(`${apiUrl}/${id}?timeline=1&settings=1`))).snapshot;
    const toggleSettings = () => chat.getByRole('button', { name: '会话设置' }).tap();
    const panel = phone.getByRole('dialog', { name: '会话设置' });
    const option = (name: string) => panel.getByRole('radio', { name, exact: true });
    const select = async (name: string) => {
      const item = panel.getByRole('radio', { name: new RegExp('^' + name) });
      await item.tap();
      await expect(item).toBeChecked({ timeout: 12_000 });
    };
    const closeSettings = () => panel.getByRole('button', { name: 'Close' }).tap();
    const appliedTurns = async () => (await readFile(join(root, 'turns'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const send = async (text: string) => {
      await chat.getByRole('textbox', { name: '输入消息' }).fill(text);
      await chat.getByRole('button', { name: '发送', exact: true }).tap();
    };
    await ready();
    const originalSessionId = sessionId();
    expect(originalSessionId).toBe(simultaneous.sessionId);
    expect((await details(originalSessionId)).threadId).toBe(nativeId);
    await expect(chat.getByText('历史回答 36', { exact: true })).toBeVisible();
    await expect(chat.getByText('历史回答 1', { exact: true })).toHaveCount(0);
    const scroller = chat.locator('[data-chat-scroll]');
    await expect(chat.getByRole('button', { name: '加载更早的消息' })).toBeAttached({ timeout: 12_000 });
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    await expect(chat.getByText('历史回答 13', { exact: true })).toBeAttached({ timeout: 12_000 });
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    await expect(chat.getByText('历史回答 1', { exact: true })).toBeAttached({ timeout: 12_000 });
    await expect(chat.locator('[data-harness-turn]')).toHaveCount(turnCount);
    const beforeSettings = await fullDetail(originalSessionId);
    const legacyView = await data<{ snapshot: HarnessSnapshot }>(await request.get(`${apiUrl}/${originalSessionId}?timeline=1`));
    expect(legacyView.snapshot.view.settings).toBeUndefined();
    await phone.addInitScript(({ id, snapshot }) => {
      const key = `dovun-harness-timeline:${id}`;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, 'legacy-cache-seeded');
      localStorage.setItem(key, JSON.stringify(snapshot));
    }, { id: originalSessionId, snapshot: legacyView.snapshot });
    await phone.reload();
    await ready();
    await toggleSettings();
    await expect(option('常规模型')).toBeChecked();
    await select('精细模型');
    await expect(option('低')).toBeChecked();
    await select('高');
    await select('计划模式');
    await closeSettings();
    const stale = await request.post(`${apiUrl}/${originalSessionId}/commands`, { data: {
      operation: 'configure', commandId: crypto.randomUUID(), expectedEpoch: beforeSettings.epoch,
      expectedSettingsRevision: beforeSettings.view.settings!.revision, changes: { model: 'fixture-default' },
    } });
    expect(stale.status()).toBe(409);
    await send('完成测试：从手机继续旧会话');
    await expect(chat.getByText('完成测试：从手机继续旧会话 已回复', { exact: true })).toBeVisible({ timeout: 12_000 });
    expect((await details(originalSessionId)).threadId).toBe(nativeId);
    expect((await appliedTurns()).at(-1)).toMatchObject({
      threadId: nativeId, provider: 'original-codex', model: 'fixture-precise', effort: 'high',
      collaborationMode: { mode: 'plan', settings: { model: 'fixture-precise', reasoning_effort: 'high' } },
      approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' },
    });
    const calls = await readFile(join(root, 'calls'), 'utf8');
    expect(calls).toContain(`resume ${nativeId}`);
    expect(calls).not.toContain('thread/start');
    const openedAgain = await data<{ sessionId: string }>(await request.post(apiUrl + '/native/open', { data: nativeSelection }));
    expect(openedAgain.sessionId).toBe(originalSessionId);
    await back();
    await expect(original).toHaveCount(1);

    async function newChat() {
      await phone.getByRole('button', { name: '新建会话' }).tap();
      await phone.getByRole('dialog', { name: '新建会话' }).getByRole('button', { name: '开启 Codex 会话' }).tap();
      await ready();
      return sessionId();
    }
    const first = await newChat();
    await send('第一条新对话仍在运行');
    await expect(chat.getByText('streamed', { exact: true })).toBeVisible({ timeout: 12_000 });
    await toggleSettings();
    await select('精细模型');
    await select('只读');
    await closeSettings();
    expect((await appliedTurns()).at(-1)).toMatchObject({ model: 'fixture-default', sandboxPolicy: { type: 'workspaceWrite' } });
    await back();
    const second = await newChat();
    await toggleSettings();
    await expect(option('常规模型')).toBeChecked();
    await expect(option('中')).toBeChecked();
    await closeSettings();
    await send('完成测试：第二条独立对话');
    await expect(chat.getByText('完成测试：第二条独立对话 已回复', { exact: true })).toBeVisible({ timeout: 12_000 });
    await expect(chat.getByText('第一条新对话仍在运行', { exact: true })).toHaveCount(0);
    expect(new Set([nativeId, (await details(first)).threadId, (await details(second)).threadId]).size).toBe(3);
    await back();
    await phone.getByRole('button', { name: /第一条新对话仍在运行/ }).tap();
    expect(sessionId()).toBe(first);
    await expect(chat.getByText('streamed', { exact: true })).toBeVisible();
    await expect(chat.getByText('完成测试：第二条独立对话 已回复', { exact: true })).toHaveCount(0);
    await chat.getByRole('button', { name: '打断当前轮', exact: true }).tap();
    await send('完成测试：使用第一条会话的新设置');
    await expect(chat.getByText('完成测试：使用第一条会话的新设置 已回复', { exact: true })).toBeVisible({ timeout: 12_000 });
    expect((await appliedTurns()).at(-1)).toMatchObject({
      threadId: (await details(first)).threadId, model: 'fixture-precise', effort: 'low',
      collaborationMode: { mode: 'default' }, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' },
    });

    const originalEpoch = (await fullDetail(originalSessionId)).epoch;
    const exited = once(agent, 'exit');
    agent.kill('SIGTERM');
    await exited;
    agent = startAgent();
    await phone.goto(`${projectUrl}&sessionId=${originalSessionId}`);
    await expect.poll(async () => (await fullDetail(originalSessionId)).epoch, { timeout: 15_000 }).toBeGreaterThan(originalEpoch);
    await ready();
    await toggleSettings();
    await expect(option('精细模型')).toBeChecked();
    await expect(option('高')).toBeChecked();
    await expect(panel.getByRole('radio', { name: /^计划模式/ })).toBeChecked();
    await closeSettings();
    await back();
    const harnesses = phone.getByRole('radiogroup', { name: 'Harness' });
    await harnesses.getByRole('radio', { name: 'Claude Code', exact: true }).tap();
    await phone.getByRole('button', { name: '新建会话' }).tap();
    await phone.getByRole('dialog', { name: '新建会话' }).getByRole('button', { name: '开启 Claude Code 会话' }).tap();
    await ready();
    const claude = sessionId();
    await send('同一个项目的 Claude 对话');
    await expect(chat.getByText('同一个项目的 Claude 对话 · Claude 已回复', { exact: true })).toBeVisible({ timeout: 12_000 });
    expect((await details(claude)).threadId).not.toBe(nativeId);
    await back();
    await expect(phone.getByRole('button', { name: /Mac 上的原 Codex 对话/ })).toHaveCount(0);
  } finally {
    if (agent && agent.exitCode === null && agent.signalCode === null) {
      const exited = once(agent, 'exit');
      agent.kill('SIGTERM');
      await exited;
    }
    if (nodeId) {
      await e2eDatabase.harnessSession.deleteMany({ where: { nodeId } });
      await e2eDatabase.harnessDirectory.deleteMany({ where: { nodeId } });
    }
    await phoneContext.close();
    await rm(folder, { recursive: true, force: true });
  }
});
