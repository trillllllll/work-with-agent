import { randomUUID } from 'node:crypto';
import { AcpConnection, AcpError } from './harness-acp.js';
import { asObject, CodexRejected, type HarnessNotification, type HarnessRuntime } from './harness-codex.js';
import { codexItems as items, codexText as text } from './harness-history.js';
import { openKimiAcp } from './harness-kimi-client.js';
import {
  kimiToolFeed, kimiToolItem, kimiTurnPage, readKimiThread, type KimiToolState,
} from './harness-kimi-library.js';
import { HARNESS_TEXT_LIMIT } from './harness-protocol.js';

type Frame = Record<string, unknown>;
type RpcId = number | string;
type Turn = {
  id: string;
  cancelled: boolean;
  runs: number;
  run: { id: string; text: string; thought: boolean } | null;
};

function failure(error: unknown): never {
  if (error instanceof AcpError) {
    if (error.code === -32000 || /authentication required/i.test(error.message)) {
      throw new CodexRejected('Kimi Code 需要登录，请先在本机终端运行 kimi login');
    }
    if (/already.*(?:running|in flight)|write handle|locked|occupied|in use/i.test(error.message)) {
      throw new CodexRejected('Kimi Code 原会话正在被占用，结束后可以继续');
    }
    if (/cwd|project|directory/i.test(error.message)) throw new CodexRejected('这条对话不在所选项目目录中');
    if (/unknown session|not found/i.test(error.message)) throw new CodexRejected('找不到 Kimi Code 原会话，无法恢复');
    throw new CodexRejected('Kimi Code 拒绝了操作，请刷新会话状态后重试');
  }
  throw error;
}

export class KimiHarnessRuntime implements HarnessRuntime {
  private acp: AcpConnection | null = null;
  private closing = false;
  private threadId = '';
  private config: Frame[] = [];
  private modes: { current: string; available: string[] } = { current: 'default', available: [] };
  private image = false;
  private turn: Turn | null = null;
  private tools = new Map<string, KimiToolState>();
  private replay: Frame[] | null = null;
  private readonly approvals = new Map<RpcId, Frame[]>();

  constructor(private readonly cwd: string, private readonly notify: HarnessNotification, private readonly onExit: () => void) {}

  get pid() { return this.acp?.pid; }

  private emit(method: string, params: Frame, id?: RpcId) {
    this.notify(method, { threadId: this.threadId, ...params }, id);
  }

  private async connect() {
    if (this.acp) return this.acp;
    if (this.closing) throw new CodexRejected('本机会话已断开');
    const acp = this.acp = await openKimiAcp(this.cwd, (method, params, id) => this.onMessage(method, params, id));
    void acp.exited.then(() => {
      this.acp = null;
      if (!this.closing) this.onExit();
    });
    try {
      const initialized = await acp.request('initialize', {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dovun', version: '1' },
      }, 30_000).catch(failure);
      const capabilities = asObject(initialized.agentCapabilities);
      this.image = asObject(capabilities.promptCapabilities).image === true;
      const sessions = asObject(capabilities.sessionCapabilities);
      if (capabilities.loadSession !== true || !sessions.list || !sessions.resume) {
        throw new CodexRejected('当前 Kimi Code 版本缺少所需 ACP 会话能力');
      }
      return acp;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private current(configId: string) {
    return text(this.config.find((option) => option.id === configId)?.currentValue);
  }

  private adopt(session: Frame, threadId = text(session.sessionId)) {
    if (!threadId) throw new CodexRejected('Kimi Code 会话结果待核实');
    this.threadId = threadId;
    this.config = items(session.configOptions);
    const modes = asObject(session.modes);
    this.modes = {
      current: this.current('mode') || text(modes.currentModeId) || 'default',
      available: items(modes.availableModes).map((mode) => text(mode.id)).filter(Boolean),
    };
  }

  private selection() {
    const effort = this.current('thinking');
    return {
      thread: { id: this.threadId, cwd: this.cwd, status: { type: 'idle' } },
      model: this.current('model'), modelProvider: 'kimi',
      ...(effort ? { reasoningEffort: effort } : {}),
      collaborationMode: { mode: this.modes.current === 'plan' ? 'plan' : 'default' },
      sandbox: { type: 'workspaceWrite' },
    };
  }

  private closeMessageRun(final: boolean) {
    const turn = this.turn;
    if (!turn?.run) return;
    const item = { id: turn.run.id, type: 'agentMessage', text: turn.run.text.slice(0, HARNESS_TEXT_LIMIT),
      phase: turn.run.thought || !final ? 'commentary' : 'final_answer' };
    this.emit('item/completed', { turnId: turn.id, item });
    turn.run = null;
  }

  private messageRun(chunk: string, thought: boolean) {
    const turn = this.turn;
    if (!turn || !chunk) return;
    if (!turn.run || turn.run.thought !== thought) {
      this.closeMessageRun(false);
      turn.run = { id: `${turn.id}:${thought ? 'thought' : 'answer'}:${turn.runs++}`, text: '', thought };
      this.emit('item/started', { turnId: turn.id, item: { id: turn.run.id, type: 'agentMessage', text: '',
        ...(thought ? { phase: 'commentary' } : {}) } });
    }
    turn.run.text += chunk;
    this.emit('item/agentMessage/delta', { turnId: turn.id, itemId: turn.run.id, delta: chunk.slice(0, HARNESS_TEXT_LIMIT) });
  }

  private onMessage(method: string, params: Frame, id?: RpcId) {
    if (method === 'session/request_permission' && id !== undefined) {
      this.onPermission(params, id);
      return;
    }
    if (id !== undefined) {
      this.acp?.respondError(id, -32601, 'Unsupported request');
      return;
    }
    if (method === 'session/update' && this.replay && text(params.sessionId) === this.threadId) {
      this.replay.push(params);
      return;
    }
    if (method !== 'session/update' || text(params.sessionId) !== this.threadId) return;
    const update = asObject(params.update);
    const kind = text(update.sessionUpdate);
    if (kind === 'current_mode_update') {
      this.modes = { ...this.modes, current: text(update.currentModeId) || this.modes.current };
      return;
    }
    if (kind === 'config_option_update') {
      if (Array.isArray(update.configOptions)) this.config = items(update.configOptions);
      return;
    }
    if (kind === 'usage_update') {
      const used = Number(update.used), size = Number(update.size);
      if (Number.isSafeInteger(used) && used >= 0) this.emit('thread/tokenUsage/updated', { tokenUsage: {
        last: { totalTokens: used }, total: { totalTokens: used },
        ...(Number.isSafeInteger(size) && size > 0 ? { modelContextWindow: size } : {}),
      } });
      return;
    }
    const turn = this.turn;
    if (!turn) return;
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      this.messageRun(text(asObject(update.content).text), kind === 'agent_thought_chunk');
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.closeMessageRun(false);
      const known = this.tools.has(text(update.toolCallId));
      const state = kimiToolFeed(this.tools, update);
      if (!state) return;
      const done = state.status === 'completed' || state.status === 'failed';
      const item = kimiToolItem(state, done);
      if (!known) this.emit('item/started', { turnId: turn.id, item });
      else if (done) this.emit('item/completed', { turnId: turn.id, item });
    } else if (kind === 'plan') {
      this.closeMessageRun(false);
      const steps = items(update.entries).slice(0, 30).flatMap((entry) => {
        const label = text(asObject(entry.content).text).slice(0, 1_000);
        const status = entry.state === 'in_progress' ? 'inProgress' : entry.state === 'completed' ? 'completed' : 'pending';
        return label ? [{ step: label, status }] : [];
      });
      this.emit('turn/plan/updated', { turnId: turn.id, plan: steps, explanation: '' });
    }
  }

  private onPermission(params: Frame, id: RpcId) {
    const turn = this.turn;
    const options = items(params.options);
    if (!turn || !options.length) {
      this.acp?.respond(id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const toolCall = asObject(params.toolCall);
    const state = this.tools.get(text(toolCall.toolCallId));
    const kind = state?.kind;
    const method = kind === 'execute' ? 'item/commandExecution/requestApproval'
      : kind === 'edit' || kind === 'delete' || kind === 'move' ? 'item/fileChange/requestApproval' : 'item/tool/requestApproval';
    this.approvals.set(id, options);
    const detail = items(toolCall.content).map((block) => text(asObject(block.content).text)).filter(Boolean).join('\n');
    const title = text(toolCall.title) || state?.title || '';
    this.emit(method, {
      turnId: turn.id, ...(kind === 'execute' ? { command: text(state?.rawInput?.command) || title } : { description: title }),
      reason: detail, itemId: text(toolCall.toolCallId), availableDecisions: ['accept', 'decline', 'cancel'],
      availableOptions: options.map((option) => ({ id: text(option.optionId), kind: text(option.kind), name: text(option.name) })),
    }, id);
  }

  private async applyTurnSettings(params: Frame) {
    const acp = await this.connect();
    const model = text(params.model);
    if (model && model !== this.current('model')) {
      const result = await acp.request('session/set_config_option', {
        sessionId: this.threadId, configId: 'model', value: model,
      }, 30_000).catch(failure);
      this.config = items(result.configOptions);
    }
    const effort = text(params.effort);
    if (effort && effort !== this.current('thinking')) {
      const result = await acp.request('session/set_config_option', {
        sessionId: this.threadId, configId: 'thinking', value: effort,
      }, 30_000).catch(failure);
      this.config = items(result.configOptions);
    }
    const permission = text(params.permissionMode);
    const nativePermission = permission === 'bypassPermissions' ? 'yolo' : permission === 'auto' ? 'auto' : 'default';
    const mode = text(asObject(params.collaborationMode).mode) === 'plan' ? 'plan' : nativePermission;
    if (mode !== this.modes.current && (!this.modes.available.length || this.modes.available.includes(mode))) {
      const result = await acp.request('session/set_config_option', {
        sessionId: this.threadId, configId: 'mode', value: mode,
      }, 30_000).catch(failure);
      this.config = items(result.configOptions);
      this.modes = { ...this.modes, current: this.current('mode') || mode };
    }
  }

  private async readTurns(threadId: string, cursor: string | null, limit: number) {
    if (threadId !== this.threadId) throw new CodexRejected('这条对话不在所选项目目录中');
    const acp = await this.connect();
    const updates = this.replay = [];
    try {
      const loaded = await acp.request('session/load', { sessionId: threadId, cwd: this.cwd, mcpServers: [] }, 120_000).catch(failure);
      this.adopt(loaded, threadId);
      return kimiTurnPage(updates, threadId, cursor, limit);
    } finally { this.replay = null; }
  }

  private async startTurn(params: Frame) {
    if (this.turn) throw new CodexRejected('当前轮仍在运行，请稍候再试');
    await this.applyTurnSettings(params);
    const inputs = items(params.input);
    const prompt: Frame[] = [];
    for (const part of inputs) {
      if (part.type === 'text' && text(part.text)) prompt.push({ type: 'text', text: text(part.text) });
      else if (part.type === 'image') {
        const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(text(part.url));
        if (!match) throw new CodexRejected('图片格式无效');
        if (!this.image) throw new CodexRejected('Kimi Code 当前模型不支持图片附件');
        prompt.push({ type: 'image', mimeType: match[1], data: match[2] });
      }
    }
    if (!prompt.some((part) => part.type === 'text')) throw new CodexRejected('消息内容为空');
    const id = text(params.clientUserMessageId) || randomUUID();
    this.turn = { id, cancelled: false, runs: 0, run: null };
    this.tools.clear();
    this.emit('turn/started', { turn: { id, status: 'inProgress' } });
    this.emit('item/completed', { turnId: id, item: { id: `${id}:user`, clientId: id, type: 'userMessage',
      content: inputs.filter((part) => part.type === 'text') } });
    const acp = await this.connect();
    void acp.request('session/prompt', { sessionId: this.threadId, prompt }, 0)
      .then((result) => this.finish(text(result.stopReason)), (error: unknown) => this.finish('', error));
    return { turn: { id, status: 'inProgress' } };
  }

  private finish(stopReason: string, error?: unknown) {
    const turn = this.turn;
    if (!turn) return;
    const status = turn.cancelled || stopReason === 'cancelled' ? 'interrupted'
      : stopReason === 'end_turn' || stopReason === 'max_tokens' ? 'completed' : 'failed';
    this.closeMessageRun(status === 'completed');
    this.turn = null;
    const detail = error instanceof AcpError && /authentication required/i.test(error.message)
      ? 'Kimi Code 需要登录，请先在本机终端运行 kimi login'
      : error instanceof Error ? error.message : 'Kimi Code 当前轮执行失败';
    this.emit('turn/completed', { turn: { id: turn.id, status, ...(status === 'failed' ? { error: detail.slice(0, 500) } : {}) } });
  }

  async request(method: string, params: Frame): Promise<Frame> {
    const threadId = text(params.threadId);
    if (method === 'thread/start') {
      const created = await (await this.connect()).request('session/new', { cwd: this.cwd, mcpServers: [] }, 120_000).catch(failure);
      this.adopt(created);
      return this.selection();
    }
    if (method === 'thread/resume') {
      const resumed = await (await this.connect()).request('session/resume', {
        sessionId: threadId, cwd: this.cwd, mcpServers: [],
      }, 120_000).catch(failure);
      this.adopt(resumed, threadId);
      return this.selection();
    }
    if (method === 'thread/read') {
      const thread = await readKimiThread(threadId, this.cwd);
      if (!thread) throw new CodexRejected('这条对话不在所选项目目录中');
      return { thread };
    }
    if (method === 'thread/turns/list') return this.readTurns(threadId,
      text(params.cursor) || null, Math.max(1, Math.min(50, Number(params.limit) || 12))) as unknown as Frame;
    if (method === 'thread/fork') {
      const forked = await (await this.connect()).request('session/fork', {
        sessionId: threadId, cwd: this.cwd, mcpServers: [],
      }, 120_000).catch(failure);
      const id = text(forked.sessionId);
      if (!id || id === threadId) throw new CodexRejected('Kimi Code 会话分支结果待核实');
      return { thread: { id, cwd: this.cwd }, modelProvider: 'kimi' };
    }
    if (method === 'turn/start') return this.startTurn(params);
    if (method === 'turn/interrupt') {
      if (!this.turn || this.turn.id !== text(params.turnId)) throw new CodexRejected('该轮已结束，请刷新会话');
      this.turn.cancelled = true;
      (await this.connect()).notify('session/cancel', { sessionId: this.threadId });
      return {};
    }
    if (method === 'model/list') {
      const model = this.config.find((option) => option.id === 'model');
      const efforts = items(this.config.find((option) => option.id === 'thinking')?.options)
        .flatMap((option) => text(option.value) ? [{ reasoningEffort: text(option.value) }] : []);
      const choices = items(model?.options).flatMap((option) => Array.isArray(option.options)
        ? items(option.options) : [option]);
      return { data: choices.flatMap((choice) => {
        const id = text(choice.value);
        return id ? [{ model: id, displayName: text(choice.name) || id,
          supportedReasoningEfforts: efforts, defaultReasoningEffort: this.current('thinking') || null }] : [];
      }) };
    }
    if (method === 'permissionMode/list') {
      const current = this.modes.current === 'yolo' ? 'bypassPermissions' : this.modes.current === 'auto' ? 'auto' : 'default';
      return { data: ['default', 'auto', 'bypassPermissions'], current };
    }
    if (method === 'collaborationMode/list') return { data: this.modes.available.includes('plan')
      ? [{ mode: 'default' }, { mode: 'plan' }] : [{ mode: 'default' }] };
    throw new CodexRejected('本机不支持这个会话操作');
  }

  async reply(id: RpcId, result: Frame) {
    const options = this.approvals.get(id) ?? [];
    this.approvals.delete(id);
    const direct = text(result.optionId);
    const optionId = (prefix: string) => text((options.find((option) => text(option.kind) === prefix)
      ?? options.find((option) => text(option.kind).startsWith(prefix)))?.optionId);
    const decision = text(result.decision);
    const selected = direct || (decision === 'accept' ? optionId('allow_once') || optionId('allow')
      : decision === 'acceptForSession' ? optionId('allow_always') || optionId('allow')
        : decision === 'decline' ? optionId('reject_once') || optionId('reject') : '');
    if (selected && !options.some((option) => text(option.optionId) === selected)) throw new CodexRejected('这条权限请求已处理或决定无效');
    const outcome = !selected ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: selected };
    const acp = await this.connect();
    acp.respond(id, { outcome });
    this.emit('serverRequest/resolved', { requestId: id });
  }

  async unsupported(id: RpcId) {
    if (this.approvals.delete(id)) this.acp?.respond(id, { outcome: { outcome: 'cancelled' } });
    else this.acp?.respondError(id, -32601, 'Unsupported request');
  }

  async close() {
    this.closing = true;
    const acp = this.acp;
    this.acp = null;
    if (acp) await acp.close();
  }
}
