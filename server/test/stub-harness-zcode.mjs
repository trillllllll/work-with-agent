import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const output = (value) => console.log(JSON.stringify(value));
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.18.0');
  process.exit();
}

const store = process.env.HARNESS_TEST_ZCODE_STORE;
const read = () => JSON.parse(readFileSync(store, 'utf8'));
const save = (data) => writeFileSync(store, JSON.stringify(data));

const promptArgument = args.find((argument) => argument.startsWith('--prompt='));
if (promptArgument !== undefined) {
  const threadId = args[args.indexOf('--resume') + 1];
  const prompt = promptArgument.slice('--prompt='.length);
  const db = new DatabaseSync(process.env.ZCODE_SESSION_DB_PATH, { readOnly: true });
  const row = db.prepare('SELECT permission FROM session WHERE id=?').get(threadId);
  db.close();
  const expectedMode = JSON.parse(row.permission ?? '{}').mode === 'plan' ? 'plan' : 'build';
  if (args[args.indexOf('--mode') + 1] !== expectedMode) throw new Error('ZCode changed the expected permission mode');
  const data = read();
  const original = data.find((session) => session.sessionId === threadId);
  if (!original) throw new Error('ZCode resumed a different session');
  const turnId = 'turn-' + (original.rows.length + 1);
  const text = 'ZCode remembers ' + original.rows.find((row) => row.kind === 'userInput')?.text + ' · ' + prompt;
  const event = (type, payload) => output({ type, sessionId: threadId, turnId, payload });
  event('turn.started');
  const toolCallId = 'local-command';
  const command = 'printf fixture';
  event('tool.updated', { kind: 'scheduled', toolCallId, toolName: 'Bash', input: { command } });
  event('tool.updated', { kind: 'started', toolCallId });
  event('tool.updated', { kind: 'progress', toolCallId, outputPreview: { fullText: '正在执行命令', totalLines: 1 } });
  const gate = process.env.HARNESS_TEST_ZCODE_TOOL_FINISH;
  for (let attempt = 0; gate && !existsSync(gate) && attempt < 180; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  event('tool.updated', { kind: 'result', toolCallId, result: { success: true, content: '命令执行完成' } });
  event('model.streaming', { kind: 'text_delta', delta: text });
  original.rows.push(
    { rowId: original.rows.length + 1, kind: 'turnHeader', state: 'completedSuccess', turnId: 'stored-' + turnId },
    { rowId: original.rows.length + 2, kind: 'userInput', entityId: turnId + ':native-input', text: prompt, turnId: 'stored-' + turnId },
    { rowId: original.rows.length + 3, kind: 'toolCall', entityId: turnId + ':native-tool', turnId: 'stored-' + turnId,
      toolName: 'Bash', input: { command }, status: 'success', output: { text: '命令执行完成' } },
    { rowId: original.rows.length + 4, kind: 'assistantText', entityId: turnId + ':native-answer', text, turnId: 'stored-' + turnId },
  );
  save(data);
  output({ type: 'result', sessionId: threadId, turnId, response: text });
  process.exit();
}

const subscriptions = new Map();
const defaultConfig = { provider: 'fixture', model: 'model-a', thought: '', mode: 'build', planEnabled: false };
const modelOptions = ['model-a', 'model-b'].map((modelId, index) => ({
  ref: { providerId: index ? 'account:fixture-coding-plan' : 'fixture', modelId },
  label: 'Fixture ZCode ' + (index ? 'B' : 'A'),
}));

function publish(session) {
  const topic = 'conversation/' + session.sessionId;
  const subscriptionId = subscriptions.get(topic);
  if (!subscriptionId) return;
  output({ method: 'v4/conversation/frame', params: { wireVersion: 3, kind: 'complete', topic, subscriptionId, frame: {
    topic, subscriptionId, fromSeq: 0, toSeq: session.revision ?? 0, payload: { kind: 'snapshot', snapshot: {
      sessionId: session.sessionId, revision: session.revision ?? 0, config: session.config ?? defaultConfig,
      rows: { window: session.rows }, pendingInteractions: [],
    } },
  } } });
}

async function liveTurn(sessionId, commandId, prompt) {
  const data = read();
  const session = data.find((item) => item.sessionId === sessionId);
  const rowId = Math.max(0, ...session.rows.map((row) => row.rowId)) + 1;
  const turnId = 'stored-turn-' + rowId;
  session.rows.push(
    { rowId, kind: 'turnHeader', state: 'running', turnId },
    { rowId: rowId + 1, kind: 'userInput', text: prompt, turnId, sourceCommandId: commandId },
    { rowId: rowId + 2, kind: 'toolCall', toolName: 'Bash', input: { command: 'printf fixture' },
      status: 'running', outputPreview: { fullText: '正在执行命令', totalLines: 1 }, turnId },
  );
  session.revision = (session.revision ?? 0) + 1;
  save(data);
  publish(session);
  const gate = process.env.HARNESS_TEST_ZCODE_TOOL_FINISH;
  for (let attempt = 0; gate && !existsSync(gate) && attempt < 180; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const updated = read();
  const current = updated.find((item) => item.sessionId === sessionId);
  current.rows.find((row) => row.rowId === rowId).state = 'completedSuccess';
  const tool = current.rows.find((row) => row.rowId === rowId + 2);
  Object.assign(tool, { status: 'success', output: { text: '命令执行完成' } });
  delete tool.outputPreview;
  const answer = 'ZCode remembers ' + current.rows.find((row) => row.kind === 'userInput')?.text + ' · ' + prompt;
  current.rows.push({ rowId: rowId + 3, kind: 'assistantText', text: answer, turnId });
  current.revision++;
  save(updated);
  publish(current);
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  const data = read();
  let result;
  let notify;
  if (method === 'session/list') {
    const sameProject = ({ workspace, sessionId }) =>
      (!params.workspace || params.workspace.workspacePath === workspace.workspacePath) &&
      (!params.sessionIds || params.sessionIds.includes(sessionId));
    result = { sessions: data.filter(sameProject).slice(0, params.limit).map(({ rows, ...session }) => session) };
  }
  if (method === 'v4/conversation/subscribe' && params.historyFirst) result = { ack: { topic: params.topic } };
  if (method === 'session/resume') {
    const session = data.find(({ sessionId }) => sessionId === params.sessionId);
    if (session) result = { session: { sessionId: session.sessionId }, settings: { model: { available: modelOptions } } };
  }
  if (method === 'provider/refreshRegistry') result = {};
  if (method === 'v4/conversation/subscribe' && !params.historyFirst || method === 'v4/conversation/resync') {
    const session = data.find(({ sessionId }) => params.topic === 'conversation/' + sessionId);
    if (session) {
      const subscriptionId = subscriptions.get(params.topic) ?? 'subscription-' + session.sessionId;
      subscriptions.set(params.topic, subscriptionId);
      result = { ack: { subscriptionId } };
      notify = () => publish(session);
    }
  }
  if (method === 'v4/command') {
    const session = data.find(({ sessionId }) => sessionId === params.sessionId);
    if (session) {
      const { commandId, type, payload } = params;
      session.receipts ??= [];
      const duplicate = session.receipts.includes(commandId);
      result = { commandId, status: duplicate ? 'duplicate' : 'accepted' };
      if (!duplicate) {
        session.receipts.push(commandId);
        if (type === 'sendText') notify = () => { void liveTurn(session.sessionId, commandId, payload.text); };
        if (type === 'switchModelConfig' || type === 'switchCollaborationMode') {
          session.config = { ...(session.config ?? defaultConfig), ...payload };
          session.revision = (session.revision ?? 0) + 1;
          notify = () => publish(session);
        }
        save(data);
      }
    }
  }
  if (method === 'v4/conversation/rowsRange') {
    const session = data.find(({ sessionId }) => sessionId === params.sessionId);
    if (session) {
      const earlier = session.rows.filter(({ rowId }) => !params.beforeRowId || rowId < params.beforeRowId);
      result = { rows: earlier.slice(-params.limit), hasMore: earlier.length > params.limit };
    }
  }
  output(result ? { id, result } : { id, error: { code: -32602, message: 'Test request rejected' } });
  notify?.();
}
