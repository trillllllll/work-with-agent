import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { exclusiveDataGuard } from '../shared/data-guard.js';
import { asObject, CodexAppServer, CodexRejected, type HarnessNotification, type HarnessRuntime } from './harness-codex.js';
import { ClaudeHarnessRuntime } from './harness-claude.js';
import { readHarnessArtifacts } from './harness-artifacts.js';
import { codexInput } from './harness-files.js';
import { codexText as text, codexItems as items, codexMessage as message, codexTurn as turn, projectCodexHistory } from './harness-history.js';
import { assertNativeThreadIdle, readProjectThread } from './harness-library.js';
import { changeCodexSelection, codexModelId, codexTurnSettings, readCodexSelection, readCodexSettings } from './harness-settings.js';
import { codexHarnessTool, harnessFilePaths, harnessFileDiffs, harnessOutput } from './harness-tools.js';
import { assertAllowed } from './git.js';
import {
  applyHarnessEvent, HARNESS_ATTACHMENT_TEXT_PREFIX, HARNESS_EVENTS, HARNESS_TEXT_LIMIT, harnessEventForClient, harnessSnapshotForClient, requiresHarnessWorkspace,
  type HarnessDelivery, type HarnessEvent, type HarnessLease,
  type HarnessApproval, type HarnessCommand, type HarnessInputAttachment, type HarnessKind, type HarnessQueue, type HarnessQueueItem, type HarnessReceipt,
  type HarnessSettingsSelection, type HarnessSnapshot, type HarnessSync, type HarnessView,
} from './harness-protocol.js';

type SavedQueueItem = HarnessQueueItem & { attachments?: HarnessInputAttachment[] };
type SavedQueue = { revision: number; items: SavedQueueItem[] };
type Binding = {
  sessionId: string; threadId: string; cwd: string; epoch: number; pid?: number; native?: true; parked?: true;
  modelProvider?: string; settings?: HarnessSettingsSelection; settingsCommand?: string;
  queue?: SavedQueue; queueCommand?: string;
};
type Assignment = HarnessLease & { nativeCwd?: string };
type SavedCommand = { hash: string; receipt: HarnessReceipt | null };
type Sync = (sessionId: string, payload: HarnessSync) => Promise<{ snapshotRequested?: boolean }>;
type RpcId = number | string;
type Notification = { method: string; params: Record<string, unknown>; id?: RpcId };

const emptyView = (): HarnessView => ({ messages: [], turn: null, approvals: [], error: null });
const sessionOptions = { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const failure = (error: unknown) => (error instanceof Error ? error : new Error('本机操作失败')).message.slice(0, 500);
const queueView = (queue?: SavedQueue): HarnessQueue => ({
  revision: queue?.revision ?? 0, items: queue?.items.map(({ attachments: _attachments, ...item }) => item) ?? [],
});

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function writeJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID();
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, file);
}

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export class HarnessController {
  private readonly directory: string;
  private release?: Awaited<ReturnType<typeof exclusiveDataGuard>>;
  private binding: Binding | null = null;
  private app: HarnessRuntime | null = null;
  private opening: Promise<HarnessRuntime> | null = null;
  private appClose: Promise<void> | null = null;
  private view = emptyView();
  private restoredClients = new Set<string>();
  private approvals = new Map<string, { id: RpcId; method: string; permissions: Record<string, unknown> }>();
  private approvalAcks = new Map<RpcId, { requestId: string; finish: (error?: unknown) => void }>();
  private fileChanges = new Map<string, string>();
  private seq = 0;
  private events: Array<{ seq: number; event: HarnessEvent }> = [];
  private snapshotNeeded = false;
  private upload: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private work: Promise<void> | null = null;
  private retryAt = 0;
  private stopped = false;
  private timeline = false;
  private settingsEnabled = false;
  private workspace = false;
  private workspaceSandbox: Record<string, unknown> = {};
  private attaching: { threadId: string; notifications: Notification[] } | null = null;
  private lastWork = Date.now();

  constructor(dataDir: string, nodeKey: string, private readonly roots: string[], private readonly sync: Sync,
    private readonly library = false, private readonly harness: HarnessKind = 'codex') {
    this.directory = resolve(dataDir, 'harness', digest(nodeKey));
  }

  private get bindingPath() { return resolve(this.directory, 'session.json'); }

  consume(lease: Assignment, timeline = false, settings = false, workspace = false) {
    if (this.stopped || this.work) return;
    this.work = this.processLease(lease, timeline, settings, workspace).finally(() => {
      this.work = null;
      this.lastWork = Date.now();
      this.drainQueue();
    });
    return this.work;
  }

  private async processLease(lease: Assignment, timeline: boolean, settings: boolean, workspace: boolean) {
    if (!this.release) this.release = await exclusiveDataGuard([resolve(this.directory, 'owner')]);
    if (this.timeline !== timeline || this.settingsEnabled !== settings || this.workspace !== workspace) {
      await this.upload?.catch(() => undefined);
      this.timeline = timeline;
      this.settingsEnabled = settings;
      this.workspace = workspace;
      this.events = [];
      this.snapshotNeeded = true;
    }
    if (this.stopped) { await this.close(); return; }
    if (this.binding?.sessionId !== lease.sessionId) {
      if (this.app) await this.dropApp();
      const saved = await readJson<Binding>(this.bindingPath);
      this.binding = saved?.sessionId === lease.sessionId ? saved : null;
    }
    let parkedEpoch: number | undefined;
    if (!this.app && (this.binding || lease.threadId) && Date.now() >= this.retryAt) {
      try {
        if (!this.binding && (!lease.nativeCwd || !lease.threadId || lease.epoch !== 0)) throw new Error('找不到本机保存的会话绑定');
        const prior = this.binding ?? { sessionId: lease.sessionId, threadId: lease.threadId!,
          cwd: await assertAllowed(lease.nativeCwd!, this.roots), epoch: 0, native: true as const };
        if (await this.restore(lease, prior)) parkedEpoch = prior.epoch;
        this.retryAt = 0;
      }
      catch (error) {
        this.retryAt = Date.now() + 15_000;
        await this.sync(lease.sessionId, { type: 'unavailable', epoch: lease.epoch, error: failure(error) });
      }
    }
    if (this.settingsEnabled && this.app && this.binding?.settings && !this.view.settings) {
      this.emit({ kind: 'settings', settings: await this.settings(this.app, this.binding.settings, this.binding) });
      this.snapshotNeeded = true;
    }
    if (this.workspace && this.binding && !this.view.queue) {
      this.view = { ...this.view, queue: queueView(this.binding.queue) };
      this.snapshotNeeded = true;
    }
    if (lease.snapshotRequested && this.app) this.snapshotNeeded = true;
    await this.flush();
    for (const delivery of lease.commands) {
      if (this.stopped || delivery.sessionId !== lease.sessionId) break;
      await this.execute(delivery, lease.epoch, lease.threadId, parkedEpoch);
    }
  }

  private async open(cwd: string, modelProvider?: string, shared = false) {
    if (this.harness === 'zcode') throw new CodexRejected('本机不支持这个会话操作');
    const notification: HarnessNotification = (method, params, id) => {
      if (this.attaching) {
        if (params.threadId === this.attaching.threadId) {
          this.attaching.notifications.push({ method, params, id });
          if (this.attaching.notifications.length > 512) this.attaching.notifications.shift();
        }
      } else this.receive(method, params, id);
    };
    const disconnected = () => {
      if (!this.app) return;
      const binding = this.binding;
      this.app = null;
      this.approvals.clear();
      if (binding && !this.stopped) void this.sync(binding.sessionId, { type: 'unavailable', epoch: binding.epoch, error: '本机会话已断开' }).catch(() => undefined);
    };
    this.opening = this.harness === 'claude' ? Promise.resolve(new ClaudeHarnessRuntime(cwd, notification, disconnected))
      : CodexAppServer.open(cwd, notification, disconnected, { modelProvider, experimental: true, shared });
    try {
      this.app = await this.opening;
      if (this.stopped) { await this.dropApp(); throw new CodexRejected('执行器已停止'); }
      return this.app;
    } finally { this.opening = null; }
  }

  private async openSharedThread(cwd: string, threadId: string) {
    const app = await this.open(cwd, undefined, true).catch(() => null);
    if (!app) return null;
    const thread = await readProjectThread(app, threadId, cwd, this.roots).catch(() => null);
    const status = asObject(thread?.status).type;
    if (thread && (status === 'active' || status === 'idle' || status === 'systemError')) return app;
    await this.dropApp();
    return null;
  }

  private async restore(lease: HarnessLease, prior: Binding) {
    if (lease.threadId && lease.threadId !== prior.threadId) throw new Error('本机保存的线程与服务器绑定不一致');
    if (prior.pid && isAlive(prior.pid)) throw new Error('正在等待原 Codex 进程退出');
    const cwd = await assertAllowed(prior.cwd, this.roots);
    if (cwd !== prior.cwd) throw new Error('项目路径已变化，无法恢复原会话');
    let modelProvider = prior.modelProvider;
    try {
      const owner = prior.native && this.harness === 'codex' ? await this.openSharedThread(cwd, prior.threadId) : null;
      let app = owner ?? await this.open(cwd, modelProvider);
      if (owner) this.attaching = { threadId: prior.threadId, notifications: [] };
      if (!owner && (prior.native || this.settingsEnabled && !modelProvider)) {
        const thread = await readProjectThread(app, prior.threadId, cwd, this.roots);
        if (prior.native) await assertNativeThreadIdle(app, thread, prior.threadId);
        const original = codexModelId(thread.modelProvider);
        if (original && original !== modelProvider) {
          await this.dropApp();
          modelProvider = original;
          app = await this.open(cwd, original);
        }
      }
      const reopened = await app.request('thread/resume', { ...(owner ? {} : { ...sessionOptions, cwd }), threadId: prior.threadId, excludeTurns: true });
      if (asObject(reopened.thread).id !== prior.threadId) throw new Error('Codex 返回了不同的线程');
      const history = await app.request('thread/turns/list', { threadId: prior.threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' });
      const { view, clients } = await projectCodexHistory(history.data, cwd, this.roots, true, Boolean(owner));
      this.view = view;
      this.workspaceSandbox = asObject(reopened.sandbox);
      this.restoredClients = clients;
      this.fileChanges.clear();
      this.approvals.clear();
      const pending = prior.queue;
      const queue = pending?.items.some((item) => item.status === 'starting')
        ? { revision: pending.revision + 1, items: pending.items.flatMap((item): SavedQueueItem[] => {
          if (item.status !== 'starting') return [item];
          return clients.has(item.id) ? [] : [{ ...item, status: 'blocked', error: '消息可能已交给本机会话，请核对历史' }];
        }) } : pending;
      await this.setBinding({
        ...prior, parked: undefined, epoch: Math.max(prior.epoch, lease.epoch) + 1, pid: app.pid,
        modelProvider: codexModelId(reopened.modelProvider) ?? modelProvider,
        settings: prior.settings ?? readCodexSelection(reopened), queue,
      });
      const notifications = this.attaching?.notifications ?? [];
      this.attaching = null;
      const materialized = new Set([...view.messages, ...(view.tools ?? [])].map((item) => item.id));
      for (const { method, params, id } of notifications) {
        if (method.endsWith('/delta') && materialized.has(text(params.itemId))) continue;
        if (method.endsWith('/outputDelta') && materialized.has(text(params.itemId))) continue;
        this.receive(method, params, id);
      }
      return prior.parked === true && prior.epoch === lease.epoch && view.turn?.status !== 'unknown';
    } catch (error) { await this.dropApp(); throw error; }
    finally { this.attaching = null; }
  }

  private async start(sessionId: string, requested: string, epoch: number, threadId: string | null) {
    if (threadId || this.binding) throw new CodexRejected('该会话已绑定到原 Codex 线程');
    let cwd: string;
    try {
      cwd = await assertAllowed(requested, this.roots);
      if (!(await stat(cwd)).isDirectory()) throw new Error('项目位置不是目录');
      await this.open(cwd);
    } catch (error) { throw new CodexRejected(failure(error)); }
    const app = this.app!;
    try {
      const started = await app.request('thread/start', { ...sessionOptions, cwd, ephemeral: false });
      const id = text(asObject(started.thread).id);
      if (!id) throw new Error('Codex 线程创建结果待核实');
      // Naming materializes an empty Codex thread so it can be resumed after execution restarts.
      if (this.library && this.harness === 'codex') await app.request('thread/name/set', { threadId: id, name: 'Dovun' });
      this.view = emptyView();
      this.workspaceSandbox = asObject(started.sandbox);
      const settings = readCodexSelection(started);
      await this.setBinding({
        sessionId, cwd: await realpath(cwd), threadId: id, epoch: epoch + 1, pid: app.pid,
        modelProvider: codexModelId(started.modelProvider) ?? undefined, settings,
      });
      if (this.workspace) this.view = { ...this.view, queue: { revision: 0, items: [] } };
      if (this.settingsEnabled && settings) {
        this.view = { ...this.view, settings: await this.settings(app, settings, this.binding!) };
      }
    } catch (error) { await this.dropApp(); throw error; }
  }

  private async setBinding(binding: Binding) {
    await writeJson(this.bindingPath, binding);
    this.binding = binding;
    this.seq = 0;
    this.events = [];
    this.snapshotNeeded = true;
  }

  private settings(app: HarnessRuntime, selection: HarnessSettingsSelection, binding: Binding) {
    return readCodexSettings(app, selection, this.workspace && this.harness === 'codex' ? { cwd: binding.cwd, provider: binding.modelProvider } : undefined);
  }

  private async execute(delivery: HarnessDelivery, epoch: number, threadId: string | null, parkedEpoch?: number) {
    const { command, sessionId } = delivery;
    const file = resolve(this.directory, 'commands', digest(sessionId + '\0' + command.commandId) + '.json');
    const hash = digest(JSON.stringify(command));
    const prior = await readJson<SavedCommand>(file);
    let receipt: HarnessReceipt = { type: 'receipt', commandId: command.commandId, status: 'accepted' };
    if (prior) {
      if (hash !== prior.hash) throw new Error('原操作 ID 的内容已变化');
      const applied = this.restoredClients.has(command.commandId) || command.operation === 'start' && this.binding?.sessionId === sessionId
        || command.operation === 'configure' && this.binding?.settingsCommand === command.commandId
        || this.binding?.queueCommand === command.commandId || this.binding?.queue?.items.some((item) => item.id === command.commandId);
      receipt = prior.receipt ?? (applied
        ? receipt : { ...receipt, status: 'unknown', error: '操作可能已交给 Codex，等待核实' });
    } else {
      if (Date.parse(delivery.expiresAt) <= Date.now()) receipt = { ...receipt, status: 'expired', error: '指令已过期，未执行' };
      else {
        // A crash after this write may have sent the request. Re-delivery may reconcile, never call it again.
        await writeJson(file, { hash, receipt: null });
        try {
          if (this.stopped) throw new CodexRejected('执行器已停止');
          if (command.operation === 'start') await this.start(sessionId, command.cwd, epoch, threadId);
          else {
            const forkedThreadId = await this.action(command, parkedEpoch);
            if (forkedThreadId) receipt = { ...receipt, forkedThreadId };
          }
        } catch (error) {
          receipt = { ...receipt, status: error instanceof CodexRejected ? 'rejected' : 'unknown', error: failure(error) };
        }
      }
    }
    await writeJson(file, { hash, receipt });
    if (this.stopped) return;
    // A good start receipt follows the thread binding. Order is stable when either ack is lost.
    await this.flush();
    await this.sync(sessionId, receipt);
  }

  private async action(command: Exclude<HarnessDelivery['command'], { operation: 'start' }>, parkedEpoch?: number) {
    const app = this.app, binding = this.binding;
    const resumesIdle = (command.operation === 'send' || command.operation === 'configure' || command.operation === 'enqueue')
      && parkedEpoch === command.expectedEpoch;
    if (!app || !binding || (binding.epoch !== command.expectedEpoch && !resumesIdle)) throw new CodexRejected('会话已重连，请刷新后重试');
    const { threadId } = binding;
    const current = this.view.turn;
    if (requiresHarnessWorkspace(command) && !this.workspace) throw new CodexRejected('本机不支持这个会话操作');
    if (this.harness !== 'codex' && (command.operation === 'steer' || command.operation === 'rerun'
        || command.operation === 'fork' || command.operation === 'compact' || command.operation === 'approvePlan')) {
      throw new CodexRejected('本机不支持这个会话操作');
    }
    if ('expectedSettingsRevision' in command && binding.settings?.revision !== command.expectedSettingsRevision) {
      throw new CodexRejected('会话设置已变更，请刷新后重试');
    }
    if (command.operation === 'configure') {
      const before = this.view.settings;
      if (!this.settingsEnabled || !before) throw new CodexRejected('本机执行器暂不支持会话设置');
      const settings = changeCodexSelection(before, command.changes);
      const view = Object.keys(command.changes).length ? { ...before, ...settings } : await this.settings(app, settings, binding);
      await writeJson(this.bindingPath, { ...binding, settings, settingsCommand: command.commandId });
      binding.settings = settings;
      binding.settingsCommand = command.commandId;
      this.emit({ kind: 'settings', settings: view });
      return;
    }
    if (command.operation === 'enqueue' || 'expectedQueueRevision' in command) {
      await this.editQueue(command);
      return;
    }
    if (command.operation === 'fork') {
      if (command.modelProvider && !this.view.settings?.providers?.includes(command.modelProvider)) {
        throw new CodexRejected('所选供应商未在本机 Codex 中配置');
      }
      return this.forkThread(command.turnId, command.modelProvider);
    }
    if (command.operation === 'rerun') {
      if (!current || current.id !== command.turnId || current.status === 'inProgress' || current.status === 'unknown'
          || binding.queue?.items.length) throw new CodexRejected('只有空闲会话的最后一轮可以重跑');
      const history = await app.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
      const tail = items(history.data)[0];
      const input = items(tail?.items).find((item) => item.type === 'userMessage');
      const parts = items(input?.content);
      if (tail?.id !== current.id || tail.status === 'inProgress' || !parts.length || parts.some((part) =>
        part.type !== 'text' || text(part.text).startsWith(HARNESS_ATTACHMENT_TEXT_PREFIX))) {
        throw new CodexRejected('最后一轮的原始内容已变化或包含不支持的附件');
      }
      const rewritten = command.text ?? parts.map((part) => text(part.text)).join('\n').trim();
      if (!rewritten || rewritten.length > HARNESS_TEXT_LIMIT) throw new CodexRejected('原消息无法作为一条新消息发送');
      // A failed model call after revert can still be recovered from this durable fork.
      await this.forkThread();
      await app.request('thread/revert', { threadId, beforeTurnId: current.id });
      const remaining = await app.request('thread/turns/list', { threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' });
      const { view, clients } = await projectCodexHistory(remaining.data, binding.cwd, this.roots, true);
      this.view = { ...view, queue: this.view.queue, settings: this.view.settings, usage: this.view.usage };
      this.restoredClients = clients;
      await this.upload?.catch(() => undefined);
      await this.setBinding({ ...binding, epoch: binding.epoch + 1 });
      await this.startTurn(rewritten, command.commandId, binding.settings);
      return;
    }
    if (command.operation === 'compact') {
      if (current?.status === 'inProgress' || this.view.queue?.items.length) throw new CodexRejected('请等当前轮和排队消息结束再压缩');
      await app.request('thread/compact/start', { threadId });
      return;
    }
    if (command.operation === 'approvePlan') {
      const settings = binding.settings;
      if (!settings || settings.mode !== 'plan' || current?.id !== command.turnId || current.status !== 'completed'
          || !this.view.plan?.ready || this.view.plan.turnId !== command.turnId || this.view.queue?.items.length) {
        throw new CodexRejected('当前计划已变更，请刷新后重试');
      }
      const selection = { ...settings, mode: 'default' as const, revision: settings.revision + 1 };
      await this.startTurn('请执行这条会话中刚确认的计划。', command.commandId, selection);
      await writeJson(this.bindingPath, { ...binding, settings: selection, settingsCommand: command.commandId });
      binding.settings = selection;
      if (this.view.settings) this.emit({ kind: 'settings', settings: { ...this.view.settings, ...selection } });
      return;
    }
    if (command.operation === 'answerQuestion') {
      const match = this.approvals.get(command.requestId);
      const displayed = this.view.approvals.find((item) => item.id === command.requestId);
      const answers = new Map(command.answers.map((item) => [item.id, item.value]));
      const questions = displayed?.questions ?? [];
      if (!match || displayed?.kind !== 'question' || displayed.turnId !== current?.id || !questions.length
          || answers.size !== questions.length || command.answers.length !== questions.length || questions.some((question) => {
            const value = answers.get(question.id);
            return !value || !question.freeText && !question.options.some((option) => option.label === value);
          })) throw new CodexRejected('问题已处理或答案选项无效');
      this.approvals.delete(command.requestId);
      await this.replyToApproval(app, match.id, command.requestId, {
        answers: Object.fromEntries(command.answers.map(({ id, value }) => [id, { answers: [value] }])),
      });
      return;
    }
    if (command.operation === 'resolveApproval') {
      const match = this.approvals.get(command.requestId);
      const displayed = this.view.approvals.find((approval) => approval.id === command.requestId);
      const offered = displayed?.decisions ?? (displayed?.canAccept ? ['accept', 'decline'] : ['decline']);
      if (!match || !displayed || displayed.kind === 'question' || current?.id !== displayed.turnId || !offered.includes(command.decision)) {
        throw new CodexRejected('这条权限请求已处理或决定无效');
      }
      this.approvals.delete(command.requestId);
      const result = match.method === 'item/permissions/requestApproval'
        ? { permissions: command.decision === 'accept' ? match.permissions : {}, scope: 'turn' }
        : { decision: command.decision };
      await this.replyToApproval(app, match.id, command.requestId, result);
      return;
    }
    if (command.operation === 'send') {
      if (current?.status === 'inProgress') throw new CodexRejected('当前轮仍在运行，请使用追加');
      if (binding.queue?.items[0]?.status === 'queued') throw new CodexRejected('已有排队消息等待执行');
      await this.startTurn(command.text, command.commandId, binding.settings, command.attachments);
      return;
    }
    if (current?.status !== 'inProgress' || current.id !== command.turnId) throw new CodexRejected('该轮已结束，请刷新会话');
    if (command.operation === 'interrupt') await app.request('turn/interrupt', { threadId, turnId: command.turnId });
    else await app.request('turn/steer', {
      threadId, expectedTurnId: command.turnId, input: await codexInput(binding.cwd, command.text, command.attachments), clientUserMessageId: command.commandId,
    });
  }

  private async forkThread(turnId?: string, modelProvider?: string) {
    const threadId = this.binding!.threadId;
    const result = await this.app!.request('thread/fork', {
      threadId, excludeTurns: true, ephemeral: false, ...(turnId ? { lastTurnId: turnId } : {}), ...(modelProvider ? { modelProvider } : {}),
    });
    const id = text(asObject(result.thread).id);
    if (!id || id === threadId || modelProvider && result.modelProvider !== modelProvider) throw new Error('会话分支的结果待核实');
    return id;
  }

  private async startTurn(value: string, commandId: string, settings?: HarnessSettingsSelection, attachments?: HarnessInputAttachment[]) {
    const app = this.app, binding = this.binding;
    if (!app || !binding) throw new CodexRejected('本机会话已断开');
    const nameFirstTurn = this.library && this.harness === 'codex' && !binding.native && !this.view.turn;
    const overrides = settings && (this.settingsEnabled || settings.revision > 0)
      ? codexTurnSettings(settings, binding.cwd, this.workspaceSandbox, this.view.settings?.planAvailable === true) : {};
    const response = await app.request('turn/start', {
      threadId: binding.threadId, input: await codexInput(binding.cwd, value, attachments), clientUserMessageId: commandId, ...overrides,
    });
    const started = turn(asObject(response.turn));
    if (!started) throw new Error('本机开始新一轮的结果待核实');
    if (this.view.turn?.id !== started.id) this.emit({ kind: 'turn', turn: started });
    if (nameFirstTurn) {
      const name = Array.from(value.replace(/\s+/g, ' ')).slice(0, 48).join('');
      void app.request('thread/name/set', { threadId: binding.threadId, name }).catch(() => undefined);
    }
  }

  private async saveQueue(queue: SavedQueue, commandId?: string) {
    const binding = this.binding!;
    await writeJson(this.bindingPath, { ...binding, queue, queueCommand: commandId ?? binding.queueCommand });
    binding.queue = queue;
    if (commandId) binding.queueCommand = commandId;
    this.emit({ kind: 'queue', queue: queueView(queue) });
  }

  private async editQueue(command: Extract<HarnessCommand, { operation: 'enqueue' } | { expectedQueueRevision: number }>) {
    const binding = this.binding!;
    const previous = binding.queue ?? { revision: 0, items: [] };
    const items = [...previous.items];
    const next = { revision: previous.revision + 1, items };
    if (command.operation === 'enqueue') {
      if (items.length >= 12) throw new CodexRejected('此会话的排队消息已满');
      items.push({ id: command.commandId, text: command.text, settings: binding.settings, status: 'queued',
        attachments: command.attachments, attachmentNames: command.attachments?.map((file) => file.name) });
    } else {
      const index = items.findIndex((item) => item.id === command.itemId);
      const item = items[index];
      if (previous.revision !== command.expectedQueueRevision || !item || item.status === 'starting'
          || item.status === 'blocked' && command.operation !== 'removeQueued') {
        throw new CodexRejected('消息队列已变化，请刷新后重试');
      }
      if (command.operation === 'editQueued') items[index] = { ...item, text: command.text };
      else if (command.operation === 'removeQueued') items.splice(index, 1);
      else {
        const to = command.operation === 'sendQueuedNow' ? 0 : index + (command.direction === 'up' ? -1 : 1);
        if (to < 0 || to >= items.length) throw new CodexRejected('消息已在队列边缘');
        items.splice(index, 1);
        items.splice(to, 0, item);
      }
    }
    const previousCommand = binding.queueCommand;
    await this.saveQueue(next, command.commandId);
    if (command.operation === 'sendQueuedNow' && this.view.turn?.status === 'inProgress') {
      try { await this.app!.request('turn/interrupt', { threadId: binding.threadId, turnId: this.view.turn.id }); }
      catch (error) {
        binding.queueCommand = previousCommand;
        await this.saveQueue({ revision: next.revision + 1, items: previous.items });
        throw error;
      }
    }
  }

  private drainQueue() {
    const queue = this.binding?.queue;
    const item = queue?.items[0];
    if (this.stopped || this.work || !this.workspace || !this.app || !queue || item?.status !== 'queued'
        || this.view.turn?.status === 'inProgress' || this.view.turn?.status === 'unknown') return;
    this.work = this.promoteQueue(queue, item).catch(async (error: unknown) => {
      const current = this.binding?.queue;
      if (current?.items[0]?.id !== item.id) return;
      await this.saveQueue({ revision: current.revision + 1, items: [
        { ...item, status: 'blocked', error: failure(error) }, ...current.items.slice(1),
      ] });
    }).catch(() => undefined).finally(() => {
      this.work = null;
      this.lastWork = Date.now();
      if (this.binding?.queue?.items[0]?.id !== item.id) this.drainQueue();
    });
  }

  private async promoteQueue(queue: SavedQueue, item: SavedQueueItem) {
    const rest = queue.items.slice(1);
    await this.saveQueue({ revision: queue.revision + 1, items: [{ ...item, status: 'starting' }, ...rest] });
    if (this.view.turn?.status === 'inProgress') {
      await this.saveQueue({ revision: queue.revision + 2, items: queue.items });
      return;
    }
    await this.startTurn(item.text, item.id, item.settings, item.attachments);
    await this.saveQueue({ revision: queue.revision + 2, items: rest });
  }

  private replyToApproval(app: HarnessRuntime, id: RpcId, requestId: string, result: Record<string, unknown>) {
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        this.approvalAcks.delete(id);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Codex 的权限回复结果待核实')), 8_000);
      this.approvalAcks.set(id, { requestId, finish });
      void app.reply(id, result).catch(finish);
    });
  }

  private receive(method: string, params: Record<string, unknown>, id?: RpcId) {
    if (!this.app || this.stopped) return;
    if (params.threadId !== this.binding?.threadId) {
      if (id !== undefined && this.app.pid) void this.app.unsupported(id).catch(() => undefined);
      return;
    }
    if (id !== undefined) {
      this.receiveRequest(method, params, id);
      return;
    }
    const turnId = text(params.turnId);
    if (method === 'turn/started' || method === 'turn/completed') {
      const change = turn(asObject(params.turn));
      if (!change) return;
      if (method === 'turn/completed' && this.view.turn?.id !== change.id) return;
      if (method === 'turn/completed') this.approvals.clear();
      this.emit({ kind: 'turn', turn: change });
      if (change.status === 'completed') this.captureArtifacts(change.id);
      if (method === 'turn/completed') this.drainQueue();
    } else if (method === 'item/agentMessage/delta' && text(params.itemId) && turnId) {
      this.emit({ kind: 'delta', id: text(params.itemId), turnId, delta: text(params.delta).slice(0, HARNESS_TEXT_LIMIT) });
    } else if ((method === 'item/started' || method === 'item/completed') && turnId) {
      const item = asObject(params.item);
      const completed = method === 'item/completed';
      const value = message(completed ? item : { ...item, text: '' }, turnId, !completed);
      if (value && (value.role === 'user' || completed || this.timeline)) this.emit({ kind: 'message', message: value });
      if (this.workspace && completed && item.type === 'plan') this.updatePlan(turnId, text(item.text).slice(0, HARNESS_TEXT_LIMIT), true);
      const tool = codexHarnessTool(item, turnId, completed);
      if (tool) this.emit({ kind: 'tool', tool });
      if (item.type === 'fileChange') {
        if (method === 'item/completed') this.fileChanges.delete(text(item.id));
        else this.fileChanges.set(text(item.id), items(item.changes).map((change) => text(change.path)).join('\n').slice(0, 7_000));
      }
    } else if ((method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') && turnId && text(params.itemId)) {
      const { output, truncated } = harnessOutput(params.delta);
      if (output) this.emit({ kind: 'toolOutput', id: text(params.itemId), turnId, delta: output, ...(truncated ? { truncated } : {}) });
    } else if (method === 'item/fileChange/patchUpdated' && turnId) {
      const tool = this.view.tools?.find((item) => item.id === params.itemId && item.turnId === turnId && item.kind === 'fileChange' && item.status === 'running');
      if (tool) this.emit({ kind: 'tool', tool: { ...tool, files: harnessFilePaths(params.changes), diffs: harnessFileDiffs(params.changes) } });
    } else if (this.workspace && method === 'item/plan/delta' && turnId) {
      const previous = this.view.plan?.turnId === turnId ? this.view.plan.text : '';
      this.updatePlan(turnId, (previous + text(params.delta)).slice(0, HARNESS_TEXT_LIMIT), false);
    } else if (this.workspace && method === 'turn/plan/updated' && turnId) {
      const steps = items(params.plan).slice(0, 30).flatMap<NonNullable<HarnessView['plan']>['steps'][number]>((step) => {
        const label = text(step.step).slice(0, 1_000);
        const status = step.status;
        return label && (status === 'pending' || status === 'inProgress' || status === 'completed') ? [{ text: label, status }] : [];
      });
      const current = this.view.plan?.turnId === turnId ? this.view.plan : null;
      this.emit({ kind: 'plan', plan: { turnId, text: current?.text ?? text(params.explanation).slice(0, HARNESS_TEXT_LIMIT), ready: current?.ready ?? false, steps } });
    } else if (this.workspace && method === 'thread/tokenUsage/updated') {
      const usage = asObject(params.tokenUsage);
      const used = asObject(usage.last).totalTokens, total = asObject(usage.total).totalTokens, limit = usage.modelContextWindow;
      if (typeof used === 'number' && Number.isSafeInteger(used) && used >= 0 && typeof total === 'number' && Number.isSafeInteger(total) && total >= 0) {
        this.emit({ kind: 'usage', usage: { used, total, limit: typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : null } });
      }
    } else if (method === 'serverRequest/resolved' && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
      const ack = this.approvalAcks.get(params.requestId);
      const requestId = ack?.requestId ?? [...this.approvals].find(([, request]) => request.id === params.requestId)?.[0];
      ack?.finish();
      if (requestId) {
        this.approvals.delete(requestId);
        this.emit({ kind: 'approvalResolved', id: requestId });
      }
    }
  }

  private updatePlan(turnId: string, value: string, ready: boolean) {
    const steps = this.view.plan?.turnId === turnId ? this.view.plan.steps : [];
    this.emit({ kind: 'plan', plan: { turnId, text: value, ready, steps } });
  }

  private captureArtifacts(turnId: string) {
    const binding = this.binding;
    const answer = this.view.messages.filter((item) => item.turnId === turnId && item.role === 'assistant' && item.phase !== 'commentary').at(-1);
    if (!binding || !answer?.text) return;
    void readHarnessArtifacts(answer, binding.cwd, this.roots).then((artifacts) => {
      if (this.binding !== binding || !this.app || this.stopped) return;
      for (const artifact of artifacts) this.emit({ kind: 'artifact', artifact });
    }).catch(() => undefined);
  }

  private receiveRequest(method: string, params: Record<string, unknown>, id: RpcId) {
    const kind = method === 'item/commandExecution/requestApproval' ? 'command'
      : method === 'item/fileChange/requestApproval' ? 'fileChange'
      : method === 'item/permissions/requestApproval' ? 'permissions'
      : this.workspace && method === 'item/tool/requestUserInput' ? 'question' : null;
    const turnId = text(params.turnId);
    const requestId = digest(JSON.stringify([turnId, id]));
    if (!kind || !turnId || requestId.length > 200 || this.approvals.size >= 32) {
      if (this.app?.pid) void this.app.unsupported(id).catch(() => undefined);
      return;
    }
    let questions: HarnessApproval['questions'];
    if (kind === 'question') {
      const requested = items(params.questions);
      if (!requested.length || requested.length > 8 || requested.some((item) => item.isSecret === true
          || !text(item.id) || text(item.id).length > 200 || !text(item.question))) {
        if (this.app?.pid) void this.app.unsupported(id).catch(() => undefined);
        return;
      }
      questions = requested.map((item) => ({ id: text(item.id), label: text(item.question).slice(0, 2_000),
        freeText: item.isOther === true || item.options == null,
        options: items(item.options).slice(0, 12).flatMap((option) => typeof option.label === 'string' && option.label && option.label.length <= 512
          ? [{ label: option.label, description: text(option.description).slice(0, 1_000) }] : []),
      }));
    }
    const permissions = asObject(params.permissions);
    const context = asObject(params.networkApprovalContext);
    const details = [text(params.reason), text(params.command), text(params.cwd), text(params.grantRoot),
      this.fileChanges.get(text(params.itemId)) ?? '',
      Object.keys(context).length ? JSON.stringify(context) : '',
      kind === 'permissions' ? JSON.stringify(permissions) : '',
    ].filter(Boolean).join('\n').slice(0, 8_000);
    this.approvals.set(requestId, { id, method, permissions });
    const advertised = params.availableDecisions;
    const decisions = (['decline', 'cancel', 'accept', 'acceptForSession'] as const)
      .filter((decision) => Array.isArray(advertised) ? advertised.includes(decision)
        : decision === 'accept' || decision === 'decline' || decision === 'cancel' && (kind === 'command' || kind === 'fileChange'));
    const canAccept = !Array.isArray(advertised) || advertised.includes('accept');
    // Permission grants use a different response shape, with turn-only scope here.
    const available = this.workspace && (kind === 'command' || kind === 'fileChange') ? decisions : undefined;
    this.emit({ kind: 'approval', approval: { id: requestId, turnId, kind, details, canAccept,
      ...(questions ? { questions } : {}), ...(available ? { decisions: available } : {}),
    } });
  }

  private emit(event: HarnessEvent) {
    this.view = applyHarnessEvent(this.view, event);
    const wire = harnessEventForClient(event, this.timeline, this.settingsEnabled, this.workspace);
    if (!wire) return;
    this.events.push({ seq: ++this.seq, event: wire });
    if (this.events.length > HARNESS_EVENTS) {
      this.events = this.events.slice(-HARNESS_EVENTS);
      this.snapshotNeeded = true;
    }
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, 80);
  }

  private flush() {
    if (this.upload) return this.upload;
    const binding = this.binding;
    if (!binding || !this.app || this.stopped || (!this.snapshotNeeded && !this.events.length)) return Promise.resolve();
    this.upload = this.sendEvents(binding).finally(() => { this.upload = null; });
    return this.upload;
  }

  private async sendEvents(binding: Binding) {
    while (this.binding === binding && this.app && !this.stopped) {
      const batch = this.events.slice(0, 32);
      if (!this.snapshotNeeded && !batch.length) return;
      const snapshot: HarnessSnapshot = { type: 'snapshot', threadId: binding.threadId, epoch: binding.epoch, seq: this.seq, view: this.view };
      const sendingSnapshot = this.snapshotNeeded;
      const sequence = sendingSnapshot ? snapshot.seq : batch.at(-1)!.seq;
      const result = await this.sync(binding.sessionId, sendingSnapshot ? harnessSnapshotForClient(snapshot, this.timeline, this.settingsEnabled, this.workspace)
        : { type: 'events', epoch: binding.epoch, events: batch });
      if (this.binding !== binding) return;
      if (result.snapshotRequested) {
        this.snapshotNeeded = true;
        if (sendingSnapshot) return;
        continue;
      }
      this.events = this.events.filter((event) => event.seq > sequence);
      this.snapshotNeeded = this.events.length > 0 && this.events[0].seq !== sequence + 1;
    }
  }

  private async dropApp() {
    const app = this.app;
    this.app = null;
    if (app) this.appClose = app.close().finally(() => { this.appClose = null; });
    await this.appClose;
  }

  parkIfIdle() {
    if (this.stopped || this.work || this.upload || this.events.length || this.approvalAcks.size
        || this.workspace && this.binding?.queue?.items[0]?.status === 'queued'
        || this.view.turn?.status === 'inProgress' || this.view.approvals.length || Date.now() - this.lastWork < 120_000) return;
    return this.close(Boolean(this.app && this.binding && !this.snapshotNeeded));
  }

  async close(parked = false) {
    this.stopped = true;
    for (const ack of this.approvalAcks.values()) ack.finish(new Error('Codex 的权限回复结果待核实'));
    if (this.timer) clearTimeout(this.timer);
    await this.opening?.catch(() => undefined);
    await this.dropApp();
    const release = this.release;
    this.release = undefined;
    try {
      if (parked && this.binding) await writeJson(this.bindingPath, { ...this.binding, pid: undefined, parked: true });
    } finally { await release?.(); }
  }
}
