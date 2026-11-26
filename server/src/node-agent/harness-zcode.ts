import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { asObject, CodexRejected, type HarnessNotification } from './harness-codex.js';
import { codexItems as items, codexText as text, projectCodexHistory } from './harness-history.js';
import { resolveZCode, withZCode, zcodeSessionStore } from './harness-zcode-client.js';
import { readZCodeRows, readZCodeThread, zcodeTurns } from './harness-zcode-library.js';
import { ZCodeLiveConversation, type ZCodeSessionTarget } from './harness-zcode-live.js';
import { zcodeHarnessTool } from './harness-zcode-tools.js';
import { HARNESS_OUTPUT_LIMIT, HARNESS_TEXT_LIMIT, HARNESS_TOOLS, type HarnessSettingsChange, type HarnessView } from './harness-protocol.js';

// Invoke ZCode's own authenticated headless entry. Send the prompt over the pipe so it stays out of the OS command line.
const readPrompt = `
  const chunks = [];
  (async () => {
    for await (const chunk of process.stdin) chunks.push(chunk);
    const prompt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    process.argv = [process.execPath, ...process.argv.slice(1), '--prompt=' + prompt];
    require('node:module').runMain();
  })().catch(() => { process.exitCode = 1; });
`;

async function readNativeSessionState(installation: Awaited<ReturnType<typeof resolveZCode>>, cwd: string, id: string,
  currentPid?: number, allowEmptyDraft = false) {
  const path = zcodeSessionStore(installation, cwd);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000');
    const session = db.prepare('SELECT permission, time_deleted FROM session WHERE id = ?').get(id);
    if (session?.time_deleted != null || !session && !allowEmptyDraft) throw new CodexRejected('找不到本机 ZCode 原会话');
    const owners = db.prepare('SELECT process_id FROM session_runtime_presence WHERE session_id = ?').all(id);
    const busy = owners.some(({ process_id: pid }) => {
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid === currentPid) return false;
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    });
    if (busy) throw new CodexRejected('这条对话正在 ZCode 中使用，请关闭本机对应的对话后再继续');
    const permission = typeof session?.permission === 'string' ? asObject(JSON.parse(session.permission)) : {};
    // Build keeps the project's permission checks and Plan retains an existing plan mode.
    return { mode: permission.mode === 'plan' ? 'plan' : 'build', stored: Boolean(session) };
  } catch (error) {
    if (error instanceof CodexRejected) throw error;
    throw new CodexRejected('无法核对本机 ZCode 会话状态');
  } finally { db?.close(); }
}

type Running = {
  child: ChildProcessWithoutNullStreams;
  done: Promise<void>;
  turnId: string;
  interrupted: boolean;
  sawResult: boolean;
  failed: boolean;
  receivedText: boolean;
  tools: Map<string, { toolName: string; input: { command?: string } }>;
};

export class ZCodeHarnessRuntime {
  readonly pid = undefined;
  private running: Running | null = null;
  private live: ZCodeLiveConversation | null = null;
  private liveUpdate = 0;
  constructor(private readonly cwd: string, private readonly emit: HarnessNotification,
    private readonly replaceHistory: (turnId: string, view: HarnessView) => Promise<boolean>,
    private readonly replaceLive: (threadId: string, view: HarnessView, clients: Set<string>) => Promise<void>,
    private readonly disconnected: () => void, private readonly liveEnabled: boolean, private readonly nativePermissions = () => false) {}

  get attached() { return this.live?.connected === true; }

  liveView() { return this.live?.connected ? this.live.view() : undefined; }

  private async connect(target: ZCodeSessionTarget) {
    const installation = await resolveZCode();
    if (typeof target === 'string') await readNativeSessionState(installation, this.cwd, target);
    this.live = await ZCodeLiveConversation.open(this.cwd, target, () => {
      const current = this.live;
      const update = ++this.liveUpdate;
      if (current?.connected) void current.view().then(({ view, clients }) => {
        if (this.live === current && update === this.liveUpdate) return this.replaceLive(current.threadId, view, clients);
      }).catch(() => undefined);
    }, () => {
      if (!this.live) return;
      this.live = null;
      this.disconnected();
    }, this.nativePermissions, async (pid, threadId) => {
      await readNativeSessionState(installation, this.cwd, threadId, pid, typeof target !== 'string');
    });
    return this.live.threadId;
  }

  private async resume(threadId: string, draftCommandId?: string, settings?: Record<string, unknown>) {
    if (!this.live && this.liveEnabled) {
      let target: ZCodeSessionTarget = threadId;
      if (draftCommandId) {
        const state = await readNativeSessionState(await resolveZCode(), this.cwd, threadId, undefined, true);
        if (!state.stored) {
          const modelId = text(settings?.model).split('/');
          const config = settings ? {
            ...(modelId.length === 2 ? { provider: decodeURIComponent(modelId[0]), model: decodeURIComponent(modelId[1]) } : {}),
            ...(typeof settings.permissionMode === 'string' ? { mode: settings.permissionMode } : {}),
            planEnabled: settings.mode === 'plan',
          } : undefined;
          target = { createCommandId: draftCommandId, threadId, config };
        }
      }
      await this.connect(target);
    } else if (!this.live) await withZCode(this.cwd, (app) => readZCodeThread(app, threadId, this.cwd));
    return { thread: { id: threadId, cwd: this.cwd, status: { type: this.attached ? 'idle' : 'notLoaded' } } };
  }

  private async create(commandId: string) {
    if (!this.liveEnabled || !commandId || this.live) throw new CodexRejected('本机 ZCode 无法新建会话');
    const id = await this.connect({ createCommandId: commandId });
    return { thread: { id, cwd: this.cwd, status: { type: 'idle' } } };
  }

  async selectModel(model: string | undefined, commandId: string, expectedSettingsRevision: number, effort?: string | null) {
    if (!this.live?.connected) throw new CodexRejected('本机 ZCode 会话未连接，请重新打开会话');
    return this.live.selectModel(model, commandId, expectedSettingsRevision, effort);
  }

  async selectPermission(changes: HarnessSettingsChange, commandId: string, expectedSettingsRevision: number) {
    if (!this.live?.connected) throw new CodexRejected('本机 ZCode 会话未连接，请重新打开会话');
    return this.live.selectPermission(changes, commandId, expectedSettingsRevision);
  }

  async choosePermission(requestId: string, optionId: string, commandId: string) {
    if (!this.live?.connected) throw new CodexRejected('本机 ZCode 会话未连接，请重新打开会话');
    await this.live.choosePermission(requestId, optionId, commandId);
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const threadId = text(params.threadId);
    switch (method) {
      case 'thread/start':
        return this.create(text(params.commandId));
      case 'thread/read':
        return this.resume(threadId);
      case 'thread/resume':
        return this.resume(threadId, text(params.draftCommandId) || undefined, params.draftSettings ? asObject(params.draftSettings) : undefined);
      case 'thread/turns/list':
        if (this.live?.connected) return Promise.resolve({ data: this.live.turns() });
        return withZCode(this.cwd, async (app) => {
          await readZCodeThread(app, threadId, this.cwd);
          const result = await readZCodeRows(app, threadId, this.cwd, null, 36);
          return { data: zcodeTurns(result.rows) };
        });
      case 'turn/start':
        if (this.live?.connected) return this.live.send(text(items(params.input)[0]?.text), text(params.clientUserMessageId))
          .then(() => ({ nativeDelivery: true }));
        return this.start(threadId, text(items(params.input)[0]?.text));
      case 'turn/interrupt':
        if (this.live?.connected) return this.live.stop(text(params.commandId), text(params.turnId)).then(() => ({}));
        return this.interrupt(text(params.turnId));
      default:
        return Promise.reject(new CodexRejected('本机不支持这个会话操作'));
    }
  }

  private async start(threadId: string, prompt: string) {
    if (!threadId || !prompt.trim() || this.running) throw new CodexRejected('本机不支持这个会话操作');
    const installation = await resolveZCode();
    const { mode } = await readNativeSessionState(installation, this.cwd, threadId);
    const { node, script, env } = installation;
    const child = spawn(node, ['-e', readPrompt, script, '--resume', threadId, '--output-format', 'stream-json',
      '--mode', mode, '--no-color'], { cwd: this.cwd, env, windowsHide: true, stdio: 'pipe' });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stderr.resume();
    let accepted: (value: { turn: { id: string; status: string } }) => void;
    let unknown: (error: Error) => void;
    const receipt = new Promise<{ turn: { id: string; status: string } }>((resolve, reject) => {
      accepted = resolve;
      unknown = reject;
    });
    const deadline = setTimeout(() => unknown(new Error('ZCode 开始新一轮的结果待核实')), 15_000);
    const current: Running = {
      child, turnId: '', interrupted: false, sawResult: false, failed: false, receivedText: false, tools: new Map(),
      done: new Promise((resolve) => child.once('close', (code) => {
        clearTimeout(deadline);
        lines.close();
        if (!current.turnId) unknown(new Error('ZCode 开始新一轮的结果待核实'));
        void this.finish(threadId, current, code).catch(() => undefined).finally(() => {
          if (this.running === current) this.running = null;
          resolve();
        });
      })),
    };
    this.running = current;
    lines.on('line', (line) => {
      let event: Record<string, unknown>;
      try { event = asObject(JSON.parse(line)); } catch { return; }
      if (event.sessionId !== threadId) return;
      this.receive(current, event, threadId, prompt, (id) => {
        clearTimeout(deadline);
        accepted({ turn: { id, status: 'inProgress' } });
      });
    });
    child.on('error', () => unknown(new Error('ZCode 开始新一轮的结果待核实')));
    child.stdin.on('error', () => unknown(new Error('ZCode 开始新一轮的结果待核实')));
    child.stdin.end(JSON.stringify(prompt));
    return receipt;
  }

  private async finish(threadId: string, run: Running, exitCode: number | null) {
    if (!run.turnId) return;
    const status = run.interrupted ? 'interrupted' : exitCode === 0 && run.sawResult && !run.failed ? 'completed' : 'failed';
    if (status === 'completed') {
      try {
        // CLI stream IDs and the conversation projection's persisted IDs belong to different timelines.
        const result = await withZCode(this.cwd, (app) => readZCodeRows(app, threadId, this.cwd, null, 36));
        const { view } = await projectCodexHistory(zcodeTurns(result.rows), this.cwd, [this.cwd], true, false, zcodeHarnessTool, 'zcode');
        if (view.turn?.status === 'completed' && await this.replaceHistory(run.turnId, view)) return;
      } catch { /* Keep the streamed response available when the history read fails. */ }
    }
    this.emit('turn/completed', { threadId, turn: { id: run.turnId, status } });
  }

  private receive(run: Running, event: Record<string, unknown>, threadId: string, prompt: string, accepted: (turnId: string) => void) {
    const turnId = text(event.turnId);
    if (!turnId) return;
    if (!run.turnId && (event.type === 'turn.started' || event.type === 'result')) {
      run.turnId = turnId;
      this.emit('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
      this.emit('item/completed', { threadId, turnId, item: { id: turnId + ':input', type: 'userMessage', content: [{ type: 'text', text: prompt }] } });
      accepted(turnId);
    }
    if (run.turnId !== turnId) return;
    const payload = asObject(event.payload);
    const itemId = turnId + ':answer';
    if (event.type === 'model.streaming' && payload.kind === 'text_delta' && typeof payload.delta === 'string') {
      run.receivedText = true;
      this.emit('item/agentMessage/delta', { threadId, turnId, itemId, delta: payload.delta });
    }
    if (event.type === 'turn.failed') run.failed = true;
    if (event.type === 'tool.updated') this.receiveTool(run, threadId, payload);
    if (event.type === 'result') {
      run.sawResult = true;
      const response = text(event.response).slice(0, HARNESS_TEXT_LIMIT);
      if (response || run.receivedText) this.emit('item/completed', { threadId, turnId, item: { id: itemId, type: 'agentMessage', text: response } });
    }
  }

  private receiveTool(run: Running, threadId: string, payload: Record<string, unknown>) {
    const callId = text(payload.toolCallId);
    const id = `${run.turnId}:tool:${callId}`;
    if (!callId || id.length > 200) return;
    const previous = run.tools.get(callId);
    const toolName = text(payload.toolName).slice(0, 1_000) || previous?.toolName;
    if (!toolName) return;
    const input = previous?.input ?? (toolName.toLowerCase() === 'bash'
      ? { command: text(asObject(payload.input).command).slice(0, 1_000) } : {});
    const item = { kind: 'toolCall', id, toolName, input };
    const params = { threadId, turnId: run.turnId };
    switch (payload.kind) {
      case 'scheduled':
      case 'started':
        run.tools.set(callId, { toolName, input });
        if (run.tools.size > HARNESS_TOOLS) run.tools.delete(run.tools.keys().next().value!);
        this.emit('item/started', { ...params, item: { ...item, status: 'running' } });
        return;
      case 'progress': {
        if (!previous) return;
        const tail = [text(payload.stdoutTail), text(payload.stderrTail)].filter(Boolean).join('\n').slice(-HARNESS_OUTPUT_LIMIT);
        this.emit('item/started', { ...params, item: { ...item, status: 'running', outputPreview: payload.outputPreview,
          progress: { previewLine: tail, message: payload.message } } });
        return;
      }
      case 'result': {
        run.tools.delete(callId);
        const result = asObject(payload.result);
        this.emit('item/completed', { ...params, item: { ...item, status: result.success === false ? 'error' : 'success',
          output: { text: result.content, display: result.display, truncated: result.truncated }, error: result.error } });
        return;
      }
      case 'error':
        run.tools.delete(callId);
        this.emit('item/completed', { ...params, item: { ...item, status: 'error', error: payload.error } });
    }
  }

  private async interrupt(turnId: string) {
    const run = this.running;
    if (!run || run.turnId !== turnId || run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new CodexRejected('当前轮次已结束');
    }
    run.interrupted = true;
    run.child.kill('SIGINT');
    return {};
  }

  async close() {
    const live = this.live;
    this.live = null;
    await live?.close();
    const run = this.running;
    if (!run) return;
    run.interrupted = true;
    run.child.kill('SIGTERM');
    const timer = setTimeout(() => run.child.kill('SIGKILL'), 2_000);
    try { await run.done; } finally { clearTimeout(timer); }
  }

  async reply() {}
  async unsupported() {}
}
