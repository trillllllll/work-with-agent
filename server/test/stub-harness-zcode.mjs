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

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  const data = read();
  let result;
  if (method === 'session/list') {
    const sameProject = ({ workspace, sessionId }) =>
      (!params.workspace || params.workspace.workspacePath === workspace.workspacePath) &&
      (!params.sessionIds || params.sessionIds.includes(sessionId));
    result = { sessions: data.filter(sameProject).slice(0, params.limit).map(({ rows, ...session }) => session) };
  }
  if (method === 'v4/conversation/subscribe' && params.historyFirst) result = { ack: { topic: params.topic } };
  if (method === 'v4/conversation/rowsRange') {
    const session = data.find(({ sessionId }) => sessionId === params.sessionId);
    if (session) {
      const earlier = session.rows.filter(({ rowId }) => !params.beforeRowId || rowId < params.beforeRowId);
      result = { rows: earlier.slice(-params.limit), hasMore: earlier.length > params.limit };
    }
  }
  output(result ? { id, result } : { id, error: { code: -32602, message: 'Test request rejected' } });
}
