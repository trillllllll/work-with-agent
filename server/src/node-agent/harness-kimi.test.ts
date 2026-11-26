import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type { HarnessNotification } from './harness-codex.js';
import { KimiHarnessRuntime } from './harness-kimi.js';
import { kimiHistoryTurns, readKimiThread, readKimiTurns } from './harness-kimi-library.js';
import { readHarnessLibrary } from './harness-library.js';
import { readKimiSettings } from './harness-settings.js';

vi.setConfig({ testTimeout: 20_000 });
const stub = fileURLToPath(new URL('../../test/stub-kimi-acp.mjs', import.meta.url));
type Recorded = { method: string; params: Record<string, unknown>; id?: number | string };
let directory = '';
let cwd = '';
let store = '';
let notifications: Recorded[] = [];
const knobs = ['HARNESS_TEST_KIMI_ASK', 'HARNESS_TEST_KIMI_HOLD', 'HARNESS_TEST_KIMI_LOCKED', 'HARNESS_TEST_KIMI_NO_IMAGE'];

const until = async (check: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待 Kimi stub 事件超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const methods = (name: string) => notifications.filter((entry) => entry.method === name);
const find = (name: string) => methods(name).at(-1);
const itemOf = (entry: Recorded | undefined) => entry?.params.item as Record<string, unknown> | undefined;
const itemsOf = (type: string) => methods('item/completed').map(itemOf).filter((item) => item?.type === type);
const settled = (id: string) => until(() => methods('turn/completed').some((entry) =>
  (entry.params.turn as Record<string, unknown>).id === id)).then(() => find('turn/completed')?.params.turn);
const runtime = (onExit = () => undefined) => {
  notifications = [];
  const notify: HarnessNotification = (method, params, id) => notifications.push({ method, params, id });
  return new KimiHarnessRuntime(cwd, notify, onExit);
};
const send = (app: KimiHarnessRuntime, threadId: string, commandId: string, value: string, extra: Record<string, unknown> = {}) =>
  app.request('turn/start', { threadId, clientUserMessageId: commandId, input: [{ type: 'text', text: value }], ...extra });
const started = async (app: KimiHarnessRuntime) => {
  const result = await app.request('thread/start', { cwd });
  return (result.thread as Record<string, unknown>).id as string;
};
const persisted = async (id: string) => JSON.parse(await readFile(store, 'utf8')).sessions[id];

async function start(extra: Record<string, string> = {}) {
  directory = await mkdtemp(join(tmpdir(), 'dovun-kimi-test-'));
  await mkdir(join(directory, 'project'));
  cwd = await realpath(join(directory, 'project'));
  store = join(directory, 'store.json');
  await writeFile(store, JSON.stringify({ sessions: {} }));
  vi.stubEnv('DOVUN_KIMI_BIN', stub);
  vi.stubEnv('KIMI_CODE_HOME', join(directory, 'home'));
  vi.stubEnv('HARNESS_TEST_KIMI_STORE', store);
  for (const key of knobs) vi.stubEnv(key, '');
  Object.entries(extra).forEach(([key, value]) => vi.stubEnv(key, value));
}

async function seed() {
  const other = join(directory, 'other');
  await mkdir(other);
  const original = {
    id: 'session-original', cwd, title: 'Mac 上的原 Kimi 对话', updatedAt: '2026-11-26T08:00:00.000Z',
    model: 'kimi-code/k3.1-pro', thinking: 'high', mode: 'default', running: false,
    turns: [
      { user: [{ type: 'text', text: '第一条原消息' }], items: [
        { type: 'thought', text: '先查看项目' },
        { type: 'tool', id: '1:tool_old', kind: 'execute', title: 'Running: printf old', rawInput: { command: 'printf old' }, rawOutput: 'old' },
        { type: 'answer', text: '第一条原回复' },
      ] },
      { user: [{ type: 'text', text: '第二条原消息' }], items: [{ type: 'answer', text: '第二条原回复' }] },
    ],
  };
  const foreign = { ...original, id: 'session-foreign', cwd: other, title: '其他项目' };
  await writeFile(store, JSON.stringify({ sessions: { [original.id]: original, [foreign.id]: foreign } }));
  return { original, other };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  directory = '';
});

it('streams, applies native settings and images, and forks without changing the current session', async () => {
  await start();
  const app = runtime();
  const started = await app.request('thread/start', { cwd });
  const threadId = (started.thread as Record<string, unknown>).id as string;
  expect(started).toMatchObject({ model: 'kimi-code/k3.1-pro', modelProvider: 'kimi', reasoningEffort: 'high', collaborationMode: { mode: 'default' } });
  expect(await app.request('model/list', {})).toMatchObject({ data: [
    { model: 'kimi-code/kimi-for-coding', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'max' }] },
    { model: 'kimi-code/k3.1-pro' },
  ] });
  const selection = { model: 'kimi-code/k3.1-pro', effort: 'high', mode: 'default' as const, permission: 'workspace' as const, revision: 0 };
  expect(await readKimiSettings(app, selection, true)).toMatchObject({ permissionMode: 'default', permissionModes: ['default', 'auto', 'bypassPermissions'], sandboxChoices: [] });
  await send(app, threadId, 'cmd-settings', '看图', { model: 'kimi-code/kimi-for-coding', effort: 'max', permissionMode: 'auto',
    input: [{ type: 'text', text: '看图' }, { type: 'image', url: 'data:image/png;base64,AAAA' }] });
  expect(await settled('cmd-settings')).toEqual({ id: 'cmd-settings', status: 'completed' });
  expect(itemsOf('userMessage')).toEqual([expect.objectContaining({ id: 'cmd-settings:user', clientId: 'cmd-settings' })]);
  expect(itemsOf('agentMessage').at(-1)).toMatchObject({ text: 'Kimi stub 收到图片', phase: 'final_answer' });
  expect(find('thread/tokenUsage/updated')?.params.tokenUsage).toMatchObject({ last: { totalTokens: 1200 }, modelContextWindow: 1048576 });
  expect(await persisted(threadId)).toMatchObject({ model: 'kimi-code/kimi-for-coding', thinking: 'max', mode: 'auto', lastImages: [{ mimeType: 'image/png', data: 'AAAA' }] });
  expect(await readKimiSettings(app, { ...selection, model: 'kimi-code/kimi-for-coding', effort: 'max' }, true)).toMatchObject({ permissionMode: 'auto' });
  await send(app, threadId, 'cmd-plan', '计划', { collaborationMode: { mode: 'plan' }, permissionMode: 'auto' });
  await settled('cmd-plan');
  expect((await persisted(threadId)).mode).toBe('plan');
  await send(app, threadId, 'cmd-full', '完全访问', { collaborationMode: { mode: 'default' }, permissionMode: 'bypassPermissions' });
  await settled('cmd-full');
  expect((await persisted(threadId)).mode).toBe('yolo');
  const forked = await app.request('thread/fork', { threadId });
  expect((forked.thread as Record<string, unknown>).id).not.toBe(threadId);
  expect(await app.request('thread/read', { threadId })).toMatchObject({ thread: { id: threadId } });
  await app.close();
});

it('lists native sessions inside allowed roots and reads replayed history without system reminders or duplicates', async () => {
  await start();
  const { original } = await seed();
  const catalog = await readHarnessLibrary({ kind: 'catalog', id: 'read', cwd, cursor: null, harness: 'kimi' }, [cwd]);
  expect(catalog).toMatchObject({ threads: [{ threadId: original.id, title: 'Mac 上的原 Kimi 对话' }] });
  const index = await readHarnessLibrary({ kind: 'index', id: 'read', cursor: null, harness: 'kimi' }, [cwd]);
  expect(index).toMatchObject({ threads: [{ threadId: original.id, cwd }] });
  if (process.platform === 'darwin') {
    const alias = cwd.replace(/^\/private(?=\/var\/)/, '');
    expect((await readKimiThread(original.id, alias))?.id).toBe(original.id);
  }
  const latest = await readKimiTurns(original.id, cwd, null, 1);
  expect(latest.data).toHaveLength(1);
  expect(latest.data[0].items.map((item) => item.type)).toEqual(['userMessage', 'agentMessage']);
  expect(latest.nextCursor).toBe('kimi-turn-2');
  const older = await readHarnessLibrary({ kind: 'history', id: 'read', cwd, threadId: original.id, cursor: latest.nextCursor, harness: 'kimi' }, [cwd]);
  if (!('view' in older)) throw new Error('expected older history');
  expect(older.view.messages.map((message) => [message.role, message.text, message.phase ?? ''])).toEqual([
    ['user', '第一条原消息', ''], ['assistant', '先查看项目', 'commentary'], ['assistant', '第一条原回复', 'final_answer'],
  ]);
  expect(older.view.messages.some((message) => message.text.includes('system-reminder'))).toBe(false);
  expect(older.view.tools).toEqual([expect.objectContaining({ kind: 'command', title: 'printf old', output: 'old', status: 'completed' })]);
  const app = runtime();
  await expect(app.request('thread/resume', { threadId: original.id })).resolves.toMatchObject({ thread: { id: original.id } });
  const attached = await app.request('thread/turns/list', { threadId: original.id, limit: 1 });
  expect(attached.data as unknown[]).toHaveLength(1);
  expect(notifications).toEqual([]);
  await expect(app.request('thread/resume', { threadId: 'session-foreign' })).rejects.toThrow('这条对话不在所选项目目录中');
  await app.close();
});

it('preserves native approval option ids for allow and reject', async () => {
  await start({ HARNESS_TEST_KIMI_ASK: '1' });
  const app = runtime();
  const threadId = await started(app);
  await send(app, threadId, 'cmd-allow', '运行命令');
  await until(() => Boolean(find('item/commandExecution/requestApproval')));
  const approval = find('item/commandExecution/requestApproval')!;
  expect(approval.params.availableOptions).toEqual([
    { id: 'approve_once', kind: 'allow_once', name: 'Approve once' },
    { id: 'approve_always', kind: 'allow_always', name: 'Approve for this session' },
    { id: 'reject', kind: 'reject_once', name: 'Reject' },
  ]);
  await app.reply(approval.id!, { optionId: 'approve_once' });
  await settled('cmd-allow');
  expect(itemsOf('commandExecution')).toEqual([expect.objectContaining({ status: 'completed', aggregatedOutput: 'hello' })]);
  expect(notifications.some((entry) => entry.method === 'serverRequest/resolved' && entry.params.requestId === approval.id)).toBe(true);
  await app.close();

  const again = runtime();
  await again.request('thread/resume', { threadId });
  await send(again, threadId, 'cmd-reject', '拒绝命令');
  await until(() => Boolean(find('item/commandExecution/requestApproval')));
  await again.reply(find('item/commandExecution/requestApproval')!.id!, { decision: 'decline' });
  await settled('cmd-reject');
  expect(itemsOf('commandExecution')).toEqual([expect.objectContaining({ status: 'failed', aggregatedOutput: 'rejected' })]);
  await again.close();
});

it('rejects a concurrent prompt, interrupts the active turn, and reports native occupancy', async () => {
  await start({ HARNESS_TEST_KIMI_HOLD: '1' });
  const app = runtime();
  const threadId = await started(app);
  await send(app, threadId, 'cmd-hold', '慢一点');
  await expect(send(app, threadId, 'cmd-second', '第二条')).rejects.toThrow('当前轮仍在运行');
  await app.request('turn/interrupt', { threadId, turnId: 'cmd-hold' });
  expect(await settled('cmd-hold')).toEqual({ id: 'cmd-hold', status: 'interrupted' });
  await app.close();
  vi.stubEnv('HARNESS_TEST_KIMI_LOCKED', threadId);
  const locked = runtime();
  await expect(locked.request('thread/resume', { threadId })).rejects.toThrow('Kimi Code 原会话正在被占用');
  await locked.close();
});

it('does not mark a completed thought-only replay as interrupted', () => {
  const turns = kimiHistoryTurns([
    { sessionId: 's', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'question' } } },
    { sessionId: 's', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'answer in thought' } } },
  ], 's');
  expect(turns[0].status).toBe('completed');
});

it('honours the negotiated image capability', async () => {
  await start({ HARNESS_TEST_KIMI_NO_IMAGE: '1' });
  const app = runtime();
  const threadId = await started(app);
  await expect(send(app, threadId, 'cmd-image', '看图', { input: [{ type: 'text', text: '看图' }, { type: 'image', url: 'data:image/png;base64,AAAA' }] }))
    .rejects.toThrow('Kimi Code 当前模型不支持图片附件');
  await app.close();
});
