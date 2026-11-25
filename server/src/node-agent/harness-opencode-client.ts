import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { CodexRejected } from './harness-codex.js';

const exec = promisify(execFile);

// OpenCode 2 keeps sessions in a shared local service. Clients discover it through the state registry.
export const OPENCODE_STATE_DIR = () => process.env.OPENCODE_STATE_DIR || resolve(homedir(), '.local/state/opencode');
export const OPENCODE_DATA_DIR = () => process.env.OPENCODE_DATA_DIR || resolve(homedir(), '.local/share/opencode');

export type OpenCodeService = { url: string; password: string | null };

export async function resolveOpenCodeService(): Promise<OpenCodeService> {
  const url = process.env.OPENCODE_SERVICE_URL;
  if (url) return { url: url.replace(/\/$/, ''), password: process.env.OPENCODE_PASSWORD || null };
  return readServiceRegistry();
}

async function readServiceRegistry(): Promise<OpenCodeService> {
  const path = resolve(OPENCODE_STATE_DIR(), 'service.json');
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (!raw) throw new CodexRejected('本机没有运行中的 OpenCode 服务，请先打开 OpenCode');
  let registry: Record<string, unknown>;
  try { registry = JSON.parse(raw) as Record<string, unknown>; } catch { throw new CodexRejected('本机 OpenCode 服务信息已损坏，请重新打开 OpenCode'); }
  const url = typeof registry.url === 'string' ? registry.url.replace(/\/$/, '') : '';
  const version = typeof registry.version === 'string' ? registry.version : '';
  if (!url || !/^2\.\d+\.\d+/.test(version)) throw new CodexRejected('本机 OpenCode 服务版本过旧，请升级 OpenCode 后重试');
  return { url, password: typeof registry.password === 'string' && registry.password ? registry.password : null };
}

async function desktopCliPaths(): Promise<string[]> {
  const directory = resolve(homedir(), 'Library/Application Support/ai.opencode.desktop/cli');
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => resolve(directory, entry.name, 'opencode-cli'));
}

/** The standalone CLI is preferred; the desktop bundle is a fallback for machines without one. */
export async function resolveOpenCodeCli(): Promise<{ command: string; prefix: string[] }> {
  const override = process.env.OPENCODE_BIN;
  if (override) return { command: override, prefix: [] };
  const standalone = resolve(homedir(), '.opencode/bin/opencode');
  const desktop = await desktopCliPaths();
  for (const command of [standalone, ...desktop]) {
    if (await readFile(command).then(() => true, () => false)) return { command, prefix: [] };
  }
  throw new CodexRejected('本机未找到 OpenCode，请先安装 OpenCode 2');
}

export async function opencodeAvailable() {
  try {
    const { command, prefix } = await resolveOpenCodeCli();
    const { stdout } = await exec(command, [...prefix, '--version'], { timeout: 5_000, windowsHide: true });
    const version = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)/i.exec(stdout.trim());
    return !!version && Number(version[1]) >= 2;
  } catch { return false; }
}

async function serviceHealthy(service: OpenCodeService) {
  try {
    const response = await fetch(service.url + '/api/info', { signal: AbortSignal.timeout(2_500), headers: authHeaders(service) });
    if (!response.ok) return false;
    const info = await response.json().catch(() => null) as Record<string, unknown> | null;
    const version = typeof info?.version === 'string' ? info.version : '';
    return /^2\.\d+\.\d+/.test(version);
  } catch { return false; }
}

async function startSharedService() {
  const cli = await resolveOpenCodeCli().catch(() => null);
  if (!cli) return;
  await exec(cli.command, [...cli.prefix, 'service', 'start'], { timeout: 30_000, windowsHide: true }).catch(() => undefined);
}

/** Attach to the running shared service, starting it once when no compatible service answers. */
export async function ensureOpenCodeService(): Promise<OpenCodeService> {
  let service = await resolveOpenCodeService().catch(() => null);
  if (service && await serviceHealthy(service)) return service;
  if (process.env.OPENCODE_SERVICE_URL) throw new CodexRejected('OpenCode 测试服务不可用');
  await startSharedService();
  service = await readServiceRegistry().catch(() => null);
  for (let attempt = 0; attempt < 10 && !(service && await serviceHealthy(service)); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    service = await readServiceRegistry().catch(() => null);
  }
  if (!service || !await serviceHealthy(service)) throw new CodexRejected('无法启动本机 OpenCode 服务，请手动打开 OpenCode 后重试');
  return service;
}

function authHeaders(service: OpenCodeService): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (service.password) headers.authorization = 'Basic ' + Buffer.from('opencode:' + service.password).toString('base64');
  return headers;
}

export class OpenCodeError extends Error {
  constructor(readonly status: number, readonly tag: string, message: string) {
    super(message);
  }
}

export async function openCodeRequest<T = Record<string, unknown>>(service: OpenCodeService, method: 'GET' | 'POST' | 'PATCH',
  path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(service.url + path, {
    method, headers: authHeaders(service), signal: AbortSignal.timeout(30_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => { throw new CodexRejected('本机 OpenCode 服务连接失败'); });
  if (response.status === 204) return {} as T;
  const payload = await response.json().catch(() => null) as (Record<string, unknown> | null);
  if (!response.ok) {
    if (response.status === 404) throw new OpenCodeError(404, typeof payload?._tag === 'string' ? payload._tag : '', typeof payload?.message === 'string' ? payload.message : 'OpenCode 会话不存在');
    if (response.status === 401) throw new CodexRejected('本机 OpenCode 服务鉴权失败，请重新打开 OpenCode');
    const message = typeof payload?.message === 'string' && payload.message ? payload.message : `OpenCode 请求失败（${response.status}）`;
    throw new CodexRejected(message);
  }
  return (payload ?? {}) as T;
}

/** The global event stream is one SSE connection filtered here by session. */
export async function subscribeOpenCodeEvents(service: OpenCodeService, onEvent: (event: Record<string, unknown>) => void,
  signal: AbortSignal, onLoss: () => void) {
  try {
    const response = await fetch(service.url + '/api/event', { headers: authHeaders(service), signal });
    if (!response.ok || !response.body) throw new Error('stream refused');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n');
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary).replace(/\r$/, '');
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        try { onEvent(JSON.parse(line.slice(5).trim()) as Record<string, unknown>); } catch { /* ignore malformed frames */ }
      }
    }
  } catch {
    // Losing the stream hands the session back to the controller's reconnect path.
  } finally {
    if (!signal.aborted) onLoss();
  }
}
