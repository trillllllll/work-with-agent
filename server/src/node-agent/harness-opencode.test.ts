import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { CodexRejected, type HarnessNotification } from './harness-codex.js';
import { openCodeRequest, resolveOpenCodeService } from './harness-opencode-client.js';
import { OpenCodeHarnessRuntime } from './harness-opencode.js';
import { readOpenCodeTurns } from './harness-opencode-library.js';
import { changeCodexSelection, readCodexSelection, readOpenCodeSettings } from './harness-settings.js';

type Recorded = { method: string; params: Record<string, unknown>; id?: string };

let service: ChildProcess | null = null;
let cwd = '';
let notifications: Recorded[] = [];

const until = async (check: () => boolean, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待 OpenCode stub 事件超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

async function startService(extra: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dovun-opencode-test-'));
  await mkdir(join(directory, 'project'));
  // The temp root lives behind the /var symlink; the runtime compares canonical paths.
  cwd = await realpath(join(directory, 'project'));
  service = spawn(process.execPath,
    [fileURLToPath(new URL('../../test/stub-opencode-service.mjs', import.meta.url)), '--port=0'], {
      env: { ...process.env, HARNESS_TEST_OPENCODE_STORE: join(directory, 'store.json'), ...extra },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  const port = await new Promise<number>((resolve) => {
    service!.stdout!.on('data', (chunk) => {
      const match = /"port":(\d+)/.exec(String(chunk));
      if (match) resolve(Number(match[1]));
    });
  });
  process.env.OPENCODE_SERVICE_URL = `http://127.0.0.1:${port}`;
  delete process.env.OPENCODE_PASSWORD;
  return directory;
}

function runtime(onExit = () => undefined) {
  notifications = [];
  const notify: HarnessNotification = (method, params, id) => {
    notifications.push({ method, params, id: id === undefined ? undefined : String(id) });
  };
  return new OpenCodeHarnessRuntime(cwd, notify, onExit);
}

const methods = (name: string) => notifications.filter((entry) => entry.method === name);
const find = (name: string) => methods(name).at(-1);
const itemOf = (entry: Recorded | undefined) => entry?.params.item as Record<string, unknown> | undefined;
const started = async (app: OpenCodeHarnessRuntime) => {
  const result = await app.request('thread/start', { cwd });
  return (result.thread as Record<string, unknown>).id as string;
};

afterEach(async () => {
  delete process.env.OPENCODE_SERVICE_URL;
  service?.kill();
  await new Promise((resolve) => setTimeout(resolve, 50));
});

it('starts a session, streams the answer and completes the turn through the shared service', async () => {
  await startService();
  const app = runtime();
  const threadId = await started(app);
  expect(threadId).toMatch(/^ses_test_/);
  await app.request('model/list', {});
  const sent = await app.request('turn/start', {
    threadId, clientUserMessageId: 'cmd-first', input: [{ type: 'text', text: '你好' }],
  });
  expect(sent).toEqual({ turn: { id: 'cmd-first', status: 'inProgress' } });
  await until(() => Boolean(find('turn/completed')?.params.turn));
  expect(methods('turn/started')).toHaveLength(1);
  const user = methods('item/completed').map((entry) => itemOf(entry)).find((item) => item?.type === 'userMessage');
  expect(user).toMatchObject({ id: 'cmd-first', clientId: 'cmd-first', type: 'userMessage' });
  expect(find('item/agentMessage/delta')?.params.delta).toBe('OpenCode stub 记得 你好');
  expect(methods('item/agentMessage/delta')).toHaveLength(1);
  expect(find('turn/completed')?.params.turn).toEqual({ id: 'cmd-first', status: 'completed' });
  const page = await app.request('thread/turns/list', { threadId, limit: 20 });
  expect(page.data).toMatchObject([{ id: 'cmd-first', status: 'completed' }]);
  await app.close();
});

it('refuses to resume or continue a missing original session', async () => {
  await startService();
  const app = runtime();
  await expect(app.request('thread/resume', { threadId: 'ses_missing' })).rejects.toThrow('找不到 OpenCode 原会话，无法恢复');
  await expect(app.request('thread/fork', { threadId: 'x' })).rejects.toThrow(CodexRejected);
  await expect(app.request('turn/start', { threadId: 'ses_missing', clientUserMessageId: 'cmd-x',
    input: [{ type: 'text', text: 'x' }] })).rejects.toThrow('找不到 OpenCode 原会话，无法恢复');
  await app.close();
});

it('rejects a second send while the turn runs and reports an interrupted turn', async () => {
  await startService({ HARNESS_TEST_OPENCODE_ASK: '1', HARNESS_TEST_OPENCODE_HOLD: '1' });
  const app = runtime();
  const threadId = await started(app);
  await app.request('turn/start', { threadId, clientUserMessageId: 'cmd-hold',
    input: [{ type: 'text', text: '慢一点' }] });
  const approval = await until(() => Boolean(find('item/commandExecution/requestApproval')), 15_000).then(() =>
    find('item/commandExecution/requestApproval'));
  await app.reply(approval!.id!, { decision: 'accept' });
  await until(() => methods('item/started').some((entry) => itemOf(entry)?.type === 'commandExecution'));
  await expect(app.request('turn/start', { threadId, clientUserMessageId: 'cmd-second',
    input: [{ type: 'text', text: '第二条' }] })).rejects.toThrow('当前轮仍在运行');
  await app.request('turn/interrupt', { threadId, turnId: 'cmd-hold' });
  await until(() => Boolean(find('turn/completed')?.params.turn));
  expect(find('turn/completed')?.params.turn).toEqual({ id: 'cmd-hold', status: 'interrupted' });
  await app.close();
});

it('maps shell approvals to command decisions and resolves after replying', async () => {
  await startService({ HARNESS_TEST_OPENCODE_ASK: '1' });
  const app = runtime();
  const threadId = await started(app);
  await app.request('turn/start', { threadId, clientUserMessageId: 'cmd-ask',
    input: [{ type: 'text', text: '运行命令' }] });
  const approval = await until(() => Boolean(find('item/commandExecution/requestApproval')), 15_000).then(() =>
    find('item/commandExecution/requestApproval'));
  expect(approval?.params).toMatchObject({
    turnId: 'cmd-ask', command: 'printf hello', availableDecisions: ['accept', 'decline'], projectApproval: true,
  });
  await expect(app.reply(approval!.id!, { decision: 'acceptForSession' })).rejects.toThrow('决定无效');
  await app.reply(approval!.id!, { decision: 'accept' });
  await until(() => Boolean(find('turn/completed')?.params.turn));
  expect(notifications.some((entry) => entry.method === 'serverRequest/resolved'
    && entry.params.requestId === approval!.id)).toBe(true);
  const tool = methods('item/completed').map((entry) => itemOf(entry))
    .find((item) => item?.type === 'commandExecution');
  expect(tool).toMatchObject({ type: 'commandExecution', command: 'printf hello',
    aggregatedOutput: 'once：hello', exitCode: 0, status: 'completed' });
  await app.close();
});

it('only offers native OpenCode settings and drops settings saved by older Dovun versions', async () => {
  await startService();
  const app = runtime();
  const result = await app.request('thread/start', { cwd });
  const settings = await readOpenCodeSettings(app, { ...readCodexSelection(result)!, permission: 'readOnly', approvalPolicy: 'never' });
  expect(settings).toMatchObject({ permission: 'workspace', sandboxChoices: [], planAvailable: true });
  expect(settings).not.toHaveProperty('approvalPolicy');
  expect(settings).not.toHaveProperty('approvalPolicies');
  expect(() => changeCodexSelection(settings, { permission: 'readOnly' })).toThrow(CodexRejected);
  expect(() => changeCodexSelection(settings, { approvalPolicy: 'never' })).toThrow(CodexRejected);
  expect(changeCodexSelection(settings, { mode: 'plan' }).mode).toBe('plan');
  await app.close();
});

it('reattaches to the native running turn and recovers a pending approval before interrupting', async () => {
  await startService({ HARNESS_TEST_OPENCODE_ASK: '1' });
  const original = runtime();
  const threadId = await started(original);
  await original.close();
  const service = await resolveOpenCodeService();
  await openCodeRequest(service, 'POST', `/api/session/${threadId}/prompt`, { id: 'msg_native-turn', text: 'Mac starts first' });

  const attached = runtime();
  await attached.request('thread/resume', { threadId });
  const page = await attached.request('thread/turns/list', { threadId, limit: 20 });
  expect(page.data).toMatchObject([{ id: 'native-turn', status: 'inProgress' }]);
  expect(find('item/commandExecution/requestApproval')?.params).toMatchObject({ turnId: 'native-turn', projectApproval: true });
  await attached.request('turn/interrupt', { threadId, turnId: 'native-turn' });
  await until(() => find('turn/completed')?.params.turn !== undefined);
  expect(find('turn/completed')?.params.turn).toEqual({ id: 'native-turn', status: 'interrupted' });
  await attached.close();
});

it('reopens the accepted native prompt by its original id when its HTTP response is lost', async () => {
  await startService({ HARNESS_TEST_OPENCODE_DROP: '1' });
  let disconnected = false;
  const app = runtime(() => { disconnected = true; });
  const threadId = await started(app);
  const failed = await app.request('turn/start', {
    threadId, clientUserMessageId: 'response-lost', input: [{ type: 'text', text: 'only once' }],
  }).catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(Error);
  expect(failed).not.toBeInstanceOf(CodexRejected);
  expect(disconnected).toBe(true);
  const restored = runtime();
  await restored.request('thread/resume', { threadId });
  const page = await restored.request('thread/turns/list', { threadId, limit: 20 });
  expect(page.data).toMatchObject([{ id: 'response-lost', status: 'completed',
    items: [expect.objectContaining({ type: 'userMessage', clientId: 'response-lost' }), expect.any(Object)] }]);
  await restored.close();
});

it('maps the effort choice to a model variant and keeps the base model on resume', async () => {
  await startService();
  const app = runtime();
  const result = await app.request('thread/start', { cwd });
  const threadId = (result.thread as Record<string, unknown>).id as string;
  const settings = await readOpenCodeSettings(app, readCodexSelection(result)!);
  expect(settings.models.find((model) => model.id === 'opencode/stub-model'))
    .toMatchObject({ defaultEffort: null, efforts: ['low', 'high'] });
  expect(settings.models.find((model) => model.id === 'opencode/stub-plain')).toMatchObject({ efforts: [] });
  const changed = changeCodexSelection(settings, { effort: 'high' });
  expect(changed.effort).toBe('high');
  expect(() => changeCodexSelection(settings, { effort: 'max' })).toThrow('这个模型不支持所选思考档位');
  await app.request('turn/start', { threadId, clientUserMessageId: 'cmd-effort',
    model: changed.model, effort: changed.effort, input: [{ type: 'text', text: '深度思考' }] });
  await until(() => Boolean(find('turn/completed')?.params.turn));
  const svc = await resolveOpenCodeService();
  const stored = await openCodeRequest<{ data?: { model?: Record<string, unknown> } }>(svc, 'GET', `/api/session/${threadId}`);
  expect(stored.data?.model).toMatchObject({ id: 'stub-model#high', providerID: 'opencode' });
  await app.close();
  const resumed = runtime();
  await expect(resumed.request('thread/resume', { threadId })).resolves.toMatchObject({ model: 'opencode/stub-model' });
  await resumed.close();
});

it('delivers a repeated command id only once and converts paged history at turn boundaries', async () => {
  const directory = await startService();
  const store = join(directory, 'store.json');
  const seed = {
    counters: { session: 2 },
    sessions: [{ id: 'ses_test_seed', title: 'Seed conversation', agent: 'build', outcome: 'succeeded', running: false,
      model: { id: 'stub-model', providerID: 'opencode' }, location: { directory: cwd }, permissions: [],
      time: { created: 1, updated: 3 }, messages: [
        { id: 'user-old', type: 'user', text: '更早的消息', time: { created: 1 } },
        { id: 'assistant-old', type: 'assistant', content: [{ type: 'text', text: '更早的回复' }], time: { created: 2 } },
        { id: 'idle-old', type: 'idle', outcome: 'interrupted', time: { created: 2 } },
        { id: 'user-new', type: 'user', text: '最新的消息', time: { created: 3 } },
        { id: 'assistant-new', type: 'assistant', content: [{ type: 'text', text: '最新的回复' },
          { type: 'tool', id: 'call_seed', name: 'shell', executed: true,
            state: { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'file' }], metadata: { exit: 0 } } }],
          time: { created: 3 } },
        { id: 'idle-new', type: 'idle', outcome: 'succeeded', time: { created: 3 } },
      ] }],
  };
  await writeFile(store, JSON.stringify(seed));
  const app = runtime();
  const svc = await resolveOpenCodeService();
  await expect(app.request('thread/resume', { threadId: 'ses_test_seed' })).resolves.toMatchObject({
    model: 'opencode/stub-model', collaborationMode: { mode: 'default' } });
  const first = await readOpenCodeTurns(svc, 'ses_test_seed', null, 1, false);
  expect(first.data).toMatchObject([{ id: 'user-new', status: 'completed' }]);
  expect(first.data[0].items.map((item) => (item as Record<string, unknown>).type))
    .toEqual(['userMessage', 'agentMessage', 'commandExecution']);
  expect(first.nextCursor).toBe('user-new');
  const second = await readOpenCodeTurns(svc, 'ses_test_seed', first.nextCursor, 5, false);
  expect(second.data).toMatchObject([{ id: 'user-old', status: 'interrupted' }]);
  expect(second.nextCursor).toBeNull();
  const restored = await app.request('thread/turns/list', { threadId: 'ses_test_seed', limit: 20 });
  expect(restored.data).toHaveLength(2);
  await app.close();
  // A replayed command id reaches the service only once, so history keeps a single user message.
  const sender = runtime();
  await sender.request('thread/resume', { threadId: 'ses_test_seed' });
  await sender.request('turn/start', { threadId: 'ses_test_seed', clientUserMessageId: 'cmd-replay',
    input: [{ type: 'text', text: '重发' }] });
  await until(() => Boolean(find('turn/completed')?.params.turn), 4_000);
  await sender.close();
  const replay = runtime();
  await replay.request('thread/resume', { threadId: 'ses_test_seed' });
  await replay.request('turn/start', { threadId: 'ses_test_seed', clientUserMessageId: 'cmd-replay',
    input: [{ type: 'text', text: '重发' }] });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await replay.close();
  const state = JSON.parse(await readFile(store, 'utf8')) as { sessions: Array<{ messages: Array<Record<string, unknown>> }> };
  const users = state.sessions[0].messages.filter((message) => message.type === 'user');
  expect(users).toHaveLength(3);
  expect(users.filter((message) => message.id === 'msg_cmd-replay')).toHaveLength(1);
});
