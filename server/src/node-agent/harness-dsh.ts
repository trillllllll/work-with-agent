import { randomUUID } from 'node:crypto';
import { asObject, CodexRejected, type HarnessNotification, type HarnessRuntime } from './harness-codex.js';
import { AcpConnection, AcpError, DshBridge } from './harness-dsh-client.js';
import { dshRecordedPreset, dshToolKind, readDshTurns } from './harness-dsh-library.js';
import { codexItems, codexText } from './harness-history.js';

type Frame = Record<string, unknown>;
const SANDBOX = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' } as const;
const PRESET = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' } as const;
type Stream = { attempt: number; open: boolean; blocks: Map<number, { id: string; text: string }> };

function resumeFailure(error: unknown): never {
  if (!(error instanceof AcpError)) throw error;
  const detail = error.message + JSON.stringify(error.data ?? '');
  if (/already owned by an active write handle/.test(detail)) throw new CodexRejected('DSH 原会话正在被占用，结束后可以继续');
  if (/cwd does not match/.test(detail)) throw new CodexRejected('这条对话不在所选项目目录中');
  throw new CodexRejected('找不到 DSH 原会话，无法恢复');
}

// Each conversation owns one `dsh --profile acp` process; the runtime translates ACP into the shared thread interface.
export class DshHarnessRuntime implements HarnessRuntime {
  private acp: AcpConnection | null = null;
  private bridge: DshBridge | null = null;
  private closing = false;
  private threadId = '';
  private turn: { id: string; cancelled: boolean; bridged: boolean } | null = null;
  private config: Frame[] = [];
  private catalog: Frame[] | null = null;
  private image = false;
  private preset: string = PRESET.workspaceWrite;
  private tools = new Map<string, Frame & { description: string }>();
  private stream: Stream | null = null;
  private attempts = 0;
  private settled = new Set<string>();
  private plain = new Map<string, string>();
  private pendingText = new Map<string, { texts: string[]; commentary: boolean }>();

  constructor(private readonly cwd: string, private readonly notify: HarnessNotification, private readonly onExit: () => void,
    private readonly advanced: () => boolean = () => false) {}

  /** True once the bridge plugin joined this launch, which is what makes preset switching and streaming available. */
  get bridgeReady() { return this.bridge?.ready ?? false; }
  get pid() { return this.acp?.pid; }

  private emit(method: string, params: Frame, id?: number | string) {
    this.notify(method, { threadId: this.threadId, ...params }, id);
  }

  private async connect() {
    if (this.acp) return this.acp;
    if (this.closing) throw new CodexRejected('本机会话已断开');
    const bridge = this.bridge ??= await DshBridge.start();
    bridge.onEvent = (event, params) => this.onBridge(event, params);
    const acp = this.acp = await AcpConnection.open(this.cwd, bridge.overlay, (method, params, id) => this.onMessage(method, params, id));
    void acp.exited.then(() => {
      this.acp = null;
      if (!this.closing) this.onExit();
    });
    try {
      const initialized = await acp.request('initialize', { protocolVersion: 1, clientInfo: { name: 'dovun', version: '1' } });
      this.image = asObject(asObject(initialized.agentCapabilities).promptCapabilities).image === true;
      // The plugin connects during startup. When it never does, the rest keeps working with reduced behavior.
      await bridge.waitForPlugin(1_500);
      return acp;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private current(configId: string) {
    return codexText(this.config.find((option) => option.id === configId)?.currentValue);
  }

  private async recordedPreset(threadId: string) {
    const answer = await this.bridge?.call<{ current?: unknown }>('permission.current', { sessionId: threadId }) ?? null;
    const preset = codexText(answer?.current) || await dshRecordedPreset(threadId);
    return preset in SANDBOX ? preset : PRESET.workspaceWrite;
  }

  private selection() {
    const effort = this.current('reasoning_effort');
    // Full access is only reported where the page may offer it; elsewhere the next turn applies the shown preset.
    const full = this.preset === PRESET.dangerFullAccess && this.advanced();
    const type = this.preset === PRESET.readOnly ? 'readOnly' : full ? 'dangerFullAccess' : 'workspaceWrite';
    return {
      thread: { id: this.threadId, cwd: this.cwd, status: { type: 'idle' } },
      model: this.current('model'), modelProvider: 'dsh',
      ...(effort ? { reasoningEffort: effort } : {}),
      collaborationMode: { mode: 'default' }, sandbox: { type },
    };
  }

  private async models() {
    if (!this.catalog && this.bridge?.ready) {
      const answer = await this.bridge.call<{ models?: unknown }>('catalog', {}, 5_000);
      if (answer) this.catalog = codexItems(answer.models);
    }
    const detailed = new Map((this.catalog ?? []).map((model) => [codexText(model.value), model]));
    const groups = codexItems(this.config.find((item) => item.id === 'model')?.options);
    const choices = groups.flatMap((group) => codexItems(group.options).map((choice) => ({ group, choice })));
    const names = choices.map(({ choice }) => codexText(choice.name));
    const selected = this.current('model');
    // Without the bridge only the selected model's efforts are known, from the options ACP returns with it.
    const liveEfforts = codexItems(this.config.find((item) => item.id === 'reasoning_effort')?.options).map((item) => codexText(item.value));
    return choices.flatMap(({ group, choice }): Frame[] => {
      const value = codexText(choice.value);
      if (!value) return [];
      const extra = detailed.get(value);
      const efforts = extra && Array.isArray(extra.efforts) ? extra.efforts.filter((id): id is string => typeof id === 'string')
        : value === selected ? liveEfforts : [];
      const name = codexText(choice.name) || value;
      const shared = names.filter((other) => other && other === name).length > 1;
      const defaults = typeof extra?.defaultEffort === 'string' ? extra.defaultEffort : '';
      return [{ model: value, displayName: shared ? `${name} (${codexText(group.name)})` : name,
        supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
        ...(defaults ? { defaultReasoningEffort: defaults } : {}) }];
    });
  }

  async request(method: string, params: Frame): Promise<Frame> {
    const threadId = codexText(params.threadId);
    if (method === 'thread/start') {
      const created = await (await this.connect()).request('session/new', { cwd: this.cwd, mcpServers: [] });
      const id = codexText(created.sessionId);
      if (!id) throw new Error('DSH 会话创建结果待核实');
      this.threadId = id;
      this.config = codexItems(created.configOptions);
      // A new session takes the preset of its launch, which the executor fixes to the middle one.
      this.preset = PRESET.workspaceWrite;
      return this.selection();
    }
    if (method === 'thread/resume') {
      const acp = await this.connect();
      const resumed = await acp.request('session/resume', { sessionId: threadId, cwd: this.cwd, mcpServers: [] }).catch(resumeFailure);
      this.threadId = threadId;
      this.config = codexItems(resumed.configOptions);
      this.preset = await this.recordedPreset(threadId);
      return this.selection();
    }
    if (method === 'thread/turns/list') return readDshTurns(threadId, this.cwd, codexText(params.cursor) || null, Number(params.limit) || 20);
    if (method === 'model/list') return { data: await this.models() };
    // DSH exposes no plan mode over ACP.
    if (method === 'collaborationMode/list') return { data: [] };
    if (method === 'turn/start') return this.send(params);
    if (method === 'turn/interrupt') {
      if (!this.turn || params.turnId !== this.turn.id) throw new CodexRejected('该轮已结束，请刷新会话');
      this.turn.cancelled = true;
      (await this.connect()).notify('session/cancel', { sessionId: this.threadId });
      return {};
    }
    throw new CodexRejected('本机不支持这个会话操作');
  }

  private async selectPermission(preset: string) {
    if (preset === this.preset) return;
    const answer = await this.bridge?.call<{ current?: unknown }>('permission.set', { sessionId: this.threadId, preset }) ?? null;
    if (!answer) throw new CodexRejected('DSH 权限桥接未加载，暂时无法切换权限档位');
    this.preset = codexText(answer.current) || preset;
  }

  private async send(params: Frame) {
    if (this.turn) throw new CodexRejected('当前轮仍在运行，请稍候再试');
    const acp = await this.connect();
    const model = codexText(params.model);
    if (model && model !== this.current('model')) {
      this.config = codexItems((await acp.request('session/set_config_option', { sessionId: this.threadId, configId: 'model', value: model })).configOptions);
    }
    const effort = codexText(params.effort);
    // An effort the selected model does not offer keeps the provider default instead of failing the turn.
    if (effort && effort !== this.current('reasoning_effort')) {
      this.config = codexItems(await acp.request('session/set_config_option', { sessionId: this.threadId, configId: 'reasoning_effort', value: effort })
        .catch(() => ({ configOptions: this.config })).then((result) => result.configOptions));
    }
    const policy = asObject(params.sandboxPolicy).type;
    const preset = typeof policy === 'string' && policy in PRESET ? PRESET[policy as keyof typeof PRESET] : undefined;
    if (preset) await this.selectPermission(preset);
    const inputs = codexItems(params.input);
    const images = inputs.flatMap((part) => {
      const image = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(codexText(part.url));
      return image ? [{ type: 'image', mimeType: image[1], data: image[2] }] : [];
    });
    if (images.length && !this.image) throw new CodexRejected('DSH 当前模型不支持图片附件');
    const id = codexText(params.clientUserMessageId) || randomUUID();
    const text = inputs.filter((part) => part.type === 'text').map((part) => codexText(part.text)).join('\n');
    // The prompt request settles when the turn ends, so it is observed apart from the start result.
    const settled = acp.request('session/prompt', { sessionId: this.threadId, prompt: [{ type: 'text', text }, ...images] }, 0);
    this.turn = { id, cancelled: false, bridged: this.bridgeReady };
    this.emit('turn/started', { turn: { id, status: 'inProgress' } });
    this.emit('item/completed', { turnId: id, item: { id, clientId: id, type: 'userMessage', content: inputs.filter((part) => part.type === 'text') } });
    void settled.then((result) => this.finish(codexText(result.stopReason)), (error: Error) => this.finish('', error));
    return { turn: { id, status: 'inProgress' } };
  }

  private async finish(stopReason: string, error?: Error) {
    const turn = this.turn;
    if (!turn) return;
    // The plugin queues its commits on an independent socket. Its next reply comes after those commits.
    if (this.pendingText.size || this.stream) await this.bridge?.call('ping', {}, 1_000);
    const last = [...this.pendingText.keys()].at(-1);
    for (const [messageId, { texts, commentary }] of this.pendingText) {
      this.settled.add(messageId);
      for (const [index, text] of texts.entries()) {
        const block = messageId === last && [...this.stream?.blocks.entries() ?? []]
          .find(([, value]) => text.startsWith(value.text));
        if (block) this.stream?.blocks.delete(block[0]);
        this.emit('item/completed', { turnId: turn.id, item: { id: block ? block[1].id : `${messageId}#${index}`, type: 'agentMessage',
          text, phase: commentary ? 'commentary' : 'final_answer' } });
      }
    }
    this.pendingText.clear();
    // Streamed text that never committed is kept as commentary so no placeholder stays open.
    this.closeStream();
    this.turn = null;
    this.tools.clear();
    this.plain.clear();
    const status = turn.cancelled || stopReason === 'cancelled' ? 'interrupted'
      : stopReason === 'end_turn' || stopReason === 'max_tokens' ? 'completed' : 'failed';
    this.emit('turn/completed', { turn: { id: turn.id, status,
      ...(status === 'failed' ? { error: (error?.message || 'DSH 当前轮执行失败').slice(0, 500) } : {}) } });
  }

  private closeStream() {
    const stream = this.stream;
    this.stream = null;
    for (const { id, text } of stream?.blocks.values() ?? []) {
      this.emit('item/completed', { turnId: this.turn?.id, item: { id, type: 'agentMessage', text: text.slice(0, 24_000), phase: 'commentary' } });
    }
  }

  private onBridge(event: string, params: Frame) {
    const turn = this.turn;
    if (!turn?.bridged || params.sessionId !== this.threadId) return;
    if (event === 'stream-start') {
      this.closeStream();
      this.stream = { attempt: ++this.attempts, open: true, blocks: new Map() };
    } else if (event === 'text-delta' && this.stream?.open) {
      const index = Number(params.index);
      const delta = codexText(params.text);
      if (!Number.isInteger(index) || !delta) return;
      let block = this.stream.blocks.get(index);
      if (!block) {
        block = { id: `dsh-${this.stream.attempt}-${index}`, text: '' };
        this.stream.blocks.set(index, block);
        this.emit('item/started', { turnId: turn.id, item: { id: block.id, type: 'agentMessage', text: '' } });
      }
      block.text = (block.text + delta).slice(0, 24_000);
      this.emit('item/agentMessage/delta', { turnId: turn.id, itemId: block.id, delta });
    } else if (event === 'message') {
      const messageId = codexText(params.messageId);
      if (this.settled.has(messageId)) return;
      this.pendingText.delete(messageId);
      if (messageId) this.settled.add(messageId);
      for (const { index, text } of codexItems(params.texts)) {
        const streamed = this.stream?.blocks.get(Number(index));
        this.stream?.blocks.delete(Number(index));
        // The committed text is authoritative; a block that never streamed is still shown in full.
        this.emit('item/completed', { turnId: turn.id, item: { id: streamed?.id ?? `${messageId}#${index}`, type: 'agentMessage',
          text: codexText(text).slice(0, 24_000), phase: params.tools === true ? 'commentary' : 'final_answer' } });
      }
      this.closeStream();
    } else if (event === 'stream-end' && params.outcome !== 'committed') this.closeStream();
  }

  private onMessage(method: string, params: Frame, id?: number | string) {
    if (id !== undefined) {
      if (method === 'session/request_permission') this.approval(id, params);
      else this.acp?.respond(id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    if (method !== 'session/update') return;
    const update = asObject(params.update);
    const turn = this.turn;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const messageId = codexText(update.messageId);
        if (!turn || this.settled.has(messageId)) return;
        const content = asObject(update.content);
        if (content.type !== 'text') return;
        const text = codexText(content.text).slice(0, 24_000);
        if (turn.bridged && messageId) {
          const pending = this.pendingText.get(messageId) ?? { texts: [], commentary: false };
          pending.texts.push(text);
          this.pendingText.set(messageId, pending);
          return;
        }
        const itemId = `${messageId}#${this.plain.size}`;
        this.plain.set(itemId, text);
        this.emit('item/completed', { turnId: turn.id, item: { id: itemId, type: 'agentMessage', text, phase: 'final_answer' } });
        return;
      }
      case 'tool_call': {
        if (!turn) return;
        // Text that precedes a tool call in the same step is commentary rather than the answer.
        for (const pending of this.pendingText.values()) pending.commentary = true;
        for (const [itemId, text] of this.plain) {
          this.emit('item/completed', { turnId: turn.id, item: { id: itemId, type: 'agentMessage', text, phase: 'commentary' } });
        }
        this.plain.clear();
        const toolCallId = codexText(update.toolCallId);
        const raw = asObject(update.rawInput);
        const kind = dshToolKind(codexText(update.title), raw, this.cwd);
        if (!toolCallId || !kind) return;
        const item = { id: toolCallId, ...kind };
        this.tools.set(toolCallId, { ...item, description: codexText(raw.description) });
        this.emit('item/started', { turnId: turn.id, item });
        return;
      }
      case 'tool_call_update': {
        if (!turn) return;
        const base = this.tools.get(codexText(update.toolCallId));
        if (!base) return;
        this.tools.delete(codexText(update.toolCallId));
        const { description: _description, ...item } = base;
        const output = codexItems(update.content).map((part) => codexText(asObject(part.content).text)).join('\n');
        this.emit('item/completed', { turnId: turn.id, item: { ...item, status: update.status === 'failed' ? 'failed' : 'completed',
          ...(output ? { aggregatedOutput: output.slice(0, 16_000) } : {}) } });
        return;
      }
      case 'usage_update': {
        if (!turn || typeof update.used !== 'number' || !Number.isSafeInteger(update.used) || update.used < 0) return;
        const limit = typeof update.size === 'number' && Number.isSafeInteger(update.size) ? update.size : null;
        this.emit('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: update.used }, total: { totalTokens: update.used },
          ...(limit ? { modelContextWindow: limit } : {}) } });
        return;
      }
      case 'config_option_update':
        this.config = codexItems(update.configOptions);
    }
  }

  private approval(id: number | string, params: Frame) {
    const turn = this.turn;
    const base = this.tools.get(codexText(asObject(params.toolCall).toolCallId));
    // A request outside a Dovun turn, or for a tool this runtime never showed, is declined rather than left pending.
    if (!turn || !base || !this.acp) {
      this.acp?.respond(id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const command = base.type === 'commandExecution';
    this.emit(command ? 'item/commandExecution/requestApproval' : 'item/tool/requestApproval', {
      turnId: turn.id, ...(command ? { command: base.command } : { description: base.tool }),
      ...(base.description ? { reason: base.description } : {}), availableDecisions: ['accept', 'decline'],
    }, id);
  }

  async reply(id: number | string, result: Frame) {
    if (!this.acp) throw new CodexRejected('这条权限请求已处理或决定无效');
    this.acp.respond(id, { outcome: { outcome: 'selected', optionId: result.decision === 'accept' ? 'allow-once' : 'reject-once' } });
    this.emit('serverRequest/resolved', { requestId: id });
  }

  async unsupported(id: number | string) {
    this.acp?.respond(id, { outcome: { outcome: 'cancelled' } });
  }

  async close() {
    this.closing = true;
    const acp = this.acp;
    this.acp = null;
    await acp?.close();
    const bridge = this.bridge;
    this.bridge = null;
    await bridge?.stop();
  }
}
