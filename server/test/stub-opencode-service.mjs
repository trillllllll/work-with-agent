#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// A minimal OpenCode shared service for executor tests: the same HTTP and SSE surface probed on 2.3.2.
if (process.argv.includes('--version')) {
  console.log('opencode v2.3.2');
  process.exit(0);
}
const storePath = process.env.HARNESS_TEST_OPENCODE_STORE;
const read = () => (existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : { sessions: [], counters: {} });
const save = (data) => writeFileSync(storePath, JSON.stringify(data));

const portArg = process.argv.find((argument) => argument.startsWith('--port='));
const port = Number(portArg?.slice('--port='.length) ?? 0);
const subscribers = new Set();
const waiting = new Map(); // permission id -> resolve(decision)
const pendingPermissions = new Map();
const approvedProjects = new Set();
let dropPromptResponse = process.env.HARNESS_TEST_OPENCODE_DROP === '1';

const emit = (event) => {
  const frame = `data: ${JSON.stringify({ id: 'evt_' + randomUUID(), ...event })}\n\n`;
  for (const subscriber of subscribers) subscriber.write(frame);
};

const message = (id, type, extra = {}) => ({ id, type, time: { created: Date.now() }, ...extra });

const isRunning = (sessionId) => read().sessions.find((row) => row.id === sessionId)?.running === true;

async function run(sessionId, text) {
  {
    const data = read();
    const row = data.sessions.find((row2) => row2.id === sessionId);
    row.running = true;
    row.time.busy = Date.now();
    save(data);
  }
  emit({ type: 'session.execution.started', data: { sessionID: sessionId } });
  if (text === '模拟 OpenCode 执行失败') {
    // Let turn/start bind the original prompt before delivering the terminal event.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const data = read();
    const row = data.sessions.find((item) => item.id === sessionId);
    row.running = false;
    row.outcome = 'failed';
    row.time.updated = row.time.idle = Date.now();
    row.messages.push(message('msg_idle_' + randomUUID().slice(0, 8), 'idle', { outcome: 'failed' }));
    save(data);
    emit({ type: 'session.execution.failed', data: { sessionID: sessionId } });
    return;
  }
  const assistant = 'msg_run_' + randomUUID().slice(0, 8);
  {
    const data = read();
    data.sessions.find((row) => row.id === sessionId).messages.push(message(assistant, 'assistant', {
      agent: 'build', model: { id: 'stub-model', providerID: 'opencode' }, content: [],
    }));
    save(data);
  }
  emit({ type: 'session.step.started', data: { sessionID: sessionId, assistantMessageID: assistant, agent: 'build',
    model: { id: 'stub-model', providerID: 'opencode' } } });
  emit({ type: 'session.text.started', data: { sessionID: sessionId, assistantMessageID: assistant, ordinal: 0 } });
  emit({ type: 'session.text.delta', data: { sessionID: sessionId, assistantMessageID: assistant, ordinal: 0,
    delta: 'OpenCode stub 记得 ' + text } });
  const content = [{ type: 'text', text: 'OpenCode stub 记得 ' + text }];
  const project = read().sessions.find((row) => row.id === sessionId)?.location.directory;
  if (process.env.HARNESS_TEST_OPENCODE_ASK && !approvedProjects.has(project)) {
    const permission = 'per_' + randomUUID().slice(0, 8);
    const request = { id: permission, sessionID: sessionId, action: 'shell', resources: ['printf hello'],
      save: ['printf hello'], source: { type: 'tool', messageID: assistant, id: 'call_shell' } };
    pendingPermissions.set(permission, request);
    emit({ type: 'permission.asked', data: request });
    const decision = await new Promise((resolve) => waiting.set(permission, resolve));
    pendingPermissions.delete(permission);
    if (!isRunning(sessionId)) return;
    if (decision === 'always') approvedProjects.add(project);
    const call = 'call_' + randomUUID().slice(0, 8);
    emit({ type: 'session.tool.called', data: { sessionID: sessionId, assistantMessageID: assistant,
      id: call, name: 'shell', input: { command: 'printf hello' } } });
    if (process.env.HARNESS_TEST_OPENCODE_HOLD) {
      const gate = storePath + '.gate';
      for (let attempt = 0; !existsSync(gate) && attempt < 600 && isRunning(sessionId); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!isRunning(sessionId)) return;
    }
    emit({ type: 'session.tool.success', data: { sessionID: sessionId, assistantMessageID: assistant, id: call,
      content: [{ type: 'text', text: decision + '：hello' }], metadata: { exit: 0 } } });
    content.push({ type: 'tool', id: call, name: 'shell', executed: true,
      state: { status: 'completed', input: { command: 'printf hello' }, content: [{ type: 'text', text: 'hello' }], metadata: { exit: 0 } } });
  }
  emit({ type: 'session.text.ended', data: { sessionID: sessionId, assistantMessageID: assistant, ordinal: 0,
    text: 'OpenCode stub 记得 ' + text } });
  {
    const data = read();
    const row = data.sessions.find((row2) => row2.id === sessionId);
    row.messages.find((row2) => row2.id === assistant).content = content;
    row.running = false;
    row.outcome = 'succeeded';
    row.time.idle = Date.now();
    row.time.updated = Date.now();
    row.title = 'Stub 对话';
    save(data);
  }
  emit({ type: 'session.execution.succeeded', data: { sessionID: sessionId } });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const body = await new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => resolve(raw ? JSON.parse(raw) : null));
  });
  const send = (status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(payload === undefined ? '' : JSON.stringify(payload));
  };
  const segments = () => url.pathname.split('/');
  const find = () => read().sessions.find((row) => row.id === segments()[3]);

  if (request.method === 'GET' && url.pathname === '/api/info') {
    return send(200, { version: '2.3.2', pid: process.pid, urls: [`http://127.0.0.1:${server.address().port}`] });
  }
  if (request.method === 'GET' && url.pathname === '/api/event') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ id: 'evt_hello', type: 'server.connected', data: {} }) + '\n\n');
    subscribers.add(response);
    response.on('close', () => subscribers.delete(response));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/session/active') {
    return send(200, { data: Object.fromEntries(read().sessions.filter((row) => row.running).map((row) => [row.id, { type: 'run' }])) });
  }
  if (request.method === 'POST' && url.pathname === '/api/session') {
    const data = read();
    const id = 'ses_test_' + (data.counters.session = (data.counters.session ?? 0) + 1);
    data.sessions.push({ id, projectID: 'proj_' + (body?.location?.directory ?? '').length, title: '',
      agent: null, model: { id: 'stub-model', providerID: 'opencode' }, outcome: null, running: false, messages: [],
      location: { directory: body?.location?.directory ?? '' }, permissions: [],
      time: { created: Date.now(), updated: Date.now() } });
    save(data);
    emit({ type: 'session.created', data: { sessionID: id, version: '2.3.2' } });
    return send(200, { data: data.sessions.find((row) => row.id === id) });
  }
  if (request.method === 'GET' && url.pathname === '/api/session') {
    const directory = url.searchParams.get('directory');
    const cursor = url.searchParams.get('cursor');
    let rows = read().sessions.filter((row) => !directory || row.location.directory === directory);
    if (cursor) {
      const at = rows.findIndex((row) => row.id === cursor);
      rows = at === -1 ? [] : rows.slice(at);
    }
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const page = rows.slice(0, limit);
    return send(200, { data: page.map(({ messages, running, ...row }) => row),
      cursor: { previous: null, next: rows.length > limit ? rows[limit].id : null } });
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/session/') && url.pathname.endsWith('/message')) {
    const row = find();
    if (!row) return send(404, { _tag: 'SessionNotFoundError', sessionID: segments()[3], message: 'Session not found' });
    const cursor = url.searchParams.get('cursor');
    let rows = [...row.messages].reverse();
    if (cursor) {
      const at = rows.findIndex((message) => message.id === cursor);
      rows = at === -1 ? [] : rows.slice(at);
    }
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const page = rows.slice(0, limit);
    return send(200, { data: page, cursor: { previous: page.at(-1)?.id ?? null, next: rows.length > limit ? rows[limit].id : null } });
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/session/') && url.pathname.endsWith('/prompt')) {
    const row = find();
    if (!row) return send(404, { _tag: 'SessionNotFoundError', sessionID: segments()[3], message: 'Session not found' });
    const existing = row.messages.find((message) => message.id === body.id);
    if (existing) return send(200, { data: { id: existing.id, sessionID: row.id, time: existing.time,
      type: 'user', payload: { text: existing.text }, delivery: 'steer' } });
    {
      const data = read();
      const current = data.sessions.find((row2) => row2.id === row.id);
      current.messages.push(message(body.id, 'user', { text: body.text }));
      current.time.updated = Date.now();
      save(data);
    }
    emit({ type: 'session.inbox.enqueued', data: { sessionID: row.id, inboxID: body.id } });
    void run(row.id, body.text);
    if (dropPromptResponse) {
      dropPromptResponse = false;
      return response.destroy();
    }
    return send(200, { data: { id: body.id, sessionID: row.id, time: { created: Date.now() },
      type: 'user', payload: { text: body.text }, delivery: isRunning(row.id) ? 'queue' : 'steer' } });
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/session/') && url.pathname.endsWith('/interrupt')) {
    const row = find();
    if (!row) return send(404, { _tag: 'SessionNotFoundError', sessionID: segments()[3], message: 'Session not found' });
    if (row.running) {
      {
        const data = read();
        const current = data.sessions.find((row2) => row2.id === row.id);
        current.running = false;
        current.outcome = 'interrupted';
        current.messages.push(message('msg_idle_' + randomUUID().slice(0, 8), 'idle', { outcome: 'interrupted' }));
        save(data);
      }
      emit({ type: 'session.execution.interrupted', data: { sessionID: row.id, reason: 'user' } });
      for (const [id, pending] of pendingPermissions) {
        if (pending.sessionID !== row.id) continue;
        waiting.get(id)?.('reject');
        waiting.delete(id);
      }
    }
    return send(200, { interrupted: true });
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/session/') && url.pathname.endsWith('/permission')) {
    const row = find();
    if (!row) return send(404, { _tag: 'SessionNotFoundError' });
    return send(200, { data: [...pendingPermissions.values()].filter((pending) => pending.sessionID === row.id) });
  }
  if (request.method === 'POST' && url.pathname.includes('/permission/')) {
    const requestId = segments()[5];
    const resolve = waiting.get(requestId);
    waiting.delete(requestId);
    if (resolve) resolve(body.decision);
    emit({ type: 'permission.replied', data: { sessionID: segments()[3], requestID: requestId, reply: body.decision } });
    return send(204);
  }
  if (request.method === 'POST' && (url.pathname.endsWith('/model') || url.pathname.endsWith('/agent'))) {
    const data = read();
    const row = data.sessions.find((row2) => row2.id === segments()[3]);
    if (!row) return send(404, { _tag: 'SessionNotFoundError', sessionID: segments()[3], message: 'Session not found' });
    if (url.pathname.endsWith('/model')) row.model = body.model;
    else row.agent = body.agent;
    save(data);
    return send(204);
  }
  if (request.method === 'GET' && url.pathname === '/api/model') {
    return send(200, { data: [
      { id: 'stub-model', name: 'Stub Model', providerID: 'opencode', enabled: true,
        variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }, { id: 'high', settings: { reasoningEffort: 'high' } }] },
      { id: 'stub-plain', name: 'Stub Plain', providerID: 'opencode', enabled: true },
    ] });
  }
  if (request.method === 'GET' && url.pathname === '/api/agent') {
    return send(200, { data: [{ id: 'build', name: 'Build', mode: 'primary' }, { id: 'plan', name: 'Plan', mode: 'primary' }] });
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/session/')) {
    const row = find();
    if (!row) return send(404, { _tag: 'SessionNotFoundError', sessionID: segments()[3], message: 'Session not found' });
    const { messages, running, ...session } = row;
    return send(200, { data: session });
  }
  send(404, { message: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
