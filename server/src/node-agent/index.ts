#!/usr/bin/env node
/** wwa-node entry: `node dist/node-agent/index.js --server URL --token TOKEN --roots DIR[,DIR] [--data DIR] [--max N]`; with only `--data DIR` it runs from the saved config (desktop auto-start). */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NodeAgent } from './agent.js';

/**
 * Started by the desktop app, the process inherits the GUI PATH (on macOS only /usr/bin:/bin:…), so codex / claude
 * and the node they need are not found. Adopt the PATH of the user's interactive login shell instead.
 */
async function adoptLoginShellPath() {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL && !process.env.SHELL.endsWith('nologin') ? process.env.SHELL : '/bin/zsh';
  try {
    const { stdout } = await promisify(execFile)(shell, ['-ilc', 'printf "__WWA_PATH__%s" "$PATH"'], { timeout: 15_000, maxBuffer: 1_000_000 });
    const value = stdout.split('__WWA_PATH__').pop()?.trim();
    if (value) process.env.PATH = [...new Set([...value.split(':'), ...(process.env.PATH ?? '').split(':')].filter(Boolean))].join(':');
  } catch { /* keep the inherited PATH */ }
}

function arg(name: string) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined; }
async function main() {
  const dataDir = resolve(arg('data') ?? process.env.WWA_NODE_DATA ?? resolve(homedir(), '.wwa-node'));
  await mkdir(dataDir, { recursive: true });
  const configPath = resolve(dataDir, 'config.json');
  const saved = await readFile(configPath, 'utf8').then((text) => JSON.parse(text) as Record<string, unknown>, () => ({} as Record<string, unknown>));
  const config = {
    server: arg('server') ?? process.env.WWA_NODE_SERVER ?? String(saved.server ?? ''),
    token: arg('token') ?? process.env.WWA_NODE_TOKEN ?? String(saved.token ?? ''),
    // Allowed roots live only in this machine's config; the server can never widen them.
    roots: (arg('roots') ?? process.env.WWA_NODE_ROOTS ?? (Array.isArray(saved.roots) ? (saved.roots as string[]).join(',') : '')).split(',').map((item) => item.trim()).filter(Boolean).map((item) => resolve(item.replace(/^~(?=$|[\\/])/, homedir()))),
    maxConcurrent: Math.min(4, Math.max(1, Number(arg('max') ?? saved.maxConcurrent ?? 2))),
    dataDir,
  };
  if (!config.server || !config.token || !config.roots.length) {
    console.error('用法：wwa-node --server <WWA 地址> --token <执行端令牌> --roots <允许的代码目录，逗号分隔> [--data <数据目录>] [--max <并发 1-4>]');
    process.exit(2);
  }
  if (process.env.WWA_NODE_LOGIN_PATH === '1') await adoptLoginShellPath();
  await writeFile(configPath, JSON.stringify({ server: config.server, token: config.token, roots: config.roots, maxConcurrent: config.maxConcurrent }, null, 2), { mode: 0o600 });
  const agent = new NodeAgent(config);
  console.log(`[wwa-node] 已连接 ${config.server}，允许目录：${config.roots.join(', ')}，并发 ${config.maxConcurrent}`);
  process.on('SIGINT', () => { agent.stop(); process.exit(0); });
  process.on('SIGTERM', () => { agent.stop(); process.exit(0); });
  await agent.run();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exit(1); });
