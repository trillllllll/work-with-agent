import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

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
      if (params.input[0].text === 'permission') {
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
