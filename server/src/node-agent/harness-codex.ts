import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Agent, WebSocket } from 'undici';
import { providerEnvironment } from '../runner/environment.js';
import { resolveLocalCli } from './cli.js';

type RpcId = string | number;
type JsonObject = Record<string, unknown>;
export type HarnessNotification = (method: string, params: JsonObject, id?: RpcId) => void;
export type HarnessRuntime = Pick<CodexAppServer, 'request' | 'reply' | 'unsupported' | 'pid' | 'close'>;

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
  private constructor(
    private readonly send: (json: string) => Promise<void>,
    private readonly closeTransport: () => Promise<void>,
    readonly pid?: number,
    private readonly name = 'Codex',
  ) {}

  static fromStdio(child: ChildProcessWithoutNullStreams, onMessage: HarnessNotification, onExit: () => void, name = 'Codex') {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    // App Server diagnostics can include local account and configuration details.
    child.stderr.resume();
    const exited = new Promise<void>((resolve) => child.once('close', () => {
      lines.close();
      app.disconnected(onExit);
      resolve();
    }));
    const app = new CodexAppServer((json) => new Promise((resolve, reject) => {
      child.stdin.write(json + '\n', (error) => error ? reject(error) : resolve());
    }), async () => {
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return exited;
      const terminate = setTimeout(() => child.kill('SIGTERM'), 500);
      const kill = setTimeout(() => child.kill('SIGKILL'), 2_000);
      try { await exited; } finally { clearTimeout(terminate); clearTimeout(kill); }
    }, child.pid, name);
    child.stdin.on('error', () => app.fail());
    child.once('error', () => app.fail());
    lines.on('line', (line) => app.receive(line, onMessage));
    return app;
  }

  private receive(json: string, onMessage: HarnessNotification) {
    let message: JsonObject;
    try { message = asObject(JSON.parse(json)); } catch { return; }
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
    if (message.error) pending.reject(new CodexRejected(`${this.name} 拒绝了操作，请刷新会话状态后重试`));
    else pending.resolve(asObject(message.result));
  }

  static async open(cwd: string, onMessage: HarnessNotification, onExit: () => void,
    options: { modelProvider?: string; experimental?: boolean; shared?: boolean } = {}) {
    const app = options.shared ? await this.shared(onMessage, onExit) : await this.spawn(cwd, onMessage, onExit, options.modelProvider);
    try {
      await app.request('initialize', { clientInfo: { name: 'dovun', title: 'Dovun', version: '1' },
        ...(options.experimental ? { capabilities: { experimentalApi: true } } : {}) });
      await app.write({ method: 'initialized' });
      return app;
    } catch (error) {
      await app.close();
      throw error;
    }
  }

  private static async spawn(cwd: string, onMessage: HarnessNotification, onExit: () => void, modelProvider?: string) {
    const cli = await resolveLocalCli('codex');
    const provider = modelProvider ? ['-c', 'model_provider=' + JSON.stringify(modelProvider)] : [];
    const child = spawn(cli.command, [...cli.prefix, ...provider, 'app-server', '--listen', 'stdio://'], {
      cwd, env: providerEnvironment(), windowsHide: true, stdio: 'pipe',
    });
    return this.fromStdio(child, onMessage, onExit);
  }

  private static async shared(onMessage: HarnessNotification, onExit: () => void) {
    const socketPath = await realpath(resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock'));
    const info = await stat(socketPath);
    if (!info.isSocket() || info.uid !== process.getuid?.()) throw new CodexRejected('本机 Codex 共享连接不可用');
    const dispatcher = new Agent({ connect: { socketPath, timeout: 2_000 } });
    const socket = new WebSocket('ws://localhost/', { dispatcher });
    const app = new CodexAppServer(async (json) => { socket.send(json); }, async () => {
      socket.close();
      await dispatcher.destroy();
    });
    socket.addEventListener('message', (event) => { if (typeof event.data === 'string') app.receive(event.data, onMessage); });
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = () => { clearTimeout(timeout); reject(new CodexRejected('本机 Codex 共享连接不可用')); };
        const timeout = setTimeout(failed, 2_500);
        socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
        socket.addEventListener('error', failed, { once: true });
      });
      socket.addEventListener('close', () => app.disconnected(onExit), { once: true });
      return app;
    } catch (error) {
      await app.close();
      throw error;
    }
  }

  private disconnected(onExit: () => void) {
    this.fail();
    if (!this.closing) onExit();
  }

  private fail() {
    this.active = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${this.name} 连接已断开，操作结果待核实`));
    }
    this.pending.clear();
  }

  private write(frame: JsonObject) {
    if (!this.active) return Promise.reject(new Error(`${this.name} 连接已断开，操作结果待核实`));
    return this.send(JSON.stringify(frame));
  }

  request(method: string, params: JsonObject) {
    const id = ++this.cursor;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} 响应超时，操作结果待核实`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch(() => this.fail());
    });
  }

  reply(id: RpcId, result: JsonObject) { return this.write({ id, result }); }
  unsupported(id: RpcId) { return this.write({ id, error: { code: -32601, message: 'Unsupported request' } }); }
  async close() {
    this.closing = true;
    this.fail();
    await this.closeTransport();
  }
}
