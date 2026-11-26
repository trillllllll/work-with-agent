import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { GrokAgentRuntime, grokAvailable } from './harness-grok.js';

const sessionId = '01a21348-ae50-7260-9166-0480e752ad35';

// A minimal stand-in for `grok agent stdio`: JSON-RPC 2.0 on stdio with the
// protocol surface the adapter consumes, scripted per prompt prefix.
const fakeAgent = `import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) {
  console.log('grok 1.0.50 (fixture)');
  process.exit(0);
}
const sessionId = '${sessionId}';
const log = process.env.DOVUN_FAKE_GROK_LOG ?? '/dev/null';
const note = (entry) => appendFileSync(log, JSON.stringify(entry) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const configOptions = [
  { id: 'model', name: 'Model', type: 'select', currentValue: 'grok-test', options: [{ id: 'grok-test', name: 'Grok Test' }] },
  { id: 'reasoning_effort', name: 'Effort', type: 'select', currentValue: 'low', options: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
];
const modes = { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] };
let slowPrompt = null;
let permissionReply = null;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === undefined) {
    if (message.id !== undefined) permissionReply = message;
    return;
  }
  note({ method: message.method, params: message.params });
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: 1, authMethods: [], _meta: { defaultAuthMethodId: 'grok.com', modelState: { availableModels: [
      { modelId: 'grok-test', name: 'Grok Test', _meta: { totalContextTokens: 100000, reasoningEfforts: [
        { id: 'low', value: 'low', label: 'Low', default: true }, { id: 'high', value: 'high', label: 'High', default: false }] } },
    ] } } } });
  } else if (message.method === 'session/new') {
    if (process.env.DOVUN_FAKE_GROK_MODE === 'auth') send({ id: message.id, error: { code: -32000, message: 'Authentication required', data: 'no auth method id provided' } });
    else send({ id: message.id, result: { sessionId, modes, configOptions } });
  } else if (message.method === 'session/load') {
    if (String(message.params.sessionId) !== sessionId) send({ id: message.id, error: { code: -32000, message: 'Session not found' } });
    else send({ id: message.id, result: { modes, configOptions, _meta: message.params._meta } });
  } else if (message.method === 'session/set_config_option') {
    const option = configOptions.find((entry) => entry.id === message.params.configId);
    if (option) option.currentValue = String(message.params.value?.value ?? '');
    send({ id: message.id, result: configOptions });
  } else if (message.method === 'session/set_mode') {
    modes.currentModeId = message.params.modeId;
    send({ id: message.id, result: {} });
  } else if (message.method === 'session/prompt') {
    const text = String(message.params.prompt?.[0]?.text ?? '');
    if (text.startsWith('SLOW')) { slowPrompt = message.id; return; }
    if (text.startsWith('PERM')) {
      update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
      send({ jsonrpc: '2.0', id: 500, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'tc-perm', title: 'Run risky --command', kind: 'execute' },
        options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } });
      const finish = setInterval(() => {
        if (!permissionReply) return;
        clearInterval(finish);
        note({ permissionReply: permissionReply.result });
        update({ sessionUpdate: 'tool_call', toolCallId: 'tc-perm', title: 'bash', rawInput: { command: 'risky --command' }, _meta: { 'x.ai/tool': { name: 'bash', kind: 'execute' } } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-perm', kind: 'execute', title: 'Run risky --command', status: 'completed', content: [{ type: 'text', text: 'done' }] });
        send({ id: message.id, result: { stopReason: 'end_turn' } });
      }, 10);
      return;
    }
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { promptId: 'p-1' } });
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Considering.' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'there' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'bash', rawInput: { command: 'echo hi' }, _meta: { 'x.ai/tool': { name: 'bash' } } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', kind: 'execute', title: 'Run echo hi', content: [{ type: 'content', content: { type: 'text', text: 'Running echo hi' } }] });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hi' } }] });
    update({ sessionUpdate: 'plan', entries: [{ content: { type: 'text', text: 'Only step' }, state: 'in_progress' }] });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All done.' } });
    send({ id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.method === 'session/cancel') {
    if (slowPrompt !== null) { send({ id: slowPrompt, result: { stopReason: 'cancelled' } }); slowPrompt = null; }
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

type Notification = { method: string; params: Record<string, unknown>; id?: string | number };

async function harness() {
  const temporary = await mkdtemp(join(tmpdir(), 'dovun-grok-runtime-'));
  const root = await realpath(temporary);
  const project = join(root, 'project');
  await mkdir(project);
  const log = join(root, 'agent.log');
  await writeFile(join(root, 'fake-grok.mjs'), fakeAgent);
  vi.stubEnv('DOVUN_GROK_BIN', join(root, 'fake-grok.mjs'));
  vi.stubEnv('GROK_HOME', join(root, 'grok-home'));
  vi.stubEnv('DOVUN_FAKE_GROK_LOG', log);
  const notifications: Notification[] = [];
  const runtime = await GrokAgentRuntime.open(project, (method, params, id) => notifications.push({ method, params, id }), () => undefined);
  const until = async (predicate: (entry: Notification) => boolean) => {
    const started = Date.now();
    for (;;) {
      const found = notifications.find(predicate);
      if (found) return found;
      if (Date.now() - started > 10_000) throw new Error('timed out waiting for notification');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { runtime, notifications, project, root, until, log };
}

it('starts a session, streams a turn and maps native updates onto the shared contract', async () => {
  const setup = await harness();
  try {
    expect(await grokAvailable()).toMatchObject({ version: 'grok 1.0.50 (fixture)' });
    const started = await setup.runtime.request('thread/start', { cwd: setup.project });
    expect(started).toMatchObject({ thread: { id: sessionId }, model: 'grok-test', reasoningEffort: 'low', modelProvider: 'grok' });

    const models = await setup.runtime.request('model/list', {}) as { data: Array<Record<string, unknown>> };
    expect(models.data[0]).toMatchObject({ model: 'grok-test', displayName: 'Grok Test', defaultReasoningEffort: 'low' });
    expect((models.data[0].supportedReasoningEfforts as Array<{ reasoningEffort: string }>))
      .toEqual([{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }]);
    const modes = await setup.runtime.request('collaborationMode/list', {});
    expect((modes.data as Array<{ mode: string }>).map((mode) => mode.mode)).toEqual(['default', 'plan']);

    const turn = await setup.runtime.request('turn/start', {
      threadId: sessionId, input: [{ type: 'text', text: 'Regular prompt' }], clientUserMessageId: 'command-1',
    });
    const turnId = (turn.turn as { id: string }).id;
    expect(turn.turn).toMatchObject({ status: 'inProgress' });
    await setup.until((entry) => entry.method === 'turn/completed');

    const userItem = setup.notifications.find((entry) => entry.method === 'item/completed'
      && (entry.params.item as { type?: string }).type === 'userMessage');
    expect(userItem).toMatchObject({ params: { turnId, item: { clientId: 'command-1', content: [{ type: 'text', text: 'Regular prompt' }] } } });
    const deltas = setup.notifications.filter((entry) => entry.method === 'item/agentMessage/delta');
    expect(deltas.map((entry) => entry.params.delta)).toEqual(['Considering.', 'Hello ', 'there', 'All done.']);
    const toolDone = setup.notifications.find((entry) => entry.method === 'item/completed'
      && (entry.params.item as { id?: string }).id === 'tc-1');
    expect(toolDone?.params.item).toMatchObject({ type: 'commandExecution', status: 'completed', aggregatedOutput: 'hi' });
    const plan = setup.notifications.find((entry) => entry.method === 'turn/plan/updated');
    expect(plan?.params.plan).toEqual([{ step: 'Only step', status: 'inProgress' }]);
    const completed = setup.notifications.find((entry) => entry.method === 'turn/completed');
    expect(completed?.params.turn).toEqual({ id: turnId, status: 'completed' });
    const final = setup.notifications.filter((entry) => entry.method === 'item/completed'
      && (entry.params.item as { type?: string }).type === 'agentMessage').at(-1);
    expect(final?.params.item).toMatchObject({ text: 'All done.', phase: 'final_answer' });
  } finally {
    await setup.runtime.close();
    vi.unstubAllEnvs();
    await rm(setup.root, { recursive: true, force: true });
  }
}, 20_000);

it('translates permission decisions and acknowledges them locally', async () => {
  const setup = await harness();
  try {
    await setup.runtime.request('thread/start', { cwd: setup.project });
    const turn = await setup.runtime.request('turn/start', { threadId: sessionId, input: [{ type: 'text', text: 'PERM prompt' }] });
    const request = await setup.until((entry) => entry.method === 'item/commandExecution/requestApproval' && entry.id !== undefined);
    expect(request?.params).toMatchObject({ threadId: sessionId, command: 'Run risky --command', availableDecisions: ['accept', 'decline', 'cancel'] });
    expect(request?.params.turnId).toBe((turn.turn as { id: string }).id);

    await setup.runtime.reply(request.id!, { decision: 'accept' });
    const resolved = await setup.until((entry) => entry.method === 'serverRequest/resolved');
    expect(resolved?.params.requestId).toBe(request.id);
    await setup.until((entry) => entry.method === 'turn/completed');
    const outcome = ((await import('node:fs')).readFileSync(setup.log, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>) as Array<Record<string, unknown>>)
      .filter((entry) => entry.permissionReply !== undefined).at(-1);
    expect(outcome?.permissionReply).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  } finally {
    await setup.runtime.close();
    vi.unstubAllEnvs();
    await rm(setup.root, { recursive: true, force: true });
  }
}, 20_000);

it('interrupts a running turn through session/cancel', async () => {
  const setup = await harness();
  try {
    await setup.runtime.request('thread/start', { cwd: setup.project });
    const turn = await setup.runtime.request('turn/start', { threadId: sessionId, input: [{ type: 'text', text: 'SLOW prompt' }] });
    const turnId = (turn.turn as { id: string }).id;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(setup.runtime.request('turn/interrupt', { threadId: sessionId, turnId })).resolves.toEqual({});
    const completed = await setup.until((entry) => entry.method === 'turn/completed');
    expect(completed?.params.turn).toEqual({ id: turnId, status: 'interrupted' });
  } finally {
    await setup.runtime.close();
    vi.unstubAllEnvs();
    await rm(setup.root, { recursive: true, force: true });
  }
}, 20_000);

it('applies permission modes by reopening the session, and maps login errors', async () => {
  const setup = await harness();
  try {
    await setup.runtime.request('thread/start', { cwd: setup.project });
    const turn = await setup.runtime.request('turn/start', {
      threadId: sessionId, input: [{ type: 'text', text: 'Regular prompt' }], permissionMode: 'bypassPermissions',
    });
    expect(turn.turn).toMatchObject({ status: 'inProgress' });
    await setup.until((entry) => entry.method === 'turn/completed');
    const loads = (await import('node:fs')).readFileSync(setup.log, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line)).filter((entry) => entry.method === 'session/load');
    expect(loads).toHaveLength(1);
    expect(loads[0].params._meta).toEqual({ yoloMode: true });
    expect(loads[0].params.sessionId).toBe(sessionId);
  } finally {
    await setup.runtime.close();
    vi.unstubAllEnvs();
    await rm(setup.root, { recursive: true, force: true });
  }
}, 20_000);

it('rejects unknown sessions and image attachments, and surfaces the native login requirement', async () => {
  const setup = await harness();
  try {
    await expect(setup.runtime.request('thread/resume', { threadId: '01a21349-5999-7292-a01a-baf9e9a18e59' }))
      .rejects.toThrow('这条对话不在所选项目目录中');
    await expect(setup.runtime.request('turn/start', {
      threadId: sessionId, input: [{ type: 'image', url: 'data:image/png;base64,AAAA' }],
    })).rejects.toThrow('Grok 会话暂不支持图片附件');

    vi.stubEnv('DOVUN_FAKE_GROK_MODE', 'auth');
    const fresh = await GrokAgentRuntime.open(setup.project, () => undefined, () => undefined);
    try {
      await expect(fresh.request('thread/start', { cwd: setup.project }))
        .rejects.toThrow('Grok 需要登录，请先在本机终端运行 grok login');
    } finally {
      await fresh.close();
    }
  } finally {
    await setup.runtime.close();
    vi.unstubAllEnvs();
    await rm(setup.root, { recursive: true, force: true });
  }
}, 20_000);
