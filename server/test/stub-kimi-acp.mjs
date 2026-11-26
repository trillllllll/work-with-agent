#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Minimal Kimi Code 2.6.3 ACP fixture. Its store is test-only and does not imitate Kimi's private disk format.
if (process.argv.includes('--version')) {
  console.log('2.6.3');
  process.exit(0);
}
const store = process.env.HARNESS_TEST_KIMI_STORE;
if (!store) throw new Error('HARNESS_TEST_KIMI_STORE is required');
const state = () => existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : { sessions: {} };
const save = data => writeFileSync(store, JSON.stringify(data));
const session = id => state().sessions[id];
const patch = (id, change) => {
  const data = state();
  if (!data.sessions[id]) throw [-32602, `unknown session: ${id}`];
  data.sessions[id] = { ...data.sessions[id], ...change, updatedAt: new Date().toISOString() };
  save(data);
  return data.sessions[id];
};
const modes = currentModeId => ({
  currentModeId,
  availableModes: [
    { id: 'default', name: 'Default', description: 'Manual approvals; tools execute normally.' },
    { id: 'plan', name: 'Plan', description: 'Read-only planning; no tool execution.' },
    { id: 'auto', name: 'Auto', description: 'Auto-approve safe operations.' },
    { id: 'yolo', name: 'YOLO', description: 'Auto-approve everything.' },
  ],
});
const configOptions = current => [
  { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: current.model, options: [
    { value: 'kimi-code/kimi-for-coding', name: 'K2.8 Preview' },
    { value: 'kimi-code/k3.1-pro', name: 'K3.1 Pro' },
  ] },
  { type: 'select', id: 'thinking', name: 'Thinking', category: 'thought_level', currentValue: current.thinking, options: [
    { value: 'low', name: 'Thinking Low' }, { value: 'high', name: 'Thinking High' }, { value: 'max', name: 'Thinking Max' },
  ] },
  { type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: current.mode, options: [
    { value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }, { value: 'auto', name: 'Auto' }, { value: 'yolo', name: 'YOLO' },
  ] },
];
const result = current => ({ sessionId: current.id, configOptions: configOptions(current), modes: modes(current.mode) });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const update = (sessionId, changes) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: changes } });
const requests = new Map();
const textOf = prompt => prompt.filter(part => part.type === 'text').map(part => part.text).join('\n');
const canonical = path => { try { return realpathSync(path); } catch { return path; } };

function replay(current) {
  for (const turn of current.turns) {
    for (const part of turn.user) update(current.id, { sessionUpdate: 'user_message_chunk', content: part });
    update(current.id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<system-reminder>\nfixture only\n</system-reminder>' } });
    for (const item of turn.items) {
      if (item.type === 'thought' || item.type === 'answer') {
        update(current.id, { sessionUpdate: item.type === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: item.text } });
      } else if (item.type === 'tool') {
        update(current.id, { sessionUpdate: 'tool_call', toolCallId: item.id, title: item.title, kind: item.kind,
          status: item.status === 'failed' ? 'failed' : 'completed', rawInput: item.rawInput, rawOutput: item.rawOutput,
          content: item.rawOutput ? [{ type: 'content', content: { type: 'text', text: item.rawOutput } }] : [] });
      } else if (item.type === 'plan') {
        update(current.id, { sessionUpdate: 'plan', entries: item.entries });
      }
    }
  }
}

async function run(sessionId, prompt) {
  let current = session(sessionId);
  if (!current) throw [-32602, `unknown session: ${sessionId}`];
  if (current.running) throw [-32602, 'a prompt is already in flight for this session'];
  const text = textOf(prompt);
  const images = prompt.filter(part => part.type === 'image');
  current = patch(sessionId, { running: true, cancel: false, lastImages: images, title: current.title || text.slice(0, 80) });
  update(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 1048576 });
  const items = [];
  let stopReason = 'end_turn';
  if (process.env.HARNESS_TEST_KIMI_ASK === '1') {
    const toolCallId = '0:tool_fixture';
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'Bash', kind: 'execute', status: 'pending', content: [] });
    const outcome = await new Promise(resolve => {
      const requestId = randomUUID();
      requests.set(requestId, resolve);
      send({ jsonrpc: '2.0', id: requestId, method: 'session/request_permission', params: {
        sessionId, toolCall: { toolCallId, title: 'Bash', content: [{ type: 'content', content: { type: 'text', text: 'Requesting approval to Running: printf hello' } }] },
        options: [
          { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
          { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      } });
    });
    const allowed = outcome?.outcome?.optionId === 'approve_once' || outcome?.outcome?.optionId === 'approve_always';
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: allowed ? 'completed' : 'failed',
      rawInput: { command: 'printf hello' }, rawOutput: allowed ? 'hello' : 'rejected', content: [{ type: 'content', content: { type: 'text', text: allowed ? 'hello' : 'rejected' } }] });
    items.push({ type: 'tool', id: '1:tool_fixture', kind: 'execute', title: 'Running: printf hello', status: allowed ? 'completed' : 'failed',
      rawInput: { command: 'printf hello' }, rawOutput: allowed ? 'hello' : 'rejected' });
  }
  if (process.env.HARNESS_TEST_KIMI_HOLD === '1') {
    for (let attempt = 0; attempt < 1200 && !session(sessionId).cancel; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    if (session(sessionId).cancel) stopReason = 'cancelled';
  }
  const answer = stopReason === 'cancelled' ? '已打断' : images.length ? 'Kimi stub 收到图片' : 'Kimi stub 记得 ' + text;
  if (stopReason !== 'cancelled') {
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先核对请求' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer.slice(0, 5) } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer.slice(5) } });
  }
  items.push({ type: 'thought', text: '先核对请求' }, { type: 'answer', text: answer });
  patch(sessionId, { running: false, turns: [...session(sessionId).turns, {
    status: stopReason === 'cancelled' ? 'interrupted' : 'completed', user: prompt.filter(part => part.type === 'text'), items,
  }] });
  return stopReason;
}

const request = {
  initialize: async () => ({
    protocolVersion: 1, agentInfo: { name: 'Kimi Code CLI', version: '2.6.3' },
    agentCapabilities: {
      loadSession: true, promptCapabilities: { image: process.env.HARNESS_TEST_KIMI_NO_IMAGE !== '1', audio: false, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, fork: {}, additionalDirectories: {} },
      mcpCapabilities: { http: true, sse: true },
    }, authMethods: [],
  }),
  'session/new': async ({ cwd }) => {
    const id = 'session_' + randomUUID();
    const data = state();
    data.sessions[id] = { id, cwd, title: null, updatedAt: new Date().toISOString(), model: 'kimi-code/k3.1-pro', thinking: 'high', mode: 'default', turns: [], running: false };
    save(data);
    return result(data.sessions[id]);
  },
  'session/list': async ({ cwd }) => ({ sessions: Object.values(state().sessions)
    .filter(current => !cwd || canonical(current.cwd) === canonical(cwd))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .map(current => ({ sessionId: current.id, cwd: current.cwd, title: current.title, updatedAt: current.updatedAt })) }),
  'session/resume': async ({ sessionId, cwd }) => {
    const current = session(sessionId);
    if (!current) throw [-32602, `unknown session: ${sessionId}`];
    if (canonical(current.cwd) !== canonical(cwd)) throw [-32602, 'session cwd does not match'];
    if ((process.env.HARNESS_TEST_KIMI_LOCKED ?? '').split(',').includes(sessionId)) throw [-32602, 'session is already in flight'];
    return result(current);
  },
  'session/load': async ({ sessionId, cwd }) => {
    const current = session(sessionId);
    if (!current) throw [-32602, `unknown session: ${sessionId}`];
    if (canonical(current.cwd) !== canonical(cwd)) throw [-32602, 'session cwd does not match'];
    replay(current);
    return result(current);
  },
  'session/fork': async ({ sessionId }) => {
    const source = session(sessionId);
    if (!source) throw [-32602, `unknown session: ${sessionId}`];
    const id = 'session_' + randomUUID();
    const data = state();
    data.sessions[id] = { ...structuredClone(source), id, title: (source.title || 'Kimi Code 会话') + ' 分支', running: false };
    save(data);
    return result(data.sessions[id]);
  },
  'session/set_config_option': async ({ sessionId, configId, value }) => {
    if (!['model', 'thinking', 'mode'].includes(configId)) throw [-32602, 'unknown config option'];
    const current = patch(sessionId, { [configId]: value });
    return { configOptions: configOptions(current) };
  },
  'session/set_mode': async ({ sessionId, modeId }) => {
    if (!['default', 'plan', 'auto', 'yolo'].includes(modeId)) throw [-32602, 'unknown mode'];
    patch(sessionId, { mode: modeId });
    return {};
  },
  'session/delete': async ({ sessionId }) => {
    const data = state();
    delete data.sessions[sessionId];
    save(data);
    return {};
  },
  'session/close': async () => ({}),
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let end = input.indexOf('\n');
  while (end !== -1) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    end = input.indexOf('\n');
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (typeof message.method !== 'string') {
      requests.get(message.id)?.(message.result ?? { outcome: { outcome: 'cancelled' } });
      requests.delete(message.id);
      continue;
    }
    const params = message.params ?? {};
    if (message.id === undefined) {
      if (message.method === 'session/cancel' && session(params.sessionId)) patch(params.sessionId, { cancel: true });
    } else if (message.method === 'session/prompt') {
      void run(params.sessionId, params.prompt ?? []).then(
        stopReason => send({ jsonrpc: '2.0', id: message.id, result: { stopReason } }),
        failure => send({ jsonrpc: '2.0', id: message.id, error: { code: failure?.[0] ?? -32603, message: failure?.[1] ?? String(failure) } }),
      );
    } else {
      void Promise.resolve().then(() => {
        if (!request[message.method]) throw [-32601, `Method not found: ${message.method}`];
        return request[message.method](params);
      }).then(value => send({ jsonrpc: '2.0', id: message.id, result: value }),
        failure => send({ jsonrpc: '2.0', id: message.id, error: { code: failure?.[0] ?? -32603, message: failure?.[1] ?? String(failure), data: failure?.[2] } }));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
