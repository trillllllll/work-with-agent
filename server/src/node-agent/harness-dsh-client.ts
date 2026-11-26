import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { providerEnvironment } from '../runner/environment.js';
import { runtimeEnv } from '../shared/runtime-env.js';
import { CodexRejected } from './harness-codex.js';

const exec = promisify(execFile);
const bundle = 'DeepSeek Harness.app/Contents';
const launcher = 'runtime/cli/bin/dsh';

export function DSH_HOME() { return process.env.DSH_HOME?.trim() || resolve(homedir(), '.dsh'); }
export function dshSessionsDir() { return resolve(DSH_HOME(), 'sessions'); }
// The ACP profile keeps per-session titles and timestamps here as plain JSON.
export function dshProjectionDir() { return resolve(DSH_HOME(), 'storages/session_projcache/sessions'); }

/** The ACP profile and the services the bridge calls were verified on 0.2.2-rc.5 and are gated to that line. */
function supportedVersion(stdout: string) {
  const version = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?/.exec(stdout.trim());
  if (!version) return false;
  const [major, minor, patch, rc] = version.slice(1).map(Number);
  return major > 0 || minor > 2 || patch > 2 || patch === 2 && (version[4] === undefined || rc >= 5);
}

function dshEnvironment() {
  const env = providerEnvironment();
  delete env.DOVUN_NODE_TOKEN;
  // New sessions start in the middle preset; a resumed session keeps the preset it records.
  return { ...env, DSH_PERMISSION_MODE: 'workspace-write' };
}

/** The standalone launcher is preferred; machines with dsh only on PATH still work through the profile name. */
export async function resolveDshCli(): Promise<{ command: string; prefix: string[] }> {
  const override = runtimeEnv('DSH_BIN');
  if (override) return { command: resolve(override), prefix: [] };
  if (process.platform !== 'darwin') throw new CodexRejected('DSH 会话目前只支持 macOS');
  for (const root of [resolve('/Applications', bundle), resolve(homedir(), 'Applications', bundle)]) {
    const command = resolve(root, launcher);
    if (await access(command, constants.X_OK).then(() => true, () => false)) return { command, prefix: [] };
  }
  return { command: 'dsh', prefix: [] };
}

export async function dshAvailable() {
  try {
    const cli = await resolveDshCli();
    const { stdout } = await exec(cli.command, [...cli.prefix, '--version'], { env: dshEnvironment(), timeout: 5_000, windowsHide: true });
    return supportedVersion(stdout);
  } catch { return false; }
}

export class AcpError extends Error {
  constructor(readonly code: number, message: string, readonly data: unknown) { super(message); }
}

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout };
type AgentMessage = (method: string, params: Record<string, unknown>, id?: number | string) => void;
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Newline-delimited JSON-RPC to `dsh --profile acp`. The prompt request settles only when the turn ends, so it has no timer. */
export class AcpConnection {
  private cursor = 0;
  private readonly pending = new Map<number, Pending>();
  private closing = false;
  readonly exited: Promise<void>;

  constructor(readonly child: ChildProcessWithoutNullStreams, onMessage: AgentMessage) {
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let spawned = false;
    child.once('spawn', () => { spawned = true; });
    this.exited = new Promise<void>((done) => {
      const exit = () => {
        lines.close();
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error('DSH 连接已断开，操作结果待核实'));
        }
        this.pending.clear();
        done();
      };
      child.once('close', exit);
      // A process that never starts does not reach close. Nothing was sent, so its requests are plain rejections.
      child.once('error', () => {
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(spawned ? new Error('DSH 连接已断开，操作结果待核实') : new CodexRejected('本机无法启动 DSH，请确认已安装 DeepSeek Harness'));
        }
        this.pending.clear();
        if (!spawned) exit();
      });
    });
    child.stdin.on('error', () => undefined);
    lines.on('line', (line) => {
      let message: Record<string, unknown>;
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
          typeof error.message === 'string' ? error.message : 'DSH 拒绝了操作', error.data));
      } else entry.resolve(asRecord(message.result));
    });
  }

  static open(cwd: string, overlay: string, onMessage: AgentMessage) {
    return resolveDshCli().then((cli) => new AcpConnection(spawn(cli.command, [...cli.prefix, '--profile', 'acp', '--patch', overlay],
      { cwd, env: dshEnvironment(), windowsHide: true, stdio: 'pipe' }), onMessage));
  }

  get pid() { return this.child.pid; }

  request<T extends Record<string, unknown> = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeoutMs = 15_000) {
    const id = ++this.cursor;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: (value) => resolve(value as T), reject };
      if (timeoutMs) entry.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('DSH 响应超时，操作结果待核实'));
      }, timeoutMs);
      this.pending.set(id, entry);
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
        if (error) { clearTimeout(entry.timer); this.pending.delete(id); reject(new Error('DSH 连接已断开，操作结果待核实')); }
      });
    });
  }

  notify(method: string, params: Record<string, unknown>) {
    if (!this.closing) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  respond(id: number | string, result: Record<string, unknown>) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
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

/**
 * dsh exposes permission presets and live text only through its own services. This plugin is added to one launch by a
 * `--patch` overlay and calls those services over a private socket; the user's profile is never modified.
 */
const BRIDGE_PLUGIN = `import { connect } from 'node:net';

export const name = 'dovun-bridge';
export const inject = ['permissionPresets', 'sessions', 'llm'];

export function apply(ctx, config) {
  const socket = connect(config.socket);
  socket.setEncoding('utf8');
  let buffer = '';
  const send = (message) => { if (socket.writable) socket.write(JSON.stringify(message) + '\\n'); };
  const session = (id) => {
    const found = ctx.sessions.get(id);
    if (!found) throw new Error('unknown or inactive session');
    return found;
  };
  const handlers = {
    ping: () => ({}),
    'permission.current': ({ sessionId }) => ({
      current: ctx.permissionPresets.current(session(sessionId)),
      options: ctx.permissionPresets.catalog().options.map((option) => option.value),
    }),
    'permission.set': ({ sessionId, preset }) => {
      const found = session(sessionId);
      ctx.permissionPresets.set(found, preset);
      return { current: ctx.permissionPresets.current(found) };
    },
    catalog: async () => {
      const models = [];
      for (const provider of ctx.llm.listProviders()) {
        let listed;
        try { listed = await ctx.llm.listModels(provider.id); } catch { continue; }
        for (const model of listed) {
          let efforts = [];
          let defaultEffort = null;
          try {
            const info = await ctx.llm.resolveModelInfo(provider.id, model.id);
            if (info.reasoning) {
              efforts = info.reasoning.efforts.map((effort) => String(effort.id));
              if (info.reasoning.defaultEffort !== undefined) defaultEffort = String(info.reasoning.defaultEffort);
            }
          } catch { /* A model without a readable route keeps no effort list. */ }
          models.push({ value: JSON.stringify([provider.id, model.id]), label: model.name, provider: provider.name, efforts, defaultEffort });
        }
      }
      return { models };
    },
  };
  socket.on('connect', () => send({ hello: config.token }));
  socket.on('data', (chunk) => {
    buffer += chunk;
    let end = buffer.indexOf('\\n');
    while (end !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf('\\n');
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      if (typeof request.id !== 'number' || typeof request.method !== 'string') continue;
      const answer = Promise.resolve().then(() => {
        if (!handlers[request.method]) throw new Error('unknown bridge method');
        return handlers[request.method](request.params || {});
      });
      answer.then((result) => send({ id: request.id, result }), (error) => send({ id: request.id, error: String(error && error.message || error) }));
    }
  });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = agent && agent.session && agent.session.id;
    if (!sessionId || !socket.writable) return;
    if (frame.type === 'start') send({ event: 'stream-start', sessionId, turn: frame.turn, step: frame.step });
    else if (frame.type === 'end') send({ event: 'stream-end', sessionId, outcome: frame.outcome && frame.outcome.kind });
    else if (frame.type === 'chunk' && frame.chunk && frame.chunk.type === 'text-delta') {
      send({ event: 'text-delta', sessionId, index: frame.chunk.index, text: frame.chunk.text });
    }
  });
  ctx.on('session/event', (current, event) => {
    if (event.type !== 'assistant/message' || !socket.writable) return;
    const data = event.data || {};
    const message = data.message || {};
    const blocks = Array.isArray(message.content) ? message.content : [];
    const texts = [];
    blocks.forEach((block, index) => { if (block.type === 'text') texts.push({ index, text: block.text || '' }); });
    send({ event: 'message', sessionId: current.header.id, messageId: message.id, turn: data.turn, step: data.step,
      tools: blocks.some((block) => block.type === 'tool-call'), texts });
  });
  ctx.effect(() => () => socket.destroy(), 'dovun-bridge.socket');
}
`;

type Reply = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** The executor's end of the bridge: a user-private Unix socket that one dsh process connects to. */
export class DshBridge {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private buffer = '';
  private cursor = 0;
  private directory = '';
  private readonly pending = new Map<number, Reply>();
  private token = '';
  private connected = false;
  private waiters: Array<() => void> = [];
  onEvent: ((event: string, params: Record<string, unknown>) => void) | null = null;

  static async start() {
    const bridge = new DshBridge();
    bridge.token = randomToken();
    bridge.directory = await mkdtemp(join(tmpdir(), 'dovun-dsh-'));
    const path = join(bridge.directory, 'bridge.sock');
    await new Promise<void>((done, reject) => {
      bridge.server = createServer((socket) => bridge.accept(socket));
      bridge.server.once('error', reject);
      bridge.server.listen(path, () => { bridge.server?.off('error', reject); done(); });
    });
    await chmod(path, 0o600);
    await writeFile(join(bridge.directory, 'dovun-dsh-bridge.mjs'), BRIDGE_PLUGIN, { mode: 0o600 });
    await writeFile(join(bridge.directory, 'bridge.patch.yml'), [
      '# Written by the Dovun executor for one dsh launch; the profile itself is left unchanged.',
      '- insert:',
      '    - id: dovun-bridge',
      "      name: './dovun-dsh-bridge.mjs'",
      '      config:',
      `        socket: ${JSON.stringify(path)}`,
      `        token: ${JSON.stringify(bridge.token)}`,
      '',
    ].join('\n'), { mode: 0o600 });
    return bridge;
  }

  get overlay() { return join(this.directory, 'bridge.patch.yml'); }
  get ready() { return this.connected; }

  private accept(socket: Socket) {
    // The first line must present the launch token; any other connection is closed without a reply.
    let greeted = false;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf('\n');
      while (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf('\n');
        if (!greeted) {
          let hello: unknown;
          try { hello = JSON.parse(line)?.hello; } catch { hello = undefined; }
          if (hello !== this.token || this.connected) { socket.destroy(); return; }
          greeted = true;
          this.connected = true;
          this.socket = socket;
          for (const waiter of this.waiters.splice(0)) waiter();
          continue;
        }
        this.receive(line);
      }
    });
    socket.on('error', () => undefined);
  }

  private receive(line: string) {
    let message: Record<string, unknown>;
    try { message = asRecord(JSON.parse(line)); } catch { return; }
    if (typeof message.event === 'string') { this.onEvent?.(message.event, message); return; }
    if (typeof message.id !== 'number') return;
    const reply = this.pending.get(message.id);
    if (!reply) return;
    this.pending.delete(message.id);
    clearTimeout(reply.timer);
    if (message.error) reply.reject(new Error(String(message.error).slice(0, 300)));
    else reply.resolve(asRecord(message.result));
  }

  /** Resolves once the plugin has connected, or after the grace period when it never loads. */
  async waitForPlugin(ms: number) {
    if (this.connected) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(done, ms);
      this.waiters.push(() => { clearTimeout(timer); done(); });
    });
  }

  /** Null means the bridge is unavailable for this launch; callers then keep the reduced behavior. */
  call<T extends Record<string, unknown> = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 3_000): Promise<T | null> {
    if (!this.connected || !this.socket) return Promise.resolve(null);
    const id = ++this.cursor;
    return new Promise<T | null>((resolve) => {
      const reply: Reply = { resolve: (value) => resolve(value as T), reject: () => resolve(null),
        timer: setTimeout(() => { this.pending.delete(id); resolve(null); }, timeoutMs) };
      this.pending.set(id, reply);
      this.socket!.write(JSON.stringify({ id, method, params }) + '\n', () => undefined);
    });
  }

  async stop() {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    for (const reply of this.pending.values()) { clearTimeout(reply.timer); reply.reject(new Error('DSH 桥接已关闭')); }
    this.pending.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((done) => server.close(() => done()));
    // The socket lives inside the private directory, so removing the directory also removes it.
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function randomToken() {
  return randomUUID().replace(/-/g, '');
}
