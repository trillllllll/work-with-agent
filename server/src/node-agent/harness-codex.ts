import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { providerEnvironment } from '../runner/environment.js';
import { resolveLocalCli } from './cli.js';

type RpcId = string | number;
type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

export class CodexRejected extends Error {}

export class CodexAppServer {
  private cursor = 0;
  private active = true;
  private closing = false;
  private readonly pending = new Map<number, {
    resolve: (value: JsonObject) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly exited: Promise<void>;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    onMessage: (method: string, params: JsonObject, id?: RpcId) => void,
    onExit: () => void,
  ) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    // App Server diagnostics can include local account and configuration details.
    child.stderr.resume();
    child.stdin.on('error', () => this.fail());
    child.once('error', () => this.fail());
    this.exited = new Promise((resolve) => child.once('close', () => {
      lines.close();
      const unexpected = !this.closing;
      this.fail();
      if (unexpected) onExit();
      resolve();
    }));
    lines.on('line', (line) => {
      let message: JsonObject;
      try { message = asObject(JSON.parse(line)); } catch { return; }
      if (typeof message.method === 'string') {
        const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
        onMessage(message.method, asObject(message.params), id);
        return;
      }
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CodexRejected('Codex 拒绝了操作，请刷新会话状态后重试'));
      else pending.resolve(asObject(message.result));
    });
  }

  static async open(cwd: string, onMessage: (method: string, params: JsonObject, id?: RpcId) => void, onExit: () => void) {
    const cli = await resolveLocalCli('codex');
    const child = spawn(cli.command, [...cli.prefix, 'app-server', '--listen', 'stdio://'], {
      cwd, env: providerEnvironment(), windowsHide: true, stdio: 'pipe',
    });
    const app = new CodexAppServer(child, onMessage, onExit);
    try {
      await app.request('initialize', { clientInfo: { name: 'dovun', title: 'Dovun', version: '1' } });
      await app.write({ method: 'initialized' });
      return app;
    } catch (error) {
      await app.close();
      throw error;
    }
  }

  private fail() {
    this.active = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Codex 连接已断开，操作结果待核实'));
    }
    this.pending.clear();
  }

  private write(frame: JsonObject) {
    return new Promise<void>((resolve, reject) => {
      if (!this.active || !this.child.stdin.writable) {
        reject(new Error('Codex 连接已断开，操作结果待核实'));
        return;
      }
      this.child.stdin.write(JSON.stringify(frame) + '\n', (error) => error ? reject(error) : resolve());
    });
  }

  request(method: string, params: JsonObject) {
    const id = ++this.cursor;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex 响应超时，操作结果待核实'));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch(() => this.fail());
    });
  }

  reply(id: RpcId, result: JsonObject) { return this.write({ id, result }); }
  unsupported(id: RpcId) { return this.write({ id, error: { code: -32601, message: 'Unsupported request' } }); }
  get pid() { return this.child.pid; }

  async close() {
    this.closing = true;
    this.fail();
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.exited;
    const terminate = setTimeout(() => this.child.kill('SIGTERM'), 500);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
    try { await this.exited; } finally { clearTimeout(terminate); clearTimeout(kill); }
  }
}
