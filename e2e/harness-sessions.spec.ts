import { test, expect, devices, type APIResponse } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HarnessSnapshot } from '../server/src/node-agent/harness-protocol.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const listUrl = '/#/runs?tab=sessions';
const apiUrl = '/api/v1/harness-sessions';

async function data<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as T;
}

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
    const customPath = join(root, '手机自选项目');
    await mkdir(customPath);
    const node = await data<{ node: { id: string }; token: string }>(await request.post('/api/nodes', { data: { name: '测试电脑' } }));
    nodeId = node.node.id;
    const project = await data<{ id: string }>(await request.post('/api/projects', { data: { name: '会话测试项目', defaultParallel: 1 } }));
    const registeredPath = await realpath(repo);
    const registered = await data<{ location: { id: string } }>(await request.post('/api/projects/' + project.id + '/locations', { data: { nodeId: node.node.id, path: registeredPath } }));
    agent = spawn(process.execPath, ['--import', 'tsx', resolve('server/src/node-agent/index.ts'), '--server', process.env.E2E_API_URL!,
      '--roots', root, '--data', join(folder, 'node'), '--max', '1'], {
      stdio: 'ignore',
      env: {
        ...process.env, DOVUN_NODE_TOKEN: node.token, DOVUN_NODE_MANAGED: 'cli',
        DOVUN_CODEX_BIN: resolve('server/test/stub-harness-codex.mjs'),
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
    await projectPicker.getByRole('button', { name: /^workspace.*\/workspace$/ }).tap();
    await projectPicker.getByRole('button', { name: '手机自选项目', exact: true }).tap();
    await expect(projectPicker.getByRole('textbox', { name: '电脑上的目录' })).toHaveValue(customPath);
    await phone.screenshot({ path: testInfo.outputPath('phone-folders.png'), scale: 'css', animations: 'disabled' });
    await projectPicker.getByRole('button', { name: '使用此目录' }).tap();
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
    await expect(phoneDialog.getByRole('button', { name: '开启 Codex 会话' })).toHaveCount(0);
    await phoneDialog.getByRole('button', { name: /电脑发出的第一条消息.*测试电脑/ }).tap();
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
    const listed = await data<{ sessions: Array<{ id: string }> }>(await request.get(apiUrl));
    expect(listed.sessions.map((session) => session.id)).toEqual([sessionId]);

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
    await expect(activity).not.toHaveAttribute('open', '');
    const artifact = diagram.locator('[data-harness-artifact]');
    await expect(artifact).toContainText('architecture.svg');
    await artifact.locator('summary').tap();
    await expect(artifact.locator('[data-svg-block] img')).toBeVisible();
    await phone.screenshot({ path: testInfo.outputPath('phone-svg-artifact.png'), scale: 'css' });
    await phone.reload();
    await expect(diagram.locator('.harness-turn-byline')).toHaveCount(1);
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
