import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) {
  console.log('2.1.328 (Claude Code)');
  process.exit();
}
const cwd = process.cwd();
const threadId = process.argv[process.argv.findIndex((arg) => arg === '--session-id' || arg === '--resume') + 1];
const directory = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
mkdirSync(directory, { recursive: true });
const file = join(directory, threadId + '.jsonl');
const show = (frame) => console.log(JSON.stringify(frame));
const persist = (frame) => appendFileSync(file, JSON.stringify({ ...frame, cwd, sessionId: threadId, isSidechain: false, timestamp: new Date().toISOString() }) + '\n');
let pendingApproval;
let permissionMode = 'default';
let model = 'default';
const canBypass = process.argv.includes('--allow-dangerously-skip-permissions');
const models = [
  { value: 'default', displayName: 'Fixture Claude', supportsAutoMode: true },
  { value: 'legacy', displayName: 'Fixture Claude Legacy', supportsAutoMode: false },
];

function complete(prompt) {
  const id = randomUUID();
  const text = prompt + ' · Claude 已回复';
  show({ type: 'stream_event', session_id: threadId, event: { type: 'message_start', message: { id } } });
  show({ type: 'stream_event', session_id: threadId, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  const assistant = { type: 'assistant', uuid: id, message: { id, content: [{ type: 'text', text }] } };
  persist(assistant);
  show({ ...assistant, session_id: threadId });
  show({ type: 'result', subtype: 'success', session_id: threadId, is_error: false, result: text });
}

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    const { subtype, mode } = frame.request;
    let response = {};
    if (subtype === 'initialize') response = { models, current_permission_mode: permissionMode };
    if (subtype === 'get_settings') response = { effective: {} };
    if (subtype === 'set_model') model = frame.request.model;
    if (subtype === 'set_permission_mode') {
      if (mode === 'bypassPermissions' && !canBypass || mode === 'auto' && !models.find((option) => option.value === model)?.supportsAutoMode) {
        show({ type: 'control_response', response: { request_id: frame.request_id, subtype: 'error', error: 'Fixture mode is unavailable' } });
        continue;
      }
      permissionMode = mode;
      response = { mode };
    }
    show({ type: 'control_response', response: { request_id: frame.request_id, subtype: 'success', response } });
    continue;
  }
  if (frame.type === 'control_response' && pendingApproval && frame.response.request_id === pendingApproval.id) {
    if (frame.response.response?.behavior !== 'allow') throw new Error('Expected the user to allow the fixture command');
    complete(pendingApproval.prompt);
    pendingApproval = undefined;
    continue;
  }
  if (frame.type !== 'user') continue;
  if (frame.session_id !== threadId) throw new Error('The fixture received a different native session ID');
  persist({ type: 'user', uuid: frame.uuid, message: frame.message, permissionMode, canBypass });
  const prompt = frame.message.content.find((part) => part.type === 'text').text;
  if (prompt === '同一个项目的 Claude 对话') {
    pendingApproval = { id: randomUUID(), prompt };
    show({ type: 'control_request', request_id: pendingApproval.id, request: {
      subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'printf claude-fixture' },
    } });
  } else {
    complete(prompt);
  }
}
