import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { providerEnvironment } from '../runner/environment.js';
import { runtimeEnv } from '../shared/runtime-env.js';
import { AcpConnection, type AcpMessage } from './harness-acp.js';
import { CodexRejected } from './harness-codex.js';

const exec = promisify(execFile);
export const KIMI_HOME = () => resolve(process.env.KIMI_CODE_HOME?.trim() || resolve(homedir(), '.kimi-code'));

export async function resolveKimiCli(): Promise<{ command: string; prefix: string[] }> {
  const override = runtimeEnv('KIMI_BIN');
  if (override) {
    const path = resolve(override);
    await access(path);
    return /\.[cm]?js$/i.test(path) ? { command: process.execPath, prefix: [path] } : { command: path, prefix: [] };
  }
  const installed = resolve(KIMI_HOME(), 'bin', 'kimi');
  if (await access(installed, constants.X_OK).then(() => true, () => false)) return { command: installed, prefix: [] };
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const command = join(directory, 'kimi' + (process.platform === 'win32' ? '.exe' : ''));
    if (await access(command, constants.X_OK).then(() => true, () => false)) return { command, prefix: [] };
  }
  throw new CodexRejected('本机没有找到 Kimi Code CLI（可用 DOVUN_KIMI_BIN 指定）');
}

function supportedVersion(stdout: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(stdout.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || major === 2 && (minor > 6 || minor === 6 && patch >= 3);
}

export async function kimiAvailable() {
  try {
    const cli = await resolveKimiCli();
    const { stdout } = await exec(cli.command, [...cli.prefix, '--version'], { timeout: 5_000, windowsHide: true });
    return supportedVersion(stdout);
  } catch { return false; }
}

function kimiEnvironment() {
  const env = providerEnvironment();
  delete env.DOVUN_NODE_TOKEN;
  return env;
}

export async function openKimiAcp(cwd: string, onMessage: AcpMessage) {
  const cli = await resolveKimiCli();
  return AcpConnection.open({
    command: cli.command, args: [...cli.prefix, 'acp'], cwd, env: kimiEnvironment(), onMessage,
    label: 'Kimi Code',
  });
}
