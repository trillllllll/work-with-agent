import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

if (process.argv.includes('--version')) {
  console.log('codex-cli 0.166.0');
  process.exit();
}

const threadId = 'fixture-thread';
const historyPath = process.env.HARNESS_TEST_HISTORY;
const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')) : [];
let active;
let requestId = 800;

const send = (data) => console.log(JSON.stringify(data));
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params: { threadId, ...params } });
const persist = () => writeFileSync(historyPath, JSON.stringify(history));
function log(kind) { appendFileSync(process.env.HARNESS_TEST_CALLS, kind + '\n'); }
function pushUser(params) {
  const item = { type: 'userMessage', id: params.clientUserMessageId, clientId: params.clientUserMessageId, content: params.input };
  active.items.push(item);
  persist();
  notify('item/completed', { turnId: active.id, item });
}
function finish(status) {
  active.status = status;
  persist();
  notify('turn/completed', { turn: active });
  active = undefined;
}
async function diagramTurn(current) {
  const directory = dirname(historyPath);
  const command = { type: 'commandExecution', id: 'draw-' + current.id, status: 'inProgress', command: 'draw fixture' };
  const commentary = { type: 'agentMessage', id: 'intro-' + current.id, phase: 'commentary', text: '我先生成架构图。' };
  const append = (item) => { current.items.push(item); persist(); notify('item/completed', { turnId: current.id, item }); };
  const output = (delta) => notify('item/commandExecution/outputDelta', { turnId: current.id, itemId: command.id, delta });
  async function gate(name) {
    while (active === current && !existsSync(join(directory, name))) await new Promise((resolve) => setTimeout(resolve, 35));
    return active === current;
  }
  append(commentary);
  notify('item/started', { turnId: current.id, item: command });
  output('正在画框\n');
  if (!await gate('diagram-next')) return;
  output('连线已写入\n');
  if (!await gate('diagram-finish')) return;
  writeFileSync(join(process.cwd(), 'architecture.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect x="1" y="1" width="118" height="58" fill="#416d5a"/><text x="12" y="34" fill="#fff">Dovun</text></svg>');
  append({ ...command, status: 'completed', exitCode: 0, aggregatedOutput: '正在画框\n连线已写入\n' });
  append({ type: 'fileChange', id: 'file-' + current.id, status: 'completed', changes: [{ path: 'architecture.svg' }] });
  append({ type: 'agentMessage', id: 'final-' + current.id, phase: 'final_answer', text: '画好了。[查看架构图](architecture.svg)' });
  finish('completed');
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const { id, method, params } = request;
  switch (method) {
    case 'initialize': reply(id, { userAgent: 'fixture' }); break;
    case 'initialized': break;
    case 'thread/start': log('thread/start'); log('cwd ' + params.cwd); reply(id, { thread: { id: threadId } }); break;
    case 'thread/resume': log('thread/resume'); reply(id, { thread: { id: threadId } }); break;
    case 'thread/turns/list': reply(id, { data: [...history].reverse() }); break;
    case 'turn/start': {
      log('turn/start');
      active = { id: 'turn-' + (history.length + 1), status: 'inProgress', items: [] };
      history.push(active);
      reply(id, { turn: active });
      notify('turn/started', { turn: active });
      pushUser(params);
      if (params.input[0].text === '画一张 SVG 测试图') {
        void diagramTurn(active);
      } else if (params.input[0].text === 'permission') {
        send({ id: ++requestId, method: 'item/commandExecution/requestApproval', params: {
          itemId: 'command-item', threadId, turnId: active.id, command: 'printf fixture', availableDecisions: ['accept', 'decline'],
        } });
      } else {
        notify('item/agentMessage/delta', { itemId: 'response-' + active.id, turnId: active.id, delta: 'streamed ' });
      }
      break;
    }
    case 'turn/steer':
      log('turn/steer');
      reply(id, { turnId: active.id });
      pushUser(params);
      if (params.input[0].text === 'fill event cache') {
        for (let i = 0; i < 140; i++) {
          notify('item/agentMessage/delta', { itemId: 'response-' + active.id, turnId: active.id, delta: 'x' });
        }
      } else if (params.input[0].text === 'stream another chunk') {
        notify('item/agentMessage/delta', { itemId: 'response-' + active.id, turnId: active.id, delta: '新增正文' });
      }
      break;
    case 'turn/interrupt':
      log('turn/interrupt');
      reply(id, {});
      finish('interrupted');
      break;
    default:
      if (typeof request.result?.decision === 'string') {
        log('approval:' + request.result.decision);
        notify('serverRequest/resolved', { requestId: id });
        finish('completed');
      } else send({ id, error: { code: -32601, message: 'unsupported' } });
  }
}
