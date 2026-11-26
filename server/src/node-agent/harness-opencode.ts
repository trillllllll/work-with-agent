import { randomUUID } from 'node:crypto';
import { asObject, CodexRejected, type HarnessNotification, type HarnessRuntime } from './harness-codex.js';
import { codexItems, codexText } from './harness-history.js';
import {
  ensureOpenCodeService, OpenCodeError, openCodeRequest, subscribeOpenCodeEvents, type OpenCodeService,
} from './harness-opencode-client.js';
import {
  openCodeSessionBusy, openCodeToolKind, openCodeToolResult, openCodeUserItem, readOpenCodeThread, readOpenCodeTurns,
} from './harness-opencode-library.js';
import { HARNESS_EVENTS } from './harness-protocol.js';

type Frame = Record<string, unknown>;

// OpenCode keeps every session inside a shared local service; the runtime only attaches to it.
export class OpenCodeHarnessRuntime implements HarnessRuntime {
  private connection: Promise<OpenCodeService> | null = null;
  private readonly stream = new AbortController();
  private closing = false;
  private threadId = '';
  private turn: string | null = null;
  private pendingEvents: Frame[] | null = null;
  private model = '';
  private agent = 'build';
  private models: Frame[] | null = null;

  constructor(private readonly cwd: string, private readonly notify: HarnessNotification,
    private readonly onExit: () => void) {}

  // The shared service is not owned by this executor, so restarts never wait for its pid.
  get pid() { return undefined; }

  private emit(method: string, params: Frame, id?: string) {
    this.notify(method, { threadId: this.threadId, ...params }, id);
  }

  private connect() {
    if (this.closing) throw new CodexRejected('本机会话已断开');
    return this.connection ??= this.open();
  }

  private async open() {
    const service = await ensureOpenCodeService();
    const timeout = setTimeout(() => this.stream.abort(), 8_000);
    try {
      await subscribeOpenCodeEvents(service, (event) => this.receive(event), this.stream.signal, () => this.disconnect());
      return service;
    } finally { clearTimeout(timeout); }
  }

  private disconnect() {
    if (this.closing) return;
    void this.close();
    this.onExit();
  }

  private async session(threadId: string) {
    return readOpenCodeThread(await this.connect(), threadId, this.cwd, [this.cwd]);
  }

  private threadResult(session: Frame) {
    const model = asObject(session.model);
    const provider = codexText(model.providerID), id = codexText(model.id);
    const agent = codexText(session.agent) || 'build';
    this.model = provider && id ? `${provider}/${id}` : this.model;
    this.agent = agent;
    return {
      thread: { id: codexText(session.id), cwd: this.cwd, status: { type: 'idle' } },
      model: this.model, modelProvider: 'opencode',
      collaborationMode: { mode: agent === 'plan' ? 'plan' : 'default' },
    };
  }

  private replay(events: Frame[]) {
    this.pendingEvents = null;
    for (const event of events) this.receive(event);
  }

  private async adoptForeignTurn() {
    if (this.pendingEvents || this.turn) return;
    const events: Frame[] = this.pendingEvents = [];
    try {
      const service = await this.connect();
      const threadId = this.threadId;
      if (!await openCodeSessionBusy(service, threadId)) return;
      const path = `/api/session/${encodeURIComponent(threadId)}`;
      const page = await openCodeRequest<{ data?: Frame[] }>(service, 'GET', path + '/message?limit=50');
      const user = codexItems(page.data).find((message) => message.type === 'user' && codexText(message.id));
      if (!user) throw new Error('无法识别正在运行的 OpenCode 轮次');
      const item = openCodeUserItem(user);
      this.turn = item.id;
      this.emit('turn/started', { turn: { id: item.id, status: 'inProgress' } });
      this.emit('item/completed', { turnId: item.id, item });
      const approvals = await openCodeRequest<{ data?: Frame[] }>(service, 'GET', path + '/permission');
      for (const request of codexItems(approvals.data)) {
        if (request.sessionID === threadId) this.approval(request, item.id);
      }
    } finally { this.replay(events); }
  }

  private async switchModel(model: string) {
    const split = /^([^/]+)\/(.+)$/.exec(model);
    if (!split || !split[2]) throw new CodexRejected('这个模型在本机不可用');
    const options = this.models ?? [];
    if (options.length && !options.some((option) => codexText(option.model) === model)) throw new CodexRejected('这个模型在本机不可用');
    const service = await this.connect();
    await openCodeRequest(service, 'POST', `/api/session/${encodeURIComponent(this.threadId)}/model`,
      { model: { id: split[2], providerID: split[1] } }).catch((error: unknown) => {
        if (error instanceof OpenCodeError) throw new CodexRejected('这个模型在本机不可用');
        throw error;
      });
    this.model = model;
  }

  private async switchAgent(mode: string) {
    const agent = mode === 'plan' ? 'plan' : 'build';
    if (agent === this.agent) return;
    const service = await this.connect();
    await openCodeRequest(service, 'POST', `/api/session/${encodeURIComponent(this.threadId)}/agent`, { agent });
    this.agent = agent;
  }

  async request(method: string, params: Frame): Promise<Frame> {
    const threadId = codexText(params.threadId);
    if (method === 'thread/start') {
      const service = await this.connect();
      const created = await openCodeRequest<{ data?: Frame }>(service, 'POST', '/api/session', { location: { directory: this.cwd } });
      const session = asObject(created.data);
      const id = codexText(session.id);
      if (!id) throw new CodexRejected('OpenCode 会话创建结果待核实');
      this.threadId = id;
      return this.threadResult(session);
    }
    if (method === 'thread/read') {
      const session = await this.session(threadId);
      return { thread: { id: threadId, cwd: this.cwd, status: { type: await openCodeSessionBusy(await this.connect(), threadId) ? 'active' : 'idle' },
        name: codexText(session.title), modelProvider: 'opencode' } };
    }
    if (method === 'thread/resume') {
      const session = await this.session(threadId);
      this.threadId = threadId;
      await this.adoptForeignTurn();
      return this.threadResult(session);
    }
    if (method === 'thread/turns/list') {
      const service = await this.connect();
      const page = await readOpenCodeTurns(service, threadId, codexText(params.cursor) || null,
        Number(params.limit) || 20, this.turn !== null);
      return { data: page.data, nextCursor: page.nextCursor };
    }
    if (method === 'model/list') {
      const service = await this.connect();
      const page = await openCodeRequest<{ data?: Frame[] }>(service, 'GET',
        `/api/model?location%5Bdirectory%5D=${encodeURIComponent(this.cwd)}`);
      this.models = codexItems(page.data).filter((model) => codexText(model.id) && model.enabled !== false)
        .map((model) => ({ model: `${codexText(model.providerID)}/${codexText(model.id)}`, displayName: codexText(model.name) }));
      return { data: this.models };
    }
    if (method === 'collaborationMode/list') return { data: [{ mode: 'default' }, { mode: 'plan' }] };
    if (method === 'turn/start') return this.send(params);
    if (method === 'turn/interrupt') {
      if (!this.turn || params.turnId !== this.turn) throw new CodexRejected('该轮已结束，请刷新会话');
      const service = await this.connect();
      await openCodeRequest(service, 'POST', `/api/session/${encodeURIComponent(this.threadId)}/interrupt`);
      return {};
    }
    throw new CodexRejected('本机不支持这个会话操作');
  }

  private async send(params: Frame) {
    if (this.turn || this.pendingEvents) throw new CodexRejected('当前轮仍在运行，请稍候再试');
    const model = codexText(params.model);
    const mode = asObject(params.collaborationMode).mode === 'plan' ? 'plan' : 'default';
    if (model && model !== this.model) await this.switchModel(model);
    await this.switchAgent(mode);
    const inputs = codexItems(params.input);
    const text = inputs.filter((part) => part.type === 'text').map((part) => codexText(part.text)).join('\n');
    const files = inputs.flatMap<Frame>((part) => {
      const uri = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(codexText(part.url));
      return uri ? [{ uri: uri[0], source: 'message', name: uri[1] === 'image/png' ? 'image.png' : 'image.jpg' }] : [];
    });
    const requested = codexText(params.clientUserMessageId);
    const id = requested || randomUUID();
    const service = await this.connect();
    if (this.turn || this.pendingEvents) throw new CodexRejected('当前轮仍在运行，请稍候再试');
    const events: Frame[] = this.pendingEvents = [];
    // The service requires user message ids to start with "msg_"; the prefix is stripped back when history is read.
    // Prompt ids are idempotent on the service, so a redelivered command never sends twice.
    try {
      await openCodeRequest(service, 'POST', `/api/session/${encodeURIComponent(this.threadId)}/prompt`,
        { id: 'msg_' + id, text, ...(files.length ? { files } : {}) });
      this.turn = id;
      const turn = { id, status: 'inProgress' };
      this.emit('turn/started', { turn });
      this.emit('item/completed', { turnId: id, item: { id, clientId: id, type: 'userMessage',
        content: inputs.filter((part) => part.type === 'text') } });
      return { turn };
    } catch (error) {
      if (error instanceof OpenCodeError && error.status === 404) throw new CodexRejected('找不到 OpenCode 原会话，无法恢复');
      if (!(error instanceof CodexRejected)) this.disconnect();
      throw error;
    } finally { this.replay(events); }
  }

  private receive(event: Frame) {
    const type = codexText(event.type);
    const data = asObject(event.data);
    if (this.closing || !this.threadId || codexText(data.sessionID) !== this.threadId) return;
    if (this.pendingEvents) {
      this.pendingEvents.push(event);
      if (this.pendingEvents.length > HARNESS_EVENTS) this.pendingEvents.shift();
      return;
    }
    if (type === 'session.execution.started') {
      if (!this.turn) void this.adoptForeignTurn().catch(() => this.disconnect());
      return;
    }
    if (type === 'session.execution.succeeded' || type === 'session.execution.failed' || type === 'session.execution.interrupted') {
      const turn = this.turn;
      this.turn = null;
      if (!turn) return;
      const status = type === 'session.execution.succeeded' ? 'completed'
        : type === 'session.execution.interrupted' ? 'interrupted' : 'failed';
      const error = status === 'failed' ? codexText(asObject(data.error).message).slice(0, 500)
        || 'OpenCode 当前轮执行失败' : undefined;
      this.toolStarted.clear();
      this.emit('turn/completed', { turn: { id: turn, status, ...(error ? { error } : {}) } });
      return;
    }
    const turn = this.turn;
    if (!turn) return;
    if (type === 'session.text.started' && typeof data.ordinal === 'number') {
      this.emit('item/started', { turnId: turn, item: { id: textItemId(data), type: 'agentMessage', text: '' } });
    } else if (type === 'session.text.delta' && typeof data.ordinal === 'number') {
      this.emit('item/agentMessage/delta', { turnId: turn, itemId: textItemId(data), delta: codexText(data.delta) });
    } else if (type === 'session.text.ended' && typeof data.ordinal === 'number') {
      this.emit('item/completed', { turnId: turn, item: { id: textItemId(data), type: 'agentMessage',
        text: codexText(data.text).slice(0, 24_000), phase: 'final_answer' } });
    } else if (type === 'session.tool.called') {
      const id = codexText(data.id);
      const kind = openCodeToolKind(codexText(data.name), asObject(data.input));
      if (id && kind) {
        this.toolStarted.set(id, { id, ...kind });
        this.emit('item/started', { turnId: turn, item: { id, ...kind } });
      }
    } else if (type === 'session.tool.success' || type === 'session.tool.error') {
      const id = codexText(data.id);
      const base = this.toolStarted.get(id);
      if (!id || !base) return;
      this.toolStarted.delete(id);
      const result = type === 'session.tool.success' ? openCodeToolResult({ content: data.content, metadata: data.metadata })
        : { aggregatedOutput: codexText(asObject(data.error).message).slice(0, 4_000) };
      this.emit('item/completed', { turnId: turn,
        item: { ...base, ...result, status: type === 'session.tool.success' ? 'completed' : 'failed' } });
    } else if (type === 'permission.asked') {
      this.approval(data, turn);
    } else if (type === 'permission.replied') {
      const id = codexText(data.requestID);
      if (id) this.emit('serverRequest/resolved', { requestId: id });
    }
  }

  private approval(data: Frame, turnId: string) {
    const id = codexText(data.id);
    if (!id) return;
    const action = codexText(data.action);
    const resources = Array.isArray(data.resources) ? data.resources.map(codexText) : [];
    const patterns = Array.isArray(data.save) ? data.save.map(codexText).filter(Boolean) : [];
    const method = action === 'shell' ? 'item/commandExecution/requestApproval'
      : ['edit', 'write', 'patch', 'multiedit'].includes(action) ? 'item/fileChange/requestApproval' : 'item/tool/requestApproval';
    this.emit(method, {
      turnId,
      command: method === 'item/commandExecution/requestApproval' ? resources.join(' ') : '',
      description: [action, ...(method === 'item/commandExecution/requestApproval' ? [] : resources), ...patterns].join('\n'),
      availableDecisions: ['accept', 'decline'],
      projectApproval: patterns.length > 0,
    }, id);
  }

  private toolStarted = new Map<string, Frame>();

  async reply(id: string | number, result: Frame) {
    const key = String(id);
    const decision = result.optionId ?? (result.decision === 'accept' ? 'once' : result.decision === 'decline' ? 'reject' : null);
    if (decision !== 'once' && decision !== 'always' && decision !== 'reject') throw new CodexRejected('这条权限请求已处理或决定无效');
    const service = await this.connect();
    await openCodeRequest(service, 'POST',
      `/api/session/${encodeURIComponent(this.threadId)}/permission/${encodeURIComponent(key)}/reply`, { decision })
      .catch((error: unknown) => {
        if (error instanceof OpenCodeError && error.status === 404) throw new CodexRejected('这条权限请求已处理');
        throw error;
      });
    this.emit('serverRequest/resolved', { requestId: key });
  }

  async unsupported(_id: string | number) { /* The shared service rejects unknown requests itself. */ }

  async close() {
    this.closing = true;
    this.stream.abort();
  }
}

function textItemId(data: Frame) {
  return `${codexText(data.assistantMessageID)}#${typeof data.ordinal === 'number' ? data.ordinal : 0}`;
}
