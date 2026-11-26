#!/usr/bin/env node
import { createServer } from 'node:http';

// A local OpenAI-compatible streaming model for checking an adapter against the real `dsh --profile acp`
// without calling a real provider. Register it through a `--patch` overlay:
//
//   - id: llm-pi-ai
//     config:
//       providers:
//         stub-local: { displayName: Stub Local, api: openai-completions, baseURL: http://127.0.0.1:<port>/v1,
//           apiKeyEnv: DSH_STUB_API_KEY, models: [{ id: stub-model, name: Stub Model, contextWindow: 128000, maxTokens: 8192 }] }
//   - id: acp
//     config: { provider: stub-local, model: stub-model }
//
// The newest user message decides the script:
//   ONLY_TEXT  reply with text streamed in small pieces
//   TOUCH      run `touch dovun-probe.txt` inside the session's project under the standing sandbox
//   ESCALATE   ask to widen the sandbox, which raises an approval before anything runs
//   LONG       run `sleep 20`, which only a cancel ends early
const port = Number(process.argv[2] ?? 0);
const debug = process.env.DSH_STUB_DEBUG === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const words = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join(' ');
let escalations = 0;
let calls = 0;
const callId = () => `call_stub_${++calls}`;

const KEYWORDS = ['ONLY_TEXT', 'TOUCH', 'ESCALATE', 'LONG'];
/** The messages of the current turn only: from its own prompt on, so an earlier tool call does not count. */
function currentTurn(messages) {
  let start = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user' && KEYWORDS.some((keyword) => words(message.content).includes(keyword))) start = index;
  });
  return messages.slice(start);
}

function plan(messages) {
  const turn = currentTurn(messages);
  const prompt = turn.filter((message) => message.role === 'user').map((message) => words(message.content)).join('\n');
  const answered = turn.some((message) => message.role === 'assistant' && message.tool_calls?.length);
  const pick = (keyword) => prompt.includes(keyword);
  const script = pick('ESCALATE') ? 'escalate' : pick('TOUCH') ? 'touch' : pick('LONG') ? 'long' : 'text';
  if (answered || script === 'text') return { kind: 'text', script };
  if (script === 'long') return { kind: 'tool', name: 'bash', args: { description: '等待一段时间', command: 'sleep 20' } };
  if (script === 'escalate') {
    escalations += 1;
    return { kind: 'tool', name: 'bash', args: { description: '请求更大权限创建验证文件', command: `touch dovun-escalated-${escalations}.txt`,
      sandbox_permissions: 'workspace-write', justification: '需要在项目中写入一个验证文件' } };
  }
  return { kind: 'tool', name: 'bash', args: { description: '在项目里创建验证文件', command: 'touch dovun-probe.txt' } };
}

function closingText(messages, script) {
  const results = currentTurn(messages).filter((message) => message.role === 'tool').map((message) => words(message.content)).join('\n');
  const denied = /denied|not permitted|Permission|拒绝/i.test(results);
  return script === 'touch' ? `结果：${denied ? '沙箱拒绝了写入' : '文件已创建'}`
    : script === 'escalate' ? `结果：${denied ? '未获批准或被拒绝' : '提权后文件已创建'}`
      : script === 'long' ? '结果：命令已结束' : 'DSH 本地假模型逐字回复 OK';
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const body = await new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
  const json = (status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };
  if (url.pathname.endsWith('/models')) return json(200, { object: 'list', data: [{ id: 'stub-model', object: 'model', owned_by: 'stub' }] });
  if (!url.pathname.endsWith('/chat/completions')) return json(404, { error: { message: 'not found' } });

  const messages = body.messages ?? [];
  const step = plan(messages);
  if (debug) {
    for (const message of messages.filter((item) => item.role === 'tool' || item.tool_calls?.length).slice(-3)) {
      console.error(`[stub-model] ${message.role}: ${(message.tool_calls ? JSON.stringify(message.tool_calls.map((call) => call.function)) : words(message.content)).slice(0, 700)}`);
    }
  }
  const base = { id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model: 'stub-model' };
  const finish = () => {
    const last = { ...base, choices: [{ index: 0, delta: {}, finish_reason: step.kind === 'tool' ? 'tool_calls' : 'stop' }] };
    if (body.stream) { response.write(`data: ${JSON.stringify(last)}\n\n`); response.write('data: [DONE]\n\n'); response.end(); }
    else response.end();
  };
  if (!body.stream) {
    const message = step.kind === 'tool'
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_stub', type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] }
      : { role: 'assistant', content: closingText(messages, step.script) };
    return json(200, { ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: step.kind === 'tool' ? 'tool_calls' : 'stop' }] });
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (delta) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  if (step.kind === 'tool') {
    send({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId(), type: 'function', function: { name: step.name, arguments: '' } }] });
    const arguments_ = JSON.stringify(step.args);
    // Arguments arrive in pieces too, the way a real stream breaks them up.
    for (const piece of [arguments_.slice(0, 20), arguments_.slice(20, 45), arguments_.slice(45)]) {
      await sleep(40);
      send({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
    }
    return finish();
  }
  send({ role: 'assistant', content: '' });
  const text = closingText(messages, step.script);
  for (const piece of text.match(/.{1,3}/gu) ?? []) {
    await sleep(120);
    send({ content: piece });
  }
  return finish();
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
