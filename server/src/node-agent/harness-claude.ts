import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { providerEnvironment } from '../runner/environment.js';
import { resolveLocalCli } from './cli.js';
import { asObject, CodexRejected, type HarnessNotification, type HarnessRuntime } from './harness-codex.js';
import { readClaudeThread, readClaudeTurns } from './harness-claude-library.js';
import { codexItems as items, codexText as text } from './harness-history.js';
import { claudePermissionMode } from './harness-protocol.js';

type Frame = Record<string, unknown>;
type NativeTool = { input: Frame; toolUseId?: string; questions?: string[] };
type ActiveTurn = { id: string; messageId: string; interrupted: boolean };

// The controller uses one thread/turn interface. Claude keeps its own UUIDs and control requests.
export class ClaudeHarnessRuntime implements HarnessRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> | null = null;
  private closing = false;
  private threadId = '';
  private turn: ActiveTurn | null = null;
  private model = 'default';
  private permissionMode = 'default';
  private models: Frame[] = [];
  private requests = new Map<string, (result: Frame | Error) => void>();
  private tools = new Map<string, NativeTool>();
  private awaitingToolResult = new Map<string, string | undefined>();
  private toolItems = new Map<string, Frame>();

  constructor(private readonly cwd: string, private readonly notify: HarnessNotification, private readonly onExit: () => void) {}
  get pid() { return this.child?.pid; }

  private emit(method: string, params: Frame, id?: string) {
    this.notify(method, { threadId: this.threadId, ...params }, id);
  }

  private write(frame: Frame) {
    const input = this.child?.stdin;
    if (!input?.writable) return Promise.reject(new Error('本机会话已断开'));
    return new Promise<void>((resolve, reject) => input.write(JSON.stringify(frame) + '\n', (error) => error ? reject(error) : resolve()));
  }

  private control(subtype: string, params: Frame = {}) {
    const requestId = randomUUID();
    return new Promise<Frame>((resolve, reject) => {
      const finish = (result: Frame | Error) => {
        clearTimeout(timer);
        this.requests.delete(requestId);
        if (result instanceof Error) reject(result); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('Claude Code 响应超时，操作结果待核实')), 10_000);
      this.requests.set(requestId, finish);
      void this.write({ type: 'control_request', request_id: requestId, request: { subtype, ...params } }).catch(finish);
    });
  }

  private async launch(threadId: string, resume: boolean) {
    this.threadId = threadId;
    const cli = await resolveLocalCli('claude');
    const env = providerEnvironment();
    delete env.DOVUN_NODE_TOKEN;
    const child = spawn(cli.command, [...cli.prefix, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--permission-mode', 'default', '--permission-prompt-tool', 'stdio', '--include-partial-messages',
      resume ? '--resume' : '--session-id', threadId,
    ], { cwd: this.cwd, env, stdio: 'pipe', windowsHide: true });
    this.child = child;
    child.stderr.resume();
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const failed = () => {
      for (const finish of this.requests.values()) finish(new Error('本机会话已断开'));
    };
    child.on('error', failed);
    child.stdin.on('error', failed);
    this.exited = new Promise<void>((resolve) => child.once('close', () => {
      output.close();
      failed();
      if (!this.closing) this.onExit();
      resolve();
    }));
    output.on('line', (line) => {
      let frame: Frame;
      try { frame = asObject(JSON.parse(line)); } catch { return; }
      this.receive(frame);
    });
    const hello = await this.control('initialize');
    this.models = items(hello.models);
    const previous = resume ? (await readClaudeTurns(threadId, this.cwd, null, 1)).data[0] : null;
    return {
      thread: { id: threadId, cwd: this.cwd, status: { type: 'idle' } },
      model: this.model, modelProvider: 'claude', sandbox: { type: 'workspaceWrite' },
      ...(previous ? { previousTurn: previous.id } : {}),
    };
  }

  private receive(frame: Frame) {
    if (frame.type === 'control_response') {
      const response = asObject(frame.response);
      const finish = this.requests.get(text(response.request_id));
      finish?.(response.subtype === 'success' ? asObject(response.response) : new CodexRejected('Claude Code 拒绝了操作'));
      return;
    }
    const turn = this.turn;
    if (!turn || frame.session_id && frame.session_id !== this.threadId) return;
    if (frame.type === 'control_request') {
      const id = text(frame.request_id);
      const request = asObject(frame.request);
      if (!id || request.subtype !== 'can_use_tool') {
        if (id) void this.unsupported(id).catch(() => undefined);
        return;
      }
      this.showToolRequest(turn.id, id, request);
      return;
    }
    if (frame.type === 'stream_event') {
      const event = asObject(frame.event), delta = asObject(event.delta);
      if (event.type === 'message_start') turn.messageId = text(asObject(event.message).id);
      if (event.type === 'content_block_delta' && delta.type === 'text_delta' && turn.messageId) {
        this.emit('item/agentMessage/delta', { turnId: turn.id, itemId: turn.messageId, delta: text(delta.text) });
      }
    } else if (frame.type === 'assistant') {
      const message = asObject(frame.message);
      const parts = items(message.content);
      const content = parts.filter((part) => part.type === 'text').map((part) => text(part.text)).join('');
      const id = text(message.id) || turn.messageId;
      const tools = parts.filter((part) => part.type === 'tool_use');
      if (id && content) this.emit('item/completed', { turnId: turn.id, item: { id, type: 'agentMessage', text: content,
        phase: tools.length ? 'commentary' : 'final_answer',
      } });
      for (const tool of tools) {
        const id = text(tool.id), name = text(tool.name), input = asObject(tool.input);
        if (!id || this.toolItems.has(id) || this.toolItems.size >= 64) continue;
        const item = name === 'Bash' ? { id, type: 'commandExecution', command: text(input.command) }
          : ['Write', 'Edit', 'MultiEdit'].includes(name) ? { id, type: 'fileChange', changes: [{ path: text(input.file_path) }] }
            : { id, type: 'dynamicToolCall', tool: name };
        this.toolItems.set(id, item);
        this.emit('item/started', { turnId: turn.id, item });
      }
    } else if (frame.type === 'user') {
      for (const part of items(asObject(frame.message).content).filter((part) => part.type === 'tool_result')) {
        const id = text(part.tool_use_id), tool = this.toolItems.get(id);
        for (const [requestId, toolId] of this.awaitingToolResult) {
          if (id && toolId === id) {
            this.awaitingToolResult.delete(requestId);
            this.emit('serverRequest/resolved', { requestId });
          }
        }
        if (!tool) continue;
        this.toolItems.delete(id);
        const output = typeof part.content === 'string' ? part.content : items(part.content).map((part) => text(part.text)).join('\n');
        this.emit('item/completed', { turnId: turn.id, item: { ...tool, status: part.is_error ? 'failed' : 'completed',
          ...(tool.type === 'commandExecution' ? { aggregatedOutput: output } : {}),
        } });
      }
    } else if (frame.type === 'result') {
      for (const requestId of this.awaitingToolResult.keys()) this.emit('serverRequest/resolved', { requestId });
      this.awaitingToolResult.clear();
      this.tools.clear();
      this.toolItems.clear();
      this.turn = null;
      this.emit('turn/completed', { turn: { id: turn.id, status: turn.interrupted ? 'interrupted' : frame.is_error ? 'failed' : 'completed' } });
    }
  }

  private showToolRequest(turnId: string, id: string, request: Frame) {
    const name = text(request.tool_name);
    const input = asObject(request.input);
    const toolUseId = text(request.tool_use_id) || undefined;
    const questions = name === 'AskUserQuestion' ? items(input.questions) : [];
    if (questions.length) {
      this.tools.set(id, { input, toolUseId, questions: questions.map((item) => text(item.question)) });
      this.emit('item/tool/requestUserInput', { turnId, questions: questions.map((item, index) => ({
        id: String(index), question: text(item.question), options: items(item.options), isOther: true,
      })) }, id);
      return;
    }
    this.tools.set(id, { input, toolUseId });
    const method = name === 'Bash' ? 'item/commandExecution/requestApproval'
      : ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name) ? 'item/fileChange/requestApproval' : 'item/tool/requestApproval';
    this.emit(method, {
      turnId, command: text(input.command),
      description: name === 'Bash' ? undefined : [name, text(input.file_path) || text(input.notebook_path)].filter(Boolean).join(' '),
      reason: text(request.decision_reason), availableDecisions: ['accept', 'decline'],
    }, id);
  }

  async request(method: string, params: Frame): Promise<Frame> {
    const threadId = text(params.threadId);
    if (method === 'thread/start') return this.launch(randomUUID(), false);
    if (method === 'thread/read') return { thread: await readClaudeThread(threadId, this.cwd) };
    if (method === 'thread/resume') return this.launch(threadId, !!await readClaudeThread(threadId, this.cwd));
    if (method === 'thread/turns/list') return readClaudeTurns(threadId, this.cwd, text(params.cursor) || null, Number(params.limit) || 20);
    if (method === 'model/list') return { data: this.models.map((model) => ({ model: model.value, displayName: model.displayName })) };
    if (method === 'collaborationMode/list') return { data: [{ mode: 'default' }, { mode: 'plan' }] };
    if (method === 'turn/start') return this.send(params);
    if (method === 'turn/interrupt' && this.turn && params.turnId === this.turn.id) {
      this.turn.interrupted = true;
      await this.control('interrupt');
      return {};
    }
    throw new CodexRejected('本机不支持这个会话操作');
  }

  private async send(params: Frame) {
    if (this.turn) throw new CodexRejected('当前轮仍在运行');
    const model = text(params.model);
    if (model && model !== this.model) {
      await this.control('set_model', { model });
      this.model = model;
    }
    const nativeMode = claudePermissionMode.safeParse(params.permissionMode);
    const mode = nativeMode.data ?? (asObject(params.sandboxPolicy).type === 'readOnly' ? 'plan' : 'default');
    if (nativeMode.success || mode !== this.permissionMode) {
      await this.control('set_permission_mode', { mode });
      this.permissionMode = mode;
    }
    const inputs = items(params.input);
    const content = inputs.flatMap<Frame>((part) => {
      if (part.type === 'text') return [{ type: 'text', text: text(part.text) }];
      const image = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(text(part.url));
      return image ? [{ type: 'image', source: { type: 'base64', media_type: image[1], data: image[2] } }] : [];
    });
    const requested = text(params.clientUserMessageId);
    const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requested) ? requested : randomUUID();
    this.turn = { id, messageId: '', interrupted: false };
    const turn = { id, status: 'inProgress' };
    this.emit('turn/started', { turn });
    this.emit('item/completed', { turnId: id, item: { id, type: 'userMessage', content: inputs } });
    await this.write({ type: 'user', uuid: id, session_id: this.threadId, parent_tool_use_id: null, message: { role: 'user', content } });
    return { turn };
  }

  async reply(id: string | number, result: Frame) {
    const key = String(id);
    const tool = this.tools.get(key);
    if (!tool) throw new CodexRejected('这条权限请求已处理或决定无效');
    const selected = asObject(result.answers);
    const answers = tool.questions ? Object.fromEntries(tool.questions.map((label, index) => [label, itemsAnswer(selected[index])])) : null;
    this.tools.delete(key);
    this.awaitingToolResult.set(key, tool.toolUseId);
    await this.write({ type: 'control_response', response: {
      subtype: 'success', request_id: key,
      response: answers || result.decision === 'accept'
        ? { behavior: 'allow', updatedInput: { ...tool.input, ...(answers ? { answers } : {}) } }
        : { behavior: 'deny', message: 'Declined by the user' },
    } });
  }

  unsupported(id: string | number) {
    return this.write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Unsupported request' } });
  }

  async close() {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    const kill = setTimeout(() => child.kill(), 800);
    const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
    try { await this.exited; } finally { clearTimeout(kill); clearTimeout(force); }
  }
}

function itemsAnswer(value: unknown) {
  const answers = asObject(value).answers;
  return Array.isArray(answers) ? text(answers[0]) : '';
}
