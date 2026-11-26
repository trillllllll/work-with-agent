#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendRecords, projection, sessionDirectory, writeSession } from './dsh-fixtures.mjs';

// A minimal `dsh --profile acp` for executor tests: the ACP subset probed on 0.2.2-rc.5, the same on-disk
// session layout, and a stand-in for the bridge plugin that connects back to the executor's socket.
//   HARNESS_TEST_DSH_STORE       file for the stub's own state (required)
//   DSH_HOME                     where sessions are written, in dsh's real layout
//   HARNESS_TEST_DSH_LOCKED      comma-separated session ids that behave as held by another process
//   HARNESS_TEST_DSH_ASK         make every prompt run a bash tool that asks for approval
//   HARNESS_TEST_DSH_HOLD        keep an approved turn running until it is cancelled or the gate file appears
//   HARNESS_TEST_DSH_NO_BRIDGE   never connect to the bridge socket
if (process.argv.includes('--version')) {
  console.log('0.2.2-rc.5');
  process.exit(0);
}

const store = process.env.HARNESS_TEST_DSH_STORE;
const home = process.env.DSH_HOME;
const PRESETS = ['read-only', 'workspace-write', 'danger-full-access'];
const policyOf = (preset) => preset === 'danger-full-access' ? 'never' : 'ask';
const model = (id) => JSON.stringify(['stub', id]);
const CATALOG = [
  { value: model('stub-model'), label: 'Stub Model', provider: 'Stub', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' },
  { value: model('stub-lite'), label: 'Stub Lite', provider: 'Stub', efforts: ['low', 'high'], defaultEffort: 'low' },
];
const state = () => (existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : { sessions: {} });
const save = (data) => writeFileSync(store, JSON.stringify(data));
/** A session that exists on disk but not in the stub's state yet is adopted with what a resumed session starts from. */
function adopted(id) {
  const file = join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`);
  if (!existsSync(file)) return undefined;
  const { record } = JSON.parse(readFileSync(file, 'utf8'));
  const current = { id, cwd: record.identity.cwd, model: model('stub-model'), effort: 'high', preset: record.rows.permissions.val.preset,
    createdAt: record.identity.createdAt, title: record.rows.title.val, lastPromptAt: record.rows.sessionListMetadata.val.lastPromptAt,
    turn: 0, step: 0, running: false };
  save({ ...state(), sessions: { ...state().sessions, [id]: current } });
  return current;
}
const session = (id) => state().sessions[id] ?? adopted(id);
const patch = (id, change) => {
  const data = state();
  Object.assign(data.sessions[id], change);
  save(data);
  return data.sessions[id];
};
const textOf = (prompt) => prompt.filter((part) => part.type === 'text').map((part) => part.text).join('\n');

/** Append one durable record the way dsh does, then refresh the projection cache that titles come from. */
const record = (current, row) => {
  appendRecords(sessionDirectory(home, current.cwd, current.id), [row]);
  const asked = row.type === 'user/message';
  const latest = patch(current.id, asked
    ? { title: row.data.content.map((part) => part.text).join(' '), lastPromptAt: Date.now() }
    : {});
  const projections = join(home, 'storages', 'session_projcache', 'sessions');
  mkdirSync(projections, { recursive: true });
  writeFileSync(join(projections, `${latest.id}.json`), JSON.stringify(projection(latest.cwd, {
    title: latest.title, lastPromptAt: latest.lastPromptAt, preset: latest.preset, createdAt: latest.createdAt,
  })));
};

const configOptions = (current) => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current.model,
    options: [{ group: 'stub', name: 'Stub', options: CATALOG.map(({ value, label }) => ({ value, name: label })) }] },
  { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: current.effort,
    options: ['off', 'low', 'high', 'max'].map((id) => ({ value: id, name: id[0].toUpperCase() + id.slice(1) })) },
];

const setConfig = (current, { configId, value }) => {
  if (configId === 'model' && !CATALOG.some((item) => item.value === value)) throw [-32602, `Invalid params: unknown model option: ${value}`];
  if (configId === 'reasoning_effort' && !['off', 'low', 'high', 'max'].includes(value)) throw [-32602, `Invalid params: unknown reasoning effort: ${value}`];
  patch(current.id, configId === 'model' ? { model: value } : { effort: value });
  const [provider, name] = JSON.parse(session(current.id).model);
  record(current, { type: 'model/selection', data: { provider, model: name, reasoningEffort: session(current.id).effort } });
  return { configOptions: configOptions(session(current.id)) };
};

// ---- ACP over stdio ----
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const update = (sessionId, changes) => send({ method: 'session/update', params: { sessionId, update: changes } });
const waiting = new Map(); // tool call id -> resolve(outcome)
const requests = new Map(); // permission request id -> tool call id

let socket = null;
const toBridge = (message) => { if (socket?.writable) socket.write(JSON.stringify(message) + '\n'); };

/** One committed assistant message, published the way dsh does: streamed, then durable, then sent over ACP. */
async function stream(current, text, tools) {
  const messageId = 'msg_' + randomUUID().slice(0, 8);
  toBridge({ event: 'stream-start', sessionId: current.id, turn: current.turn, step: current.step });
  const cut = Math.max(1, Math.floor(text.length / 2));
  for (const piece of [text.slice(0, cut), text.slice(cut)]) toBridge({ event: 'text-delta', sessionId: current.id, index: 0, text: piece });
  const content = [{ type: 'text', text }];
  if (tools) content.push({ type: 'tool-call', id: 'call_pending', name: 'bash', arguments: '{}' });
  record(current, { type: 'assistant/message', data: { turn: current.turn, step: current.step, usage: { inputTokens: 900, outputTokens: 20 },
    message: { id: messageId, role: 'assistant', content } } });
  toBridge({ event: 'message', sessionId: current.id, messageId, turn: current.turn, step: current.step, tools, texts: [{ index: 0, text }] });
  // The stock plugin sends a committed message over ACP only after it has notified its own listeners.
  update(current.id, { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } });
  toBridge({ event: 'stream-end', sessionId: current.id, outcome: 'committed' });
}

async function run(id, text) {
  const found = session(id);
  if (!found) throw [-32602, `unknown session: ${id}`];
  if (found.running) throw [-32602, 'a prompt is already in flight for this session'];
  let current = patch(id, { running: true, turn: found.turn + 1, step: 0, cancel: false });
  record(current, { type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'user_' + randomUUID().slice(0, 8) } });
  record(current, { type: 'turn/start', data: { turn: current.turn } });
  update(id, { sessionUpdate: 'usage_update', used: 1_200, size: 1_000_000 });
  if (process.env.HARNESS_TEST_DSH_ASK === '1') {
    // A step that calls a tool is its own message; its text is commentary before the answer.
    await stream(current, '先打印问候', true);
    current = patch(id, { step: current.step + 1 });
    const callId = 'call_' + randomUUID().slice(0, 8);
    update(id, { sessionUpdate: 'tool_call', toolCallId: callId, title: 'bash', kind: 'other', status: 'in_progress',
      rawInput: { description: '打印问候', command: 'printf hello' } });
    record(current, { type: 'tool/call', data: { turn: current.turn, step: current.step, callId, name: 'bash',
      arguments: JSON.stringify({ description: '打印问候', command: 'printf hello' }) } });
    const reply = await new Promise((resolve) => {
      waiting.set(callId, resolve);
      const requestId = randomUUID();
      requests.set(requestId, callId);
      send({ id: requestId, method: 'session/request_permission', params: { sessionId: id, toolCall: { toolCallId: callId },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } });
    });
    const allowed = reply?.outcome?.optionId === 'allow-once';
    if (process.env.HARNESS_TEST_DSH_HOLD === '1' && allowed) {
      const gate = store + '.gate';
      for (let attempt = 0; attempt < 1_200 && !session(id).cancel && !existsSync(gate); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (session(id).cancel) {
        // dsh records a stopped call as an aborted tool result and the turn as `aborted`.
        update(id, { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'failed', content: [] });
        record(current, { type: 'tool/result', data: { turn: current.turn, step: current.step, error: { name: 'AbortError', code: 'ABORTED' },
          message: { source: { kind: 'tool', callId }, role: 'tool', id: 'result_' + randomUUID().slice(0, 8),
            content: [{ type: 'text', toolCallId: callId, content: { type: 'text', text: 'Error: tool call aborted' }, isError: true }] } } });
        record(current, { type: 'turn/end', data: { turn: current.turn, reason: { kind: 'aborted' } } });
        patch(id, { running: false });
        return 'cancelled';
      }
    }
    update(id, { sessionUpdate: 'tool_call_update', toolCallId: callId, status: allowed ? 'completed' : 'failed',
      content: allowed ? [{ type: 'content', content: { type: 'text', text: 'hello' } }] : [] });
    record(current, { type: 'tool/result', data: { turn: current.turn, step: current.step,
      message: { source: { kind: 'tool', callId }, role: 'tool', id: 'result_' + randomUUID().slice(0, 8),
        content: [{ type: 'text', toolCallId: callId, content: { type: 'text', text: allowed ? 'hello' : 'rejected' }, isError: !allowed }] } } });
    current = patch(id, { step: current.step + 1 });
  }
  await stream(current, 'DSH stub 记得 ' + text, false);
  record(current, { type: 'turn/end', data: { turn: current.turn, reason: { kind: 'completed' } } });
  patch(id, { running: false });
  return 'end_turn';
}

const request = {
  initialize: async () => ({
    protocolVersion: 1,
    agentInfo: { name: 'stub-dsh-acp', version: '0.0.0' },
    agentCapabilities: { mcpCapabilities: { http: true }, promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { close: {}, list: {}, resume: {} } },
    authMethods: [],
  }),
  'session/new': async ({ cwd }) => {
    const id = 'session-' + randomUUID();
    const createdAt = Date.now();
    save({ ...state(), sessions: { ...state().sessions, [id]: {
      id, cwd, model: model('stub-model'), effort: 'high', preset: 'workspace-write', createdAt, title: '', lastPromptAt: 0, turn: 0, step: 0, running: false,
    } } });
    // A new session records the preset of its launch before it can be resumed.
    writeSession(home, { cwd, id, records: [{ type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 }] });
    record(session(id), { type: 'permission/preset', data: { preset: 'workspace-write' } });
    record(session(id), { type: 'sandbox/mode', data: { mode: 'workspace-write' } });
    record(session(id), { type: 'approval/policy', data: { policy: 'ask' } });
    return { sessionId: id, configOptions: configOptions(session(id)) };
  },
  'session/resume': async ({ sessionId, cwd }) => {
    const current = session(sessionId);
    if (!current) throw [-32602, `session is not resumable: ${sessionId}`];
    if (cwd !== current.cwd) throw [-32602, `session cwd does not match: ${cwd}`];
    if ((process.env.HARNESS_TEST_DSH_LOCKED ?? '').split(',').includes(sessionId)) {
      throw [-32603, 'Internal error', { details: `session "${sessionId}" is already owned by an active write handle` }];
    }
    if (current.running) throw [-32602, `session is already active: ${sessionId}`];
    return { configOptions: configOptions(current) };
  },
  'session/set_config_option': async ({ sessionId, configId, value }) => setConfig(session(sessionId), { configId, value }),
  'session/close': async () => ({}),
};

const notification = {
  'session/cancel': ({ sessionId }) => { if (session(sessionId)) patch(sessionId, { cancel: true }); },
};

// ---- the stand-in for the bridge plugin ----
const patchIndex = process.argv.indexOf('--patch');
const overlay = patchIndex === -1 ? '' : readFileSync(process.argv[patchIndex + 1], 'utf8');
const setting = (key) => JSON.parse(new RegExp(`^\\s*${key}: (.+)$`, 'm').exec(overlay)[1]);
if (process.env.HARNESS_TEST_DSH_NO_BRIDGE !== '1' && overlay) {
  socket = connect(setting('socket'));
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('connect', () => socket.write(JSON.stringify({ hello: setting('token') }) + '\n'));
  socket.on('error', () => undefined);
  socket.on('data', (chunk) => {
    buffer += chunk;
    let end = buffer.indexOf('\n');
    while (end !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf('\n');
      let call;
      try { call = JSON.parse(line); } catch { continue; }
      const params = call.params ?? {};
      const current = session(params.sessionId);
      const set = PRESETS.includes(params.preset);
      const answer = call.method === 'ping' ? {}
        : call.method === 'catalog' ? { models: CATALOG }
        : call.method === 'permission.current' && current ? { current: current.preset, options: PRESETS }
        : call.method === 'permission.set' && current && set ? (() => {
          // The stock service records a preset change as three durable records.
          for (const [type, key, value] of [['permission/preset', 'preset', params.preset], ['sandbox/mode', 'mode', params.preset],
            ['approval/policy', 'policy', policyOf(params.preset)]]) record(current, { type, data: { [key]: value } });
          return { current: patch(current.id, { preset: params.preset }).preset };
        })()
        : null;
      socket.write(JSON.stringify(answer ? { id: call.id, result: answer } : { id: call.id, error: 'unsupported bridge request' }) + '\n');
    }
  });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let end = input.indexOf('\n');
  while (end !== -1) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    end = input.indexOf('\n');
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (typeof message.method !== 'string') {
      // A response to the stub's own permission request settles the tool that is waiting for it.
      const pending = requests.get(message.id);
      if (pending) waiting.get(pending)?.(message.result ?? { outcome: { outcome: 'cancelled' } });
      continue;
    }
    const params = message.params ?? {};
    if (message.id === undefined) {
      void notification[message.method]?.(params);
    } else if (message.method === 'session/prompt') {
      // A prompt settles only when its turn ends, so its reply goes out later under the saved request id.
      void run(params.sessionId, textOf(params.prompt ?? [])).then(
        (stopReason) => send({ id: message.id, result: { stopReason } }),
        (failure) => send({ id: message.id, error: { code: failure?.[0] ?? -32603, message: failure?.[1] ?? String(failure) } }),
      );
    } else {
      void Promise.resolve().then(() => {
        if (!request[message.method]) throw [-32601, `Method not found: ${message.method}`];
        return request[message.method](params);
      }).then((result) => send({ id: message.id, result }),
        (failure) => send({ id: message.id, error: { code: failure?.[0] ?? -32603, message: failure?.[1] ?? String(failure), data: failure?.[2] } }));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
