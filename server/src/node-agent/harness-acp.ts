import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CodexRejected } from './harness-codex.js';

type Frame = Record<string, unknown>;
type Pending = { resolve: (value: Frame) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout };
export type AcpMessage = (method: string, params: Frame, id?: number | string) => void;
const asRecord = (value: unknown): Frame => value && typeof value === 'object' && !Array.isArray(value) ? value as Frame : {};

export class AcpError extends Error {
  constructor(readonly code: number, message: string, readonly data: unknown) { super(message); }
}

type Options = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onMessage: AcpMessage;
  label: 'DSH' | 'Kimi Code';
};

/** Newline-delimited JSON-RPC shared by ACP harnesses. A prompt may disable the request timer. */
export class AcpConnection {
  private cursor = 0;
  private readonly pending = new Map<number, Pending>();
  private closing = false;
  readonly exited: Promise<void>;

  constructor(readonly child: ChildProcessWithoutNullStreams, onMessage: AcpMessage,
    private readonly label: 'DSH' | 'Kimi Code') {
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let spawned = false;
    child.once('spawn', () => { spawned = true; });
    this.exited = new Promise<void>((done) => {
      const exit = () => {
        lines.close();
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(this.disconnectedError());
        }
        this.pending.clear();
        done();
      };
      child.once('close', exit);
      child.once('error', () => {
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(spawned ? this.disconnectedError() : this.startError());
        }
        this.pending.clear();
        if (!spawned) exit();
      });
    });
    child.stdin.on('error', () => undefined);
    lines.on('line', (line) => {
      let message: Frame;
      try { message = asRecord(JSON.parse(line)); } catch { return; }
      if (typeof message.method === 'string') {
        onMessage(message.method, asRecord(message.params), typeof message.id === 'number' || typeof message.id === 'string' ? message.id : undefined);
        return;
      }
      if (typeof message.id !== 'number') return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      const error = asRecord(message.error);
      if (Object.keys(error).length) {
        entry.reject(new AcpError(typeof error.code === 'number' ? error.code : 0,
          typeof error.message === 'string' ? error.message : `${this.label} 拒绝了操作`, error.data));
      } else entry.resolve(asRecord(message.result));
    });
  }

  static open({ command, args, cwd, env, onMessage, label }: Options) {
    return new AcpConnection(spawn(command, args, { cwd, env, windowsHide: true, stdio: 'pipe' }), onMessage, label);
  }

  private disconnectedError() {
    return this.label === 'DSH' ? new Error('DSH 连接已断开，操作结果待核实') : new Error('Kimi Code 连接已断开，操作结果待核实');
  }

  private startError() {
    return this.label === 'DSH' ? new CodexRejected('本机无法启动 DSH，请确认已安装 DeepSeek Harness')
      : new CodexRejected('本机无法启动 Kimi Code，请确认已安装 CLI');
  }

  private timeoutError() {
    return this.label === 'DSH' ? new Error('DSH 响应超时，操作结果待核实') : new Error('Kimi Code 响应超时，操作结果待核实');
  }

  get pid() { return this.child.pid; }

  request<T extends Frame = Frame>(method: string, params: Frame, timeoutMs = 15_000) {
    const id = ++this.cursor;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: (value) => resolve(value as T), reject };
      if (timeoutMs) entry.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.timeoutError());
      }, timeoutMs);
      this.pending.set(id, entry);
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
        if (error) { clearTimeout(entry.timer); this.pending.delete(id); reject(this.disconnectedError()); }
      });
    });
  }

  notify(method: string, params: Frame) {
    if (!this.closing) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  respond(id: number | string, result: Frame) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  respondError(id: number | string, code: number, message: string) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  }

  async close() {
    if (this.closing) return this.exited;
    this.closing = true;
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill('SIGTERM'), 500);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
    try { await this.exited; } finally { clearTimeout(terminate); clearTimeout(kill); }
  }
}
