#!/usr/bin/env node
import { registerDataWriter } from '../shared/data-guard.js';
import { dirname } from 'node:path';
import { runtimeEnv, assertCurrentEnvironment } from '../shared/runtime-env.js';
/** dovun-node entry: `node dist/node-agent/index.js --server URL --token TOKEN --roots DIR[,DIR] [--data DIR] [--max N]`; with only `--data DIR` it runs from the saved config (desktop auto-start). */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NodeAgent } from './agent.js';

/** Standalone executors require an explicit offline import of old state. */
export function defaultNodeDataDir(base = homedir()) {
  if (existsSync(resolve(base, '.wwa-node'))) throw new Error('Old standalone executor state exists. Stop that executor and explicitly choose --data <existing-folder> or migrate an offline copy; refusing to start an empty executor.');
  return resolve(base, '.dovun-node');
}

const REVOKED_HINT = '已被吊销，请在 Dovun 里重新生成连接命令';

/** Root package.json from source or dist (`server/{src,dist}/node-agent`), then the desktop bundle's `server/package.json`. */
export async function readPackageVersion() {
  const override = runtimeEnv('NODE_VERSION')?.trim();
  if (override) return override.slice(0, 100);
  for (const url of [new URL('../../../package.json', import.meta.url), new URL('../../package.json', import.meta.url)]) {
    try {
      const parsed = JSON.parse(await readFile(fileURLToPath(url), 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim().slice(0, 100);
    } catch { /* Try the next candidate. An empty version is allowed. */ }
  }
  return '';
}

/** Same token as the one recorded when this computer was revoked: do not contact the server. */
export function refuseRevokedStart(saved: Record<string, unknown>, token: string, exit: (code: number) => void) {
  if (typeof saved.revokedAt !== 'string' || !saved.revokedAt) return false;
  if (String(saved.token ?? '') !== token) return false;
  console.error(`[wwa-node] ${REVOKED_HINT}`);
  exit(3);
  return true;
}

/** Keep every other config field and record when the server rejected this token. */
export async function markConfigRevoked(configPath: string) {
  const saved = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('config.json 不是对象');
  saved.revokedAt = new Date().toISOString();
  await writeFile(configPath, JSON.stringify(saved, null, 2), { mode: 0o600 });
}

/**
 * Started by the desktop app, the process inherits the GUI PATH (on macOS only /usr/bin:/bin:…), so codex / claude
 * and the node they need are not found. Adopt the PATH of the user's interactive login shell instead.
 */
async function adoptLoginShellPath() {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL && !process.env.SHELL.endsWith('nologin') ? process.env.SHELL : '/bin/zsh';
  try {
    const { stdout } = await promisify(execFile)(shell, ['-ilc', 'printf "__DOVUN_PATH__%s" "$PATH"'], { timeout: 15_000, maxBuffer: 1_000_000 });
    const value = stdout.split('__DOVUN_PATH__').pop()?.trim();
    if (value) process.env.PATH = [...new Set([...value.split(':'), ...(process.env.PATH ?? '').split(':')].filter(Boolean))].join(':');
  } catch { /* keep the inherited PATH */ }
}

function arg(name: string) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined; }
async function main() {
  assertCurrentEnvironment();
  const dataDir = resolve(arg('data') ?? runtimeEnv('NODE_DATA') ?? defaultNodeDataDir());
  await mkdir(dataDir, { recursive: true });
  const configPath = resolve(dataDir, 'config.json');
  const saved = await readFile(configPath, 'utf8').then((text) => JSON.parse(text) as Record<string, unknown>, () => ({} as Record<string, unknown>));
  if (runtimeEnv('NODE_MANAGED') === 'desktop') await registerDataWriter(dirname(dataDir));
  const token = arg('token') ?? runtimeEnv('NODE_TOKEN') ?? String(saved.token ?? '');
  if (refuseRevokedStart(saved, token, process.exit)) return;
  const config = {
    server: arg('server') ?? runtimeEnv('NODE_SERVER') ?? String(saved.server ?? ''),
    token,
    // Allowed roots live only in this machine's config; the server can never widen them.
    roots: (arg('roots') ?? runtimeEnv('NODE_ROOTS') ?? (Array.isArray(saved.roots) ? (saved.roots as string[]).join(',') : '')).split(',').map((item) => item.trim()).filter(Boolean).map((item) => resolve(item.replace(/^~(?=$|[\\/])/, homedir()))),
    maxConcurrent: Math.min(4, Math.max(1, Number(arg('max') ?? saved.maxConcurrent ?? 2))),
    dataDir,
    version: await readPackageVersion(),
  };
  if (!config.server || !config.token || !config.roots.length) {
    console.error('用法：wwa-node --server <WWA 地址> --token <执行端令牌> --roots <允许的代码目录，逗号分隔> [--data <数据目录>] [--max <并发 1-4>]');
    process.exit(2);
  }
  if (runtimeEnv('NODE_LOGIN_PATH') === '1') await adoptLoginShellPath();
  await writeFile(configPath, JSON.stringify({ server: config.server, token: config.token, roots: config.roots, maxConcurrent: config.maxConcurrent }, null, 2), { mode: 0o600 });
  const agent = new NodeAgent(config, fetch, { onRevoked: () => markConfigRevoked(configPath) });
  console.log(`[wwa-node] 已连接 ${config.server}，允许目录：${config.roots.join(', ')}，并发 ${config.maxConcurrent}`);
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    // Steps 1–3 of shutdown (stop pulling, cancel runs, abandon journals), then exit 0. Exit 3 is only for revocation.
    void agent.shutdown('signal').catch((error: unknown) => {
      console.error(`[wwa-node] 停止失败：${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  await agent.run();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exit(1); });
