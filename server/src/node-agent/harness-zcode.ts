import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { asObject, CodexRejected, type HarnessNotification } from './harness-codex.js';
import { codexItems as items, codexText as text, projectCodexHistory } from './harness-history.js';
import { resolveZCode, withZCode } from './harness-zcode-client.js';
import { readZCodeRows, readZCodeThread, zcodeTurns } from './harness-zcode-library.js';
import { HARNESS_TEXT_LIMIT, type HarnessView } from './harness-protocol.js';

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

async function readLaunchMode(installation: Awaited<ReturnType<typeof resolveZCode>>, cwd: string, id: string) {
  const { home, env } = installation;
  const storage = env.ZCODE_STORAGE_DIR || resolve(home, '.zcode');
  const expand = (value: string) => value.startsWith('~/') ? resolve(home, value.slice(2)) : resolve(cwd, value);
  const path = expand(env.ZCODE_SESSION_DB_PATH || env.ZCODE_SESSION_DB || resolve(expand(storage), 'cli/db/db.sqlite'));
  await access(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=1000');
    const session = db.prepare('SELECT permission FROM session WHERE id = ? AND time_deleted IS NULL').get(id);
    if (!session) throw new CodexRejected('找不到本机 ZCode 原会话');
    const owners = db.prepare('SELECT process_id FROM session_runtime_presence WHERE session_id = ?').all(id);
    const busy = owners.some(({ process_id: pid }) => {
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    });
    if (busy) throw new CodexRejected('这条对话正在 ZCode 中使用，请关闭本机对应的对话后再继续');
    const permission = typeof session.permission === 'string' ? asObject(JSON.parse(session.permission)) : {};
    // Build keeps the project's permission checks and Plan retains an existing plan mode.
    return permission.mode === 'plan' ? 'plan' : 'build';
  } finally { db.close(); }
}

type Running = {
  child: ChildProcessWithoutNullStreams;
  done: Promise<void>;
  turnId: string;
  interrupted: boolean;
  sawResult: boolean;
  failed: boolean;
  receivedText: boolean;
};

export class ZCodeHarnessRuntime {
  readonly pid = undefined;
  private running: Running | null = null;
  constructor(private readonly cwd: string, private readonly emit: HarnessNotification,
    private readonly replaceHistory: (turnId: string, view: HarnessView) => Promise<boolean>) {}

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const threadId = text(params.threadId);
    switch (method) {
      case 'thread/read':
      case 'thread/resume':
        return withZCode(this.cwd, async (app) => {
          await readZCodeThread(app, threadId, this.cwd);
          return { thread: { id: threadId, cwd: this.cwd, status: { type: 'notLoaded' } } };
        });
      case 'thread/turns/list':
        return withZCode(this.cwd, async (app) => {
          await readZCodeThread(app, threadId, this.cwd);
          const result = await readZCodeRows(app, threadId, this.cwd, null, 36);
          return { data: zcodeTurns(result.rows) };
        });
      case 'turn/start':
        return this.start(threadId, text(items(params.input)[0]?.text));
      case 'turn/interrupt':
        return this.interrupt(text(params.turnId));
      default:
        return Promise.reject(new CodexRejected('本机不支持这个会话操作'));
    }
  }

  private async start(threadId: string, prompt: string) {
    if (!threadId || !prompt.trim() || this.running) throw new CodexRejected('本机不支持这个会话操作');
    const installation = await resolveZCode();
    const mode = await readLaunchMode(installation, this.cwd, threadId).catch((error) => {
      if (error instanceof CodexRejected) throw error;
      throw new CodexRejected('无法核对本机 ZCode 会话状态');
    });
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
      child, turnId: '', interrupted: false, sawResult: false, failed: false, receivedText: false,
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
        const { view } = await projectCodexHistory(zcodeTurns(result.rows), this.cwd, [this.cwd], true);
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
    if (event.type === 'result') {
      run.sawResult = true;
      const response = text(event.response).slice(0, HARNESS_TEXT_LIMIT);
      if (response || run.receivedText) this.emit('item/completed', { threadId, turnId, item: { id: itemId, type: 'agentMessage', text: response } });
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
