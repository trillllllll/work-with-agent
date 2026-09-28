import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';


const exec = promisify(execFile);
const providers = ['codex', 'claude'] as const;
export type CliProvider = (typeof providers)[number];
export type CliSource = 'manual' | 'auto' | 'none';
export type CliCommandView = {
  command: string;
  source: CliSource;
  version: string;
  checkedAt: string;
  manualCommand: string;
  autoCommand: string;
  discoveredCommand: string;
  discoveredVersion: string;
  applied: boolean;
  message: string;
};
type StoredCli = { manualCommand: string; autoCommand: string; autoVersion: string; manualVersion: string; checkedAt: string };
const now = () => new Date().toISOString();
const emptyStored = (): StoredCli => ({ manualCommand: '', autoCommand: '', autoVersion: '', manualVersion: '', checkedAt: '' });

export function isCliProvider(value: string): value is CliProvider {
  return (providers as readonly string[]).includes(value);
}

export function commandFromPath(path: string) {
  return /\.[cm]?js$/i.test(path) ? { command: process.execPath, prefix: [path] } : { command: path, prefix: [] as string[] };
}

export function absoluteExecutable(value: string) {
  const path = value.trim();
  if (!path || path.includes('\n') || path.includes('\0') || !isAbsolute(path) || /\.(?:cmd|bat|ps1)$/i.test(path)) {
    throw new DomainError('CLI_NOT_FOUND', '命令必须是绝对路径上的可执行文件', 400);
  }
  return path;
}

export async function fileExists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

export async function readCommandVersion(path: string) {
  const command = commandFromPath(path);
  try {
    const { stdout } = await exec(command.command, [...command.prefix, '--version'], { windowsHide: true, timeout: 15000, maxBuffer: 100000 });
    return stdout.trim().slice(0, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法执行';
    throw new DomainError('CLI_NOT_FOUND', `无法运行 ${path}：${message}`, 400);
  }
}

export async function whichInLoginShell(provider: CliProvider) {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await exec('where.exe', [provider], { windowsHide: true, timeout: 8000, maxBuffer: 100000 });
      return stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => isAbsolute(line)) ?? '';
    } catch { return ''; }
  }
  const shell = process.env.SHELL && !process.env.SHELL.endsWith('nologin') ? process.env.SHELL : '/bin/zsh';
  try {
    // -i loads the interactive startup files, where this machine adds pnpm and ~/.local/bin.
    // A non-interactive login shell only reads .zprofile and does not see those commands.
    const { stdout } = await exec(shell, ['-ilc', `command -v ${provider}`], { timeout: 15000, maxBuffer: 100000 });
    const lines = stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    return [...lines].reverse().find((line) => isAbsolute(line) && line.endsWith(`/${provider}`)) ?? '';
  } catch { return ''; }
}

function fields(provider: CliProvider, stored: StoredCli) {
  const prefix = provider === 'codex' ? 'codex' : 'claude';
  return {
    [`${prefix}ManualCommand`]: stored.manualCommand,
    [`${prefix}AutoCommand`]: stored.autoCommand,
    [`${prefix}AutoVersion`]: stored.autoVersion,
    [`${prefix}ManualVersion`]: stored.manualVersion,
    [`${prefix}CheckedAt`]: stored.checkedAt,
  };
}

function readFields(row: Record<string, string> | null, provider: CliProvider): StoredCli {
  if (!row) return emptyStored();
  const prefix = provider === 'codex' ? 'codex' : 'claude';
  return {
    manualCommand: row[`${prefix}ManualCommand`] ?? '',
    autoCommand: row[`${prefix}AutoCommand`] ?? '',
    autoVersion: row[`${prefix}AutoVersion`] ?? '',
    manualVersion: row[`${prefix}ManualVersion`] ?? '',
    checkedAt: row[`${prefix}CheckedAt`] ?? '',
  };
}

async function storedRow() {
  return prisma.appSetting.findUnique({ where: { id: 'default' } }) as Promise<Record<string, string> | null>;
}

async function writeStored(provider: CliProvider, stored: StoredCli) {
  const timestamp = now();
  const data = { ...fields(provider, stored), updatedAt: timestamp };
  await prisma.appSetting.upsert({ where: { id: 'default' }, create: { id: 'default', createdAt: timestamp, ...data }, update: data });
}

export function viewFor(provider: CliProvider, stored: StoredCli, discovered?: { command: string; version: string; applied: boolean; message?: string }): CliCommandView {
  const manual = stored.manualCommand;
  const source: CliSource = manual ? 'manual' : stored.autoCommand ? 'auto' : 'none';
  return {
    command: manual || stored.autoCommand,
    source,
    version: manual ? stored.manualVersion : stored.autoVersion,
    checkedAt: stored.checkedAt,
    manualCommand: manual,
    autoCommand: stored.autoCommand,
    discoveredCommand: discovered?.command ?? '',
    discoveredVersion: discovered?.version ?? '',
    applied: discovered?.applied ?? !manual,
    message: discovered?.message ?? '',
  };
}

export async function cliSettings() {
  const row = await storedRow();
  return {
    codex: viewFor('codex', readFields(row, 'codex')),
    claude: viewFor('claude', readFields(row, 'claude')),
  };
}

export async function rememberAuto(provider: CliProvider, command: string, version: string) {
  const current = readFields(await storedRow(), provider);
  const next = { ...current, autoCommand: command, autoVersion: version, checkedAt: now() };
  await writeStored(provider, next);
  return viewFor(provider, next, { command, version, applied: !current.manualCommand });
}

export async function saveManual(provider: CliProvider, command: string) {
  const path = absoluteExecutable(command);
  if (!await fileExists(path)) throw new DomainError('CLI_NOT_FOUND', '填写的命令不存在', 400);
  const version = await readCommandVersion(path);
  const current = readFields(await storedRow(), provider);
  const next = { ...current, manualCommand: path, manualVersion: version, checkedAt: now() };
  await writeStored(provider, next);
  return viewFor(provider, next, { command: path, version, applied: true });
}

export async function clearManual(provider: CliProvider) {
  const current = readFields(await storedRow(), provider);
  const next = { ...current, manualCommand: '', manualVersion: '', checkedAt: now() };
  await writeStored(provider, next);
  return viewFor(provider, next);
}

export async function discoverCli(provider: CliProvider) {
  const found = await whichInLoginShell(provider);
  if (!found || !await fileExists(found)) throw new DomainError('CLI_NOT_FOUND', `登录 shell 中未找到 ${provider}`, 404);
  const version = await readCommandVersion(found);
  return rememberAuto(provider, found, version);
}

export async function discoverClis() {
  const results = await Promise.all(providers.map(async (provider) => {
    try { return [provider, await discoverCli(provider)] as const; }
    catch (error) {
      const message = error instanceof Error ? error.message : `登录 shell 中未找到 ${provider}`;
      return [provider, viewFor(provider, readFields(await storedRow(), provider), { command: '', version: '', applied: false, message })] as const;
    }
  }));
  return Object.fromEntries(results) as Record<CliProvider, CliCommandView>;
}

export async function storedCommands(provider: CliProvider) {
  const stored = readFields(await storedRow(), provider);
  return { manualCommand: stored.manualCommand, autoCommand: stored.autoCommand };
}

export async function pathFromProcessPath(provider: CliProvider) {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const direct = join(directory, `${provider}${process.platform === 'win32' ? '.exe' : ''}`);
    if (await fileExists(direct)) return direct;
    const packageRoot = join(directory, 'node_modules', provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code');
    if (provider === 'codex' && await fileExists(join(packageRoot, 'bin', 'codex.js'))) return join(packageRoot, 'bin', 'codex.js');
    if (provider === 'claude') {
      if (await fileExists(join(packageRoot, 'bin', 'claude.exe'))) return join(packageRoot, 'bin', 'claude.exe');
      if (await fileExists(join(packageRoot, 'cli.js'))) return join(packageRoot, 'cli.js');
    }
  }
  return '';
}

export function resolveConfiguredPath(path: string) {
  return resolve(absoluteExecutable(path));
}
