import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { providerEnvironment } from '../runner/environment.js';
import { runtimeEnv } from '../shared/runtime-env.js';
import { asObject, CodexRejected, type HarnessNotification, type HarnessRuntime } from './harness-codex.js';
import { codexItems as items, codexText as text } from './harness-history.js';
import { grokSessionExists, grokToolCategory, grokToolFeed, grokToolItem, grokTurnStatus, readGrokThread, readGrokTurns, type GrokToolState } from './harness-grok-library.js';
import { HARNESS_TEXT_LIMIT, grokPermissionMode } from './harness-protocol.js';

const exec = promisify(execFile);
/** Harness display name reused by the shared message templates in the server locale. */
const GROK = 'Grok';

type RpcId = string | number;
type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type TurnState = {
  id: string;
  clientMessageId?: string;
  runs: number;
  run: { id: string; text: string; thought: boolean; index: number } | null;
};

/** Resolves the native CLI: `GROK_BIN` overrides, otherwise the first `grok` on the process PATH. */
export async function resolveGrokCli() {
  const configured = runtimeEnv('GROK_BIN');
  if (configured) {
    const path = resolve(configured);
    await access(path);
    return /\.[cm]?js$/i.test(path) ? { command: process.execPath, prefix: [path] } : { command: path, prefix: [] as string[] };
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const found = join(directory, 'grok' + (process.platform === 'win32' ? '.exe' : ''));
    if (await access(found).then(() => true, () => false)) return { command: found, prefix: [] as string[] };
  }
  throw new Error('本机没有找到 grok CLI（可用 GROK_BIN 指定）');
}

/** Version-gated availability for node capability reporting; probes the real installed binary. */
export async function grokAvailable() {
  try {
    const cli = await resolveGrokCli();
    if (!(await stat(cli.command).catch(() => null))?.isFile()) return null;
    const { stdout } = await exec(cli.command, [...cli.prefix, '--version'], { timeout: 15_000, windowsHide: true });
    const version = /^(?:grok\s+)?v?(\d+)\.(\d+)\.(\d+)/i.exec(stdout.trim());
    if (!version || Number(version[1]) < 1) return null;
    return { path: (cli.prefix[0] ?? cli.command).slice(0, 200), version: stdout.trim().slice(0, 200) };
  } catch { return null; }
}

function configValue(configOptions: unknown, configId: string) {
  const option = items(configOptions).find((entry) => text(entry.id) === configId);
  return option ? text(option.currentValue) : '';
}

/**
 * Grok CLI adapter over the Agent Client Protocol (`grok agent stdio`): JSON-RPC 2.0 on stdio.
 * Maps ACP sessions and updates onto the shared Codex-shaped harness contract.
 */
export class GrokAgentRuntime implements HarnessRuntime {
  private cursor = 0;
  private active = true;
  private closing = false;
  private readonly pending = new Map<number, Pending>();
  private child?: ChildProcessWithoutNullStreams;
  private sessionId?: string;
  private meta: Record<string, unknown> = {};
  private configOptions: unknown = null;
  private modes: { current: string; available: string[] } = { current: 'default', available: [] };
  private models: Array<Record<string, unknown>> = [];
  private authMethods: string[] = [];
  private turn: TurnState | null = null;
  private tools = new Map<string, GrokToolState>();
  private lastTurnId = '';
  private readonly approvals = new Map<RpcId, Array<Record<string, unknown>>>();

  private constructor(private readonly cwd: string, private readonly notify: HarnessNotification, private readonly disconnected: () => void) {}

  get pid() { return this.child?.pid; }

  static async open(cwd: string, notify: HarnessNotification, disconnected: () => void) {
    const runtime = new GrokAgentRuntime(cwd, notify, disconnected);
    await runtime.spawn();
    try {
      const init = await runtime.call('initialize', { protocolVersion: 1, clientCapabilities: {} }, 90_000);
      const meta = asObject(init._meta);
      runtime.authMethods = items(meta.authMethods).map((method) => text(method.id)).filter(Boolean)
        .concat(typeof meta.defaultAuthMethodId === 'string' ? [meta.defaultAuthMethodId] : []);
      runtime.models = items(asObject(meta.modelState).availableModels);
      if (!runtime.models.length) throw new Error('Grok 没有返回可用模型');
      return runtime;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  private async spawn() {
    const cli = await resolveGrokCli();
    this.child = spawn(cli.command, [...cli.prefix, 'agent', 'stdio'], {
      cwd: this.cwd, env: providerEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Grok diagnostics can include account and configuration details.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    // The child staying alive is the steady state; closing the process notifies the controller.
    this.child.once('close', () => {
      lines.close();
      this.active = false;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`${GROK} 连接已断开，操作结果待核实`));
      }
      this.pending.clear();
      if (!this.closing) this.disconnected();
    });
    lines.on('line', (line) => this.receive(line));
    this.child.stdin.on('error', () => undefined);
    this.child.once('error', () => undefined);
  }

  private receive(line: string) {
    let message: Record<string, unknown>;
    try { message = asObject(JSON.parse(line)); } catch { return; }
    const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
    if (typeof message.method === 'string') {
      this.onNative(String(message.method), asObject(message.params), id);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const native = text(asObject(message.error).message);
      pending.reject(new CodexRejected(native === 'Authentication required'
        ? 'Grok 需要登录，请先在本机终端运行 grok login'
        : `${GROK} 拒绝了操作，请刷新会话状态后重试`));
    } else pending.resolve(asObject(message.result));
  }

  private write(method: string, params: Record<string, unknown>) {
    if (!this.active) return Promise.reject(new Error(`${GROK} 连接已断开，操作结果待核实`));
    return new Promise<void>((resolveWrite, rejectWrite) => {
      this.child!.stdin.write(JSON.stringify({ id: ++this.cursor, method, params }) + '\n', (error) => error ? rejectWrite(error) : resolveWrite());
    });
  }

  private call(method: string, params: Record<string, unknown>, timeout: number) {
    const id = ++this.cursor;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${GROK} 响应超时，操作结果待核实`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      void this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private adopt(session: Record<string, unknown>) {
    const id = text(session.sessionId);
    if (!id) throw new CodexRejected('Grok 会话结果待核实');
    this.sessionId = id;
    this.configOptions = session.configOptions ?? null;
    const state = asObject(session.modes);
    this.modes = {
      current: text(state.currentModeId) || 'default',
      available: items(state.availableModes).map((mode) => text(mode.id)).filter(Boolean),
    };
    this.turn = null;
  }

  private selection() {
    return {
      model: configValue(this.configOptions, 'model') || text(asObject(this.models[0]).modelId),
      reasoningEffort: configValue(this.configOptions, 'reasoning_effort') || null,
      collaborationMode: { mode: this.modes.current === 'plan' ? 'plan' : 'default' },
      sandbox: { type: 'workspace-write' },
      modelProvider: 'grok',
    };
  }

  private emit(method: string, params: Record<string, unknown>) {
    this.notify(method, { threadId: this.sessionId, ...params });
  }

  private closeMessageRun(final: boolean) {
    const turn = this.turn;
    if (!turn?.run) return;
    const phase = turn.run.thought || !final ? 'commentary' : 'final_answer';
    const item = { id: turn.run.id, type: 'agentMessage', text: turn.run.text.slice(0, HARNESS_TEXT_LIMIT), phase };
    this.emit('item/completed', { turnId: turn.id, item });
    turn.run = null;
  }

  private messageRun(chunk: string, thought: boolean) {
    const turn = this.turn;
    if (!turn) return;
    if (!turn.run || turn.run.thought !== thought) {
      this.closeMessageRun(false);
      turn.run = { id: `${turn.id}:${thought ? 'thought' : 'answer'}:${turn.runs++}`, text: '', thought, index: 0 };
      this.emit('item/started', { turnId: turn.id, item: { id: turn.run.id, type: 'agentMessage', text: '', phase: thought ? 'commentary' : undefined } });
    }
    turn.run.text += chunk;
    this.emit('item/agentMessage/delta', { turnId: turn.id, itemId: turn.run.id, delta: chunk.slice(0, HARNESS_TEXT_LIMIT) });
  }

  private onNative(method: string, params: Record<string, unknown>, id?: RpcId) {
    if (method === 'session/request_permission' && id !== undefined) {
      this.onPermissionRequest(params, id);
      return;
    }
    if (id !== undefined) {
      void this.unsupported(id).catch(() => undefined);
      return;
    }
    if (method !== 'session/update' && method !== '_x.ai/session/update') return;
    const update = asObject(params.update);
    const kind = text(update.sessionUpdate);
    if (method === '_x.ai/session/update' && kind !== 'plan' && kind !== 'current_mode_update') return;
    const turn = this.turn;
    switch (kind) {
      case 'user_message_chunk': {
        if (!turn) return;
        const body = text(asObject(update.content).text);
        if (!body) return;
        const item = { id: `${turn.id}:user`, type: 'userMessage',
          content: [{ type: 'text', text: body.slice(0, HARNESS_TEXT_LIMIT) }],
          ...(turn.clientMessageId ? { clientId: turn.clientMessageId } : {}) };
        this.emit('item/started', { turnId: turn.id, item: { ...item, text: '' } });
        this.emit('item/completed', { turnId: turn.id, item });
        return;
      }
      case 'agent_message_chunk':
        this.messageRun(text(asObject(update.content).text), false);
        return;
      case 'agent_thought_chunk':
        this.messageRun(text(asObject(update.content).text), true);
        return;
      case 'tool_call':
      case 'tool_call_update': {
        if (!turn) return;
        this.closeMessageRun(false);
        const known = this.tools.has(text(update.toolCallId));
        const state = grokToolFeed(this.tools, update);
        if (!state) return;
        const done = state.status === 'completed' || state.status === 'failed';
        const item = grokToolItem(state, done);
        if (!item) return;
        // A tool call streams several rows; only the first and the finishing row become contract events.
        if (!known) this.emit('item/started', { turnId: turn.id, item });
        else if (done) this.emit('item/completed', { turnId: turn.id, item });
        return;
      }
      case 'plan': {
        if (!turn) return;
        const steps = items(update.entries).slice(0, 30).flatMap((entry) => {
          const label = text(asObject(entry.content).text).slice(0, 1_000);
          const state = text(entry.state);
          const status = state === 'in_progress' ? 'inProgress' : state === 'completed' ? 'completed' : 'pending';
          return label ? [{ step: label, status }] : [];
        });
        this.emit('turn/plan/updated', { turnId: turn.id, plan: steps, explanation: '' });
        return;
      }
      case 'current_mode_update':
        this.modes = { ...this.modes, current: text(update.currentModeId) || this.modes.current };
        return;
      default:
        return;
    }
  }

  private onPermissionRequest(params: Record<string, unknown>, id: RpcId) {
    const turn = this.turn;
    const toolCall = asObject(params.toolCall);
    const options = items(params.options);
    const category = grokToolCategory(grokToolFeed(new Map(), toolCall) ?? { name: '', kind: '' });
    const method = category === 'execute' ? 'item/commandExecution/requestApproval'
      : category === 'edit' ? 'item/fileChange/requestApproval' : 'item/tool/requestApproval';
    if (!turn || !options.length) {
      void this.unsupported(id).catch(() => undefined);
      return;
    }
    this.approvals.set(id, options);
    const title = text(toolCall.title);
    this.notify(method, {
      threadId: this.sessionId, turnId: turn.id, ...(category === 'execute' ? { command: title } : { description: title }),
      reason: '', itemId: text(toolCall.toolCallId), availableDecisions: ['accept', 'decline', 'cancel'],
    }, id);
  }

  /** Applies per-turn settings (model, effort, plan mode) before the prompt reaches Grok. */
  private async applyTurnSettings(params: Record<string, unknown>) {
    if (!this.sessionId) return;
    const model = text(params.model);
    const effort = text(params.effort);
    const mode = text(asObject(params.collaborationMode).mode);
    if (model && model !== configValue(this.configOptions, 'model')) {
      this.configOptions = await this.call('session/set_config_option',
        { sessionId: this.sessionId, configId: 'model', value: { value: model } }, 30_000);
    }
    if (effort && effort !== configValue(this.configOptions, 'reasoning_effort')) {
      this.configOptions = await this.call('session/set_config_option',
        { sessionId: this.sessionId, configId: 'reasoning_effort', value: { value: effort } }, 30_000);
    }
    const nextMode = mode === 'plan' ? 'plan' : 'default';
    if (nextMode !== this.modes.current && (!this.modes.available.length || this.modes.available.includes(nextMode))) {
      await this.call('session/set_mode', { sessionId: this.sessionId, modeId: nextMode }, 30_000);
      this.modes = { ...this.modes, current: nextMode };
    }
  }

  /** Grok only sets the permission baseline at session creation; a different mode restarts the agent process. */
  private async reopenWithMode(meta: Record<string, unknown>) {
    const sessionId = this.sessionId;
    if (!sessionId) throw new CodexRejected('Grok 会话尚未创建');
    this.closing = true;
    this.active = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${GROK} 连接已断开，操作结果待核实`));
    }
    this.pending.clear();
    this.child!.stdin.end();
    await new Promise<void>((resolve) => this.child!.once('close', () => resolve()));
    this.closing = false;
    this.active = true;
    await this.spawn();
    await this.call('initialize', { protocolVersion: 1, clientCapabilities: {} }, 90_000);
    const loaded = await this.call('session/load', { sessionId, cwd: this.cwd, mcpServers: [], _meta: meta }, 120_000);
    this.adopt({ ...asObject(loaded), sessionId });
  }

  private async applyPermissionMode(mode: string) {
    if (!this.sessionId) return;
    const requested = grokPermissionMode.safeParse(mode);
    if (!requested.success) return;
    const wantsYolo = requested.data === 'bypassPermissions';
    const wantsAuto = requested.data === 'auto';
    const currentYolo = this.meta.yoloMode === true;
    const currentAuto = this.meta.autoMode === true;
    if (wantsYolo !== currentYolo || wantsAuto !== currentAuto) {
      this.meta = wantsYolo ? { yoloMode: true } : wantsAuto ? { autoMode: true } : {};
      await this.reopenWithMode(this.meta);
    }
  }

  private async newSession(cwd: string) {
    const created = await this.call('session/new', { cwd, mcpServers: [], _meta: this.meta }, 120_000);
    this.adopt(created);
    return { thread: { id: this.sessionId }, ...this.selection() };
  }

  private async loadSession(threadId: string) {
    if (!(await grokSessionExists(this.cwd, threadId).catch(() => false))) {
      throw new CodexRejected('这条对话不在所选项目目录中');
    }
    const loaded = await this.call('session/load', { sessionId: threadId, cwd: this.cwd, mcpServers: [], _meta: this.meta }, 120_000);
    this.adopt({ ...loaded, sessionId: threadId });
    return { thread: { id: threadId }, ...this.selection() };
  }

  private async startTurn(params: Record<string, unknown>) {
    const blocks = items(params.input);
    if (blocks.some((block) => block.type === 'image')) throw new CodexRejected('Grok 会话暂不支持图片附件');
    const prompt = blocks.flatMap((block) => block.type === 'text' && text(block.text) ? [{ type: 'text', text: text(block.text) }] : []);
    if (!prompt.length) throw new CodexRejected('消息内容为空');
    if (params.permissionMode !== undefined) await this.applyPermissionMode(text(params.permissionMode));
    await this.applyTurnSettings(params);
    const turnId = randomUUID();
    this.turn = { id: turnId, clientMessageId: text(params.clientUserMessageId) || undefined, runs: 0, run: null };
    this.tools.clear();
    const item = { id: `${turnId}:user`, type: 'userMessage',
      content: [{ type: 'text', text: prompt.map((block) => block.text).join('\n').slice(0, HARNESS_TEXT_LIMIT) }],
      ...(this.turn.clientMessageId ? { clientId: this.turn.clientMessageId } : {}) };
    this.emit('item/started', { turnId, item: { ...item, text: '' } });
    this.emit('item/completed', { turnId, item });
    const id = ++this.cursor;
    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.turn = null;
      this.emit('turn/completed', { turn: { id: turnId, status: 'failed', error: 'Grok 当前轮超时，结果待核实' } });
      this.lastTurnId = turnId;
    }, 30 * 60_000);
    this.pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        const status = grokTurnStatus(text(result.stopReason));
        this.closeMessageRun(status === 'completed');
        const turn = { id: turnId, status, ...(status === 'failed' ? { error: `${GROK} 当前轮执行失败` } : {}) };
        this.turn = null;
        this.lastTurnId = turnId;
        this.emit('turn/completed', { turn });
      },
      reject: (error) => {
        clearTimeout(timer);
        this.closeMessageRun(false);
        this.turn = null;
        this.lastTurnId = turnId;
        this.emit('turn/completed', { turn: { id: turnId, status: 'failed', error: error.message.slice(0, 500) } });
      },
      timer,
    });
    void this.child!.stdin.write(JSON.stringify({ id, method: 'session/prompt', params: { sessionId: this.sessionId, prompt } }) + '\n');
    return { turn: { id: turnId, status: 'inProgress' } };
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (method) {
      case 'thread/start': return this.newSession(text(params.cwd) || this.cwd);
      case 'thread/resume': return this.loadSession(text(params.threadId));
      case 'thread/read': {
        const thread = readGrokThread(text(params.threadId), this.cwd);
        return thread.then((row) => {
          if (!row) throw new CodexRejected('这条对话不在所选项目目录中');
          return row as Record<string, unknown>;
        });
      }
      case 'thread/turns/list': {
        const page = readGrokTurns(text(params.threadId), this.cwd,
          typeof params.cursor === 'string' && params.cursor ? params.cursor : null,
          Math.max(1, Math.min(50, Number(params.limit) || 12)));
        return page as unknown as Promise<Record<string, unknown>>;
      }
      case 'turn/start': return this.startTurn(params);
      case 'turn/interrupt':
        if (!this.active || !this.sessionId) throw new CodexRejected(`${GROK} 连接已断开，操作结果待核实`);
        return this.write('session/cancel', { sessionId: this.sessionId }).then(() => ({}));
      case 'model/list':
        return Promise.resolve({ data: this.models.map((model) => {
          const meta = asObject(model._meta);
          const efforts = items(meta.reasoningEfforts);
          return { model: text(model.modelId), displayName: text(model.name),
            supportedReasoningEfforts: efforts.map((effort) => ({ reasoningEffort: text(effort.id) })).filter((effort) => effort.reasoningEffort),
            defaultReasoningEffort: text(efforts.find((effort) => effort.default === true)?.id) };
        }) });
      case 'collaborationMode/list':
        return Promise.resolve({ data: this.modes.available.includes('plan')
          ? [{ mode: 'default' }, { mode: 'plan' }] : [{ mode: 'default' }] });
      default:
        return Promise.reject(new CodexRejected('本机不支持这个会话操作'));
    }
  }

  reply(id: RpcId, result: Record<string, unknown>): Promise<void> {
    const options = this.approvals.get(id) ?? [];
    this.approvals.delete(id);
    const optionId = (prefix: string) => text((options.find((option) => text(option.kind) === prefix)
      ?? options.find((option) => text(option.kind).startsWith(prefix)))?.optionId);
    const decision = text(result.decision);
    const selected = decision === 'accept' ? optionId('allow_once') || optionId('allow')
      : decision === 'acceptForSession' ? optionId('allow_always') || optionId('allow')
        : decision === 'decline' ? optionId('reject_once') || optionId('reject') : '';
    const outcome = decision === 'cancel' || !selected ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: selected };
    const respond = this.active
      ? new Promise<void>((resolve, reject) => {
        this.child!.stdin.write(JSON.stringify({ id, result: { outcome } }) + '\n', (error) => error ? reject(error) : resolve());
      })
      : Promise.reject(new Error(`${GROK} 连接已断开，操作结果待核实`));
    // Grok confirms the reply only through the tool's next update, so acknowledge locally.
    return respond.then(() => {
      this.emit('serverRequest/resolved', { requestId: id });
    });
  }

  unsupported(id: RpcId): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => {
      this.child!.stdin.write(JSON.stringify({ id, error: { code: -32601, message: 'Unsupported request' } }) + '\n', () => resolve());
    });
  }

  async close() {
    this.closing = true;
    this.active = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${GROK} 连接已断开，操作结果待核实`));
    }
    this.pending.clear();
    const child = this.child;
    child?.stdin.end();
    if (child && child.exitCode === null && child.signalCode === null) {
      const terminate = setTimeout(() => child.kill('SIGTERM'), 500);
      const kill = setTimeout(() => child.kill('SIGKILL'), 2_000);
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
      clearTimeout(terminate);
      clearTimeout(kill);
    }
  }
}
