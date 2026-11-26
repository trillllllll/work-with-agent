import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { rawFrame, writeSession } from '../../test/dsh-fixtures.mjs';
import { CodexRejected, type HarnessNotification } from './harness-codex.js';
import { DshHarnessRuntime } from './harness-dsh.js';
import { dshProjectKey, readDshLibrary, readDshTurns } from './harness-dsh-library.js';
import { decodeFirstZstdFrame, decodeZstd } from './harness-dsh-zstd.js';
import { readDshSettings } from './harness-settings.js';

// Each runtime starts a process and waits up to 1.5 s for its bridge plugin, which needs headroom on a busy machine.
vi.setConfig({ testTimeout: 15_000 });

const stub = fileURLToPath(new URL('../../test/stub-dsh-acp.mjs', import.meta.url));
const knobs = ['HARNESS_TEST_DSH_LOCKED', 'HARNESS_TEST_DSH_ASK', 'HARNESS_TEST_DSH_HOLD', 'HARNESS_TEST_DSH_NO_BRIDGE',
  'HARNESS_TEST_DSH_COMMIT_ORDER'];
const model = '["stub","stub-model"]';

type Recorded = { method: string; params: Record<string, unknown>; id?: number | string };
let directory = '';
let cwd = '';
let home = '';
let store = '';
let notifications: Recorded[] = [];

const until = async (check: () => boolean, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待 DSH stub 事件超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

async function start(extra: Record<string, string> = {}) {
  directory = await mkdtemp(join(tmpdir(), 'dovun-dsh-test-'));
  await mkdir(join(directory, 'project'));
  // The temp root lives behind the /var symlink; the runtime compares canonical paths.
  cwd = await realpath(join(directory, 'project'));
  home = join(directory, 'home');
  store = join(directory, 'store.json');
  process.env.DOVUN_DSH_BIN = stub;
  process.env.DSH_HOME = home;
  process.env.HARNESS_TEST_DSH_STORE = store;
  for (const key of knobs) delete process.env[key];
  Object.assign(process.env, extra);
}

function runtime(onExit = () => undefined, advanced: () => boolean = () => false) {
  notifications = [];
  const notify: HarnessNotification = (method, params, id) => { notifications.push({ method, params, id }); };
  return new DshHarnessRuntime(cwd, notify, onExit, advanced);
}

const methods = (name: string) => notifications.filter((entry) => entry.method === name);
const find = (name: string) => methods(name).at(-1);
const itemOf = (entry: Recorded | undefined) => entry?.params.item as Record<string, unknown> | undefined;
const itemsOf = (type: string) => methods('item/completed').map(itemOf).filter((item) => item?.type === type);
const started = async (app: DshHarnessRuntime) => {
  const result = await app.request('thread/start', { cwd });
  return (result.thread as Record<string, unknown>).id as string;
};
const send = (app: DshHarnessRuntime, threadId: string, commandId: string, text: string, extra: Record<string, unknown> = {}) =>
  app.request('turn/start', { threadId, clientUserMessageId: commandId, input: [{ type: 'text', text }], ...extra });
const settled = () => until(() => Boolean(find('turn/completed')?.params.turn)).then(() => find('turn/completed')?.params.turn);
const approval = async () => until(() => Boolean(find('item/commandExecution/requestApproval')))
  .then(() => find('item/commandExecution/requestApproval')!);
const seed = (id: string, preset = 'workspace-write') => writeFile(store, JSON.stringify({ sessions: {
  [id]: { id, cwd, model, effort: 'high', preset, createdAt: Date.now(), title: '', lastPromptAt: 0, turn: 0, step: 0, running: false },
} }));

afterEach(async () => {
  for (const key of ['DOVUN_DSH_BIN', 'DSH_HOME', 'HARNESS_TEST_DSH_STORE', ...knobs]) delete process.env[key];
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  directory = '';
});

it.each(['bridge-first', 'acp-first', 'acp-only-commit'])('streams and commits one answer with %s delivery', async (order) => {
  await start({ HARNESS_TEST_DSH_COMMIT_ORDER: order });
  const app = runtime();
  const begun = await app.request('thread/start', { cwd });
  const threadId = (begun.thread as Record<string, unknown>).id as string;
  expect(threadId).toMatch(/^session-/);
  expect(begun).toMatchObject({ model, modelProvider: 'dsh', reasoningEffort: 'high',
    collaborationMode: { mode: 'default' }, sandbox: { type: 'workspaceWrite' } });
  expect(app.bridgeReady).toBe(true);
  expect(await send(app, threadId, 'cmd-first', '你好')).toEqual({ turn: { id: 'cmd-first', status: 'inProgress' } });
  await settled();
  expect(methods('item/agentMessage/delta').map((entry) => entry.params.delta).join('')).toBe('DSH stub 记得 你好');
  // The committed message keeps the id its stream started under, so it replaces the streamed text instead of adding to it.
  const opening = methods('item/started').map(itemOf).find((item) => item?.type === 'agentMessage');
  expect(itemsOf('agentMessage')).toEqual([expect.objectContaining({ id: opening?.id, text: 'DSH stub 记得 你好', phase: 'final_answer' })]);
  expect(itemsOf('userMessage')).toEqual([expect.objectContaining({ id: 'cmd-first', clientId: 'cmd-first' })]);
  expect(find('thread/tokenUsage/updated')?.params.tokenUsage)
    .toMatchObject({ last: { totalTokens: 1_200 }, total: { totalTokens: 1_200 }, modelContextWindow: 1_000_000 });
  expect(find('turn/completed')?.params.turn).toEqual({ id: 'cmd-first', status: 'completed' });
  // The turn is readable again from the log the stub wrote in dsh's layout.
  const page = await app.request('thread/turns/list', { threadId, limit: 20 });
  expect(page.data).toMatchObject([{ status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: '你好' }] },
    { type: 'agentMessage', text: 'DSH stub 记得 你好', phase: 'final_answer' },
  ] }]);
  // The bridge supplies every model's efforts up front; ACP alone would only know the selected model's.
  expect(await app.request('model/list', {})).toMatchObject({ data: [
    { model, displayName: 'Stub Model', defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [{ reasoningEffort: 'off' }, { reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'max' }] },
    { model: '["stub","stub-lite"]', displayName: 'Stub Lite', defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
  ] });
  expect(await app.request('collaborationMode/list', {})).toEqual({ data: [] });
  await app.close();
});

it('refuses to resume a missing or occupied original session', async () => {
  await start({ HARNESS_TEST_DSH_LOCKED: 'session-held' });
  await seed('session-held');
  const app = runtime();
  await expect(app.request('thread/resume', { threadId: 'session_missing' })).rejects.toThrow('找不到 DSH 原会话');
  await expect(app.request('thread/resume', { threadId: 'session-held' })).rejects.toThrow('DSH 原会话正在被占用');
  await expect(app.request('thread/fork', { threadId: 'x' })).rejects.toThrow(CodexRejected);
  await app.close();
});

it('maps a DSH approval to allow-once or reject and settles the tool', async () => {
  await start({ HARNESS_TEST_DSH_ASK: '1' });
  const app = runtime();
  const threadId = await started(app);
  await send(app, threadId, 'cmd-ask', '运行命令');
  const request = await approval();
  expect(request.params).toMatchObject({ turnId: 'cmd-ask', command: 'printf hello', reason: '打印问候', availableDecisions: ['accept', 'decline'] });
  await app.reply(request.id!, { decision: 'accept' });
  await settled();
  expect(notifications.some((entry) => entry.method === 'serverRequest/resolved' && entry.params.requestId === request.id)).toBe(true);
  expect(itemsOf('commandExecution')).toEqual([expect.objectContaining({ command: 'printf hello', status: 'completed', aggregatedOutput: 'hello' })]);
  // Text that shares a step with a tool call is commentary; the reply after the tool result is the answer.
  expect(itemsOf('agentMessage').map((item) => [item?.text, item?.phase]))
    .toEqual([['先打印问候', 'commentary'], ['DSH stub 记得 运行命令', 'final_answer']]);
  await app.close();
  // A rejection fails the tool and the turn still finishes.
  const again = runtime();
  await again.request('thread/resume', { threadId });
  await send(again, threadId, 'cmd-deny', '再运行一次');
  const second = await approval();
  await again.reply(second.id!, { decision: 'decline' });
  await until(() => methods('turn/completed').length === 1);
  expect(itemsOf('commandExecution')).toEqual([expect.objectContaining({ status: 'failed' })]);
  expect(find('turn/completed')?.params.turn).toEqual({ id: 'cmd-deny', status: 'completed' });
  await again.close();
});

it('rejects a second send while the turn runs and reports an interrupted turn', async () => {
  await start({ HARNESS_TEST_DSH_ASK: '1', HARNESS_TEST_DSH_HOLD: '1' });
  const app = runtime();
  const threadId = await started(app);
  await send(app, threadId, 'cmd-hold', '慢一点');
  await app.reply((await approval()).id!, { decision: 'accept' });
  await until(() => methods('item/started').some((entry) => itemOf(entry)?.type === 'commandExecution'));
  await expect(send(app, threadId, 'cmd-second', '第二条')).rejects.toThrow('当前轮仍在运行');
  await app.request('turn/interrupt', { threadId, turnId: 'cmd-hold' });
  expect(await settled()).toEqual({ id: 'cmd-hold', status: 'interrupted' });
  // dsh records a stopped turn as `aborted`; history must agree with what the live view showed.
  const page = await app.request('thread/turns/list', { threadId, limit: 20 });
  expect(page.data).toMatchObject([{ status: 'interrupted', items: [{ type: 'userMessage' }, { type: 'agentMessage' },
    { type: 'commandExecution', status: 'failed', aggregatedOutput: 'Error: tool call aborted' }] }]);
  await app.close();
});

it('switches the permission preset through the bridge and reports it again on resume', async () => {
  await start();
  const app = runtime(undefined, () => true);
  const threadId = await started(app);
  const selection = { model, effort: 'high', mode: 'default' as const, permission: 'workspace' as const, revision: 0 };
  expect(await readDshSettings(app, selection, true))
    .toMatchObject({ planAvailable: false, catalogAvailable: true, sandboxChoices: ['readOnly', 'workspace', 'fullAccess'] });
  expect(await readDshSettings(app, selection, false)).toMatchObject({ sandboxChoices: ['readOnly', 'workspace'] });
  // The preset of the next turn is applied before its prompt, exactly as the sandbox of a Codex turn is.
  await send(app, threadId, 'cmd-readonly', '只读', { sandboxPolicy: { type: 'readOnly' } });
  await settled();
  await app.close();
  const resumed = runtime();
  await expect(resumed.request('thread/resume', { threadId })).resolves.toMatchObject({ sandbox: { type: 'readOnly' } });
  await send(resumed, threadId, 'cmd-full', '完全访问', { sandboxPolicy: { type: 'dangerFullAccess' } });
  await settled();
  await resumed.close();
  // Full access is reported only where the page may offer it; otherwise the shown preset is the middle one.
  const plain = runtime();
  await expect(plain.request('thread/resume', { threadId })).resolves.toMatchObject({ sandbox: { type: 'workspaceWrite' } });
  await plain.close();
  const full = runtime(undefined, () => true);
  await expect(full.request('thread/resume', { threadId })).resolves.toMatchObject({ sandbox: { type: 'dangerFullAccess' } });
  await full.close();
});

it('keeps working without the bridge plugin, with whole messages and no preset switch', async () => {
  await start({ HARNESS_TEST_DSH_NO_BRIDGE: '1' });
  const app = runtime(undefined, () => true);
  const threadId = await started(app);
  expect(app.bridgeReady).toBe(false);
  expect(await readDshSettings(app, { model, effort: 'high', mode: 'default', permission: 'workspace', revision: 0 }, true))
    .toMatchObject({ sandboxChoices: [] });
  expect(await app.request('model/list', {})).toMatchObject({ data: [
    { model, supportedReasoningEfforts: [{ reasoningEffort: 'off' }, { reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'max' }] },
    { model: '["stub","stub-lite"]', supportedReasoningEfforts: [] },
  ] });
  await expect(send(app, threadId, 'cmd-switch', '换个权限', { sandboxPolicy: { type: 'readOnly' } })).rejects.toThrow('DSH 权限桥接未加载');
  await send(app, threadId, 'cmd-plain', '照常发送');
  await settled();
  expect(methods('item/agentMessage/delta')).toHaveLength(0);
  expect(itemsOf('agentMessage')).toEqual([expect.objectContaining({ text: 'DSH stub 记得 照常发送', phase: 'final_answer' })]);
  await expect(app.request('turn/start', { threadId, clientUserMessageId: 'cmd-image', input: [
    { type: 'text', text: '看图' }, { type: 'image', url: 'data:image/png;base64,AAAA' },
  ] })).rejects.toThrow('DSH 当前模型不支持图片附件');
  await app.close();
});

const header = (id: string, dir: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'session', version: 4, id, createdAt: 1_700_000_000_000, cwd: dir, isSeeded: false, delegationDepth: 0, ...extra });
const ask = (id: string, text: string, kind = 'user') =>
  ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind }, role: 'user', id } });
const say = (id: string, text: string, tools = false) =>
  ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }, ...(tools ? [{ type: 'tool-call', id: 'x' }] : [])] } } });
const call = (turn: number, step: number, callId: string, name: string, args: Record<string, unknown>) =>
  ({ type: 'tool/call', data: { turn, step, callId, name, arguments: JSON.stringify(args) } });
const result = (turn: number, step: number, callId: string, text: string) =>
  ({ type: 'tool/result', data: { turn, step, message: { source: { kind: 'tool', callId }, role: 'tool', id: 'r-' + callId,
    content: [{ type: 'text', toolCallId: callId, content: { type: 'text', text } }] } } });
const end = (turn: number, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } });

async function seedProject() {
  await start();
  await writeSession(home, { cwd, id: 'session-main', title: '种子的对话', lastPromptAt: 1_700_000_005_000, records: [
    header('session-main', cwd),
    ask('u-old', '第一条'), say('a-old', '第一条回复'), { type: 'turn/start', data: { turn: 1 } }, end(1),
    ask('u-new', '第二条'), ask('ctx', '<system-reminder>插件注入的上下文</system-reminder>', 'plugin'),
    { type: 'turn/start', data: { turn: 2 } },
    say('a-1', '先看文件', true), call(2, 1, 'c-read', 'read', { file_path: join(cwd, 'src/a.ts') }), result(2, 1, 'c-read', '文件内容'),
    call(2, 2, 'c-run', 'bash', { command: 'npm test', description: '跑测试' }), result(2, 2, 'c-run', '测试通过'),
    say('a-2', '完成'), end(2),
  ] });
  // A subagent session belongs to its parent and is never listed on its own.
  await writeSession(home, { cwd, id: 'session-child', records: [header('session-child', cwd, { origin: 'subagent' }), ask('c', '子任务'), end(1)] });
  await writeSession(home, { cwd: join(directory, 'other'), id: 'session-elsewhere', records: [header('session-elsewhere', join(directory, 'other')), ask('o', '别处')] });
  await writeSession(home, { cwd, id: 'session-open', records: [header('session-open', cwd), ask('u-open', '还没结束的'), { type: 'turn/start', data: { turn: 1 } }, say('a-open', '进行中')] });
  await writeSession(home, { cwd, id: 'session-stopped', records: [header('session-stopped', cwd), ask('u-stop', '被打断的'), { type: 'turn/start', data: { turn: 1 } },
    say('a-stop', '写到一半', true), call(1, 1, 'c-stop', 'bash', { command: 'sleep 20' }),
    { type: 'tool/result', data: { turn: 1, step: 1, error: { code: 'ABORTED' }, message: { source: { kind: 'tool', callId: 'c-stop' }, role: 'tool', id: 'r-stop',
      content: [{ type: 'text', toolCallId: 'c-stop', content: { type: 'text', text: 'Error: tool call aborted' }, isError: true }] } } },
    end(1, 'aborted')] });
}

it('lists a project from the store, skipping subagents, and reads history at turn boundaries', async () => {
  await seedProject();
  const task = (kind: 'index' | 'catalog' | 'thread' | 'history', extra: Record<string, unknown> = {}) =>
    readDshLibrary({ kind, id: 'read', harness: 'dsh', cursor: null, cwd, ...extra } as never, [cwd]);
  const catalog = await task('catalog') as { threads: Array<Record<string, unknown>>; nextCursor: string | null };
  expect(catalog.threads.map((thread) => thread.threadId)).toEqual(['session-main', 'session-open', 'session-stopped']);
  expect(catalog.threads[0]).toMatchObject({ title: '种子的对话', updatedAt: '2023-11-14T22:13:25.000Z' });
  expect(catalog.nextCursor).toBeNull();
  const index = await task('index') as { threads: Array<Record<string, unknown>> };
  expect(index.threads.map((thread) => thread.threadId)).toEqual(['session-main', 'session-open', 'session-stopped']);
  expect(index.threads[0]).toMatchObject({ cwd, name: 'project' });
  expect(await task('thread', { threadId: 'session-main' })).toMatchObject({ threadId: 'session-main', title: '种子的对话' });
  await expect(task('thread', { threadId: 'session-child' })).rejects.toThrow('这条对话不在所选项目目录中');
  await expect(task('thread', { threadId: 'session-elsewhere' })).rejects.toThrow('这条对话不在所选项目目录中');
  // Only real prompts open a turn; injected context stays out of the conversation.
  const newest = await readDshTurns('session-main', cwd, null, 1);
  expect(newest.data).toHaveLength(1);
  expect(newest.data[0].id).toBe('u-new');
  expect(newest.data[0].items.map((item) => item.type)).toEqual(['userMessage', 'agentMessage', 'dynamicToolCall', 'commandExecution', 'agentMessage']);
  expect(newest.data[0].items[2]).toMatchObject({ id: 'c-read', tool: 'read src/a.ts' });
  expect(newest.data[0].items[3]).toMatchObject({ id: 'c-run', command: 'npm test', status: 'completed', aggregatedOutput: '测试通过' });
  expect(newest.nextCursor).toBe('1');
  const older = await readDshTurns('session-main', cwd, newest.nextCursor, 5);
  expect(older.data).toMatchObject([{ id: 'u-old', status: 'completed' }]);
  expect(older.nextCursor).toBeNull();
  await expect(readDshTurns('session-main', cwd, '99', 5)).rejects.toThrow('历史页已变化');
  const history = await task('history', { threadId: 'session-main' }) as { view: Record<string, any>; nextCursor: string | null };
  expect(history.view.messages.map((message: { role: string; phase?: string }) => `${message.role}:${message.phase ?? '-'}`))
    .toEqual(['user:-', 'assistant:final_answer', 'user:-', 'assistant:commentary', 'assistant:final_answer']);
  expect(history.view.tools.map((tool: { kind: string; status: string }) => `${tool.kind}:${tool.status}`)).toEqual(['tool:completed', 'command:completed']);
  // A turn whose end was never recorded reads as interrupted once no process holds the session.
  const open = await task('history', { threadId: 'session-open' }) as { view: Record<string, any> };
  expect(open.view.turns).toMatchObject([{ id: 'u-open', status: 'interrupted' }]);
  // A turn the user stopped reads the same way after a reload as it did live.
  const stopped = await task('history', { threadId: 'session-stopped' }) as { view: Record<string, any> };
  expect(stopped.view.turns).toMatchObject([{ id: 'u-stop', status: 'interrupted' }]);
  expect(stopped.view.tools).toMatchObject([{ id: 'c-stop', status: 'failed', output: 'Error: tool call aborted' }]);
  await expect(task('catalog', { cwd: join(directory, 'missing') })).rejects.toThrow();
});

it('decodes framed logs and drops a frame that is still being written', () => {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  expect(decodeZstd(Buffer.concat([rawFrame('a\n'), rawFrame('b\n')])).toString()).toBe('a\nb\n');
  expect(decodeZstd(rawFrame('x'.repeat(200_000))).toString()).toHaveLength(200_000);
  // The magic can occur inside a frame. A truncated tail forces the frame-by-frame path, where it must not split that frame.
  const embedded = rawFrame('x' + magic.toString('latin1') + 'y\n');
  expect(decodeZstd(Buffer.concat([embedded, rawFrame('c\n'), rawFrame('d\n').subarray(0, 12)])).toString())
    .toBe('x' + magic.toString('latin1') + 'y\nc\n');
  expect(decodeZstd(Buffer.concat([rawFrame('a\n'), rawFrame('b\n').subarray(0, 12)])).toString()).toBe('a\n');
  expect(decodeFirstZstdFrame(Buffer.concat([embedded, rawFrame('tail')]).subarray(0, embedded.length + 10)).toString())
    .toBe('x' + magic.toString('latin1') + 'y\n');
  expect(decodeFirstZstdFrame(Buffer.concat([embedded, rawFrame('tail')])).toString()).toBe('x' + magic.toString('latin1') + 'y\n');
  // The project key collapses separator runs and escapes everything else; membership still follows the header.
  expect(dshProjectKey('/Users/byc/Work Space')).toBe('--Users-byc-Work~0020Space--');
  expect(dshProjectKey('/a//b/:c')).toBe('--a-b-c--');
});
