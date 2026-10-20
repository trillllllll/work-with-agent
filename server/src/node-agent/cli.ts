/** Builds the local CLI launch for a run. Reuses the server's runner adapters, adding an explicit git-write grant when asked. */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildArgs } from '../runner/adapters.js';
import { commandFromPath, pathFromProcessPath } from '../runner/cli-commands.js';
import { resultJsonSchema, type LaunchSpec, type Permissions, type Provider } from '../runner/contracts.js';

const exec = promisify(execFile);
export async function resolveLocalCli(provider: Provider) {
  const configured = process.env[provider === 'codex' ? 'WWA_CODEX_BIN' : 'WWA_CLAUDE_BIN'];
  if (configured) {
    const path = resolve(configured);
    await access(path);
    return /\.[cm]?js$/i.test(path) ? { command: process.execPath, prefix: [path] } : { command: path, prefix: [] as string[] };
  }
  const found = await pathFromProcessPath(provider);
  if (!found) throw new Error(`本机没有找到 ${provider} CLI（可用 WWA_${provider.toUpperCase()}_BIN 指定）`);
  return commandFromPath(found);
}
export async function localProviders() {
  return Promise.all((['codex', 'claude'] as const).map(async (provider) => {
    try { const cli = await resolveLocalCli(provider); const { stdout } = await exec(cli.command, [...cli.prefix, '--version'], { timeout: 15_000, windowsHide: true }); return { provider, available: true, version: stdout.trim().slice(0, 200) }; }
    catch { return { provider, available: false, version: '' }; }
  }));
}

const toml = (value: string) => JSON.stringify(value);
/**
 * Codex keeps `.git` and the resolved worktree gitdir read-only under `:workspace` (openai/codex #15505, #27418).
 * A custom profile with explicit write rules for BOTH the per-worktree gitdir and the common gitdir lifts that
 * carve-out for this run only. Git also needs the shell tool, so gitWrite implies allowShell.
 */
export function withGitWrite(provider: Provider, args: string[], dirs: { gitDir: string; commonDir: string }) {
  if (provider === 'codex') {
    const index = args.findIndex((arg, i) => args[i - 1] === '-c' && arg.startsWith('default_permissions='));
    if (index < 0) throw new Error('Codex 参数中没有 default_permissions');
    const filesystem = `{ ":workspace_roots" = { "." = "write" }, ${toml(dirs.commonDir)} = "write", ${toml(dirs.gitDir)} = "write" }`;
    const next = [...args];
    next.splice(index - 1, 2, '-c', 'permissions.wwa_git.extends=":workspace"', '-c', `permissions.wwa_git.filesystem=${filesystem}`, '-c', 'default_permissions="wwa_git"');
    return next;
  }
  return args;
}

export async function createLocalLaunchSpec(input: { runId: string; provider: Provider; permissions: Permissions; cwd: string; controlDir: string; prompt: string; gitWrite?: { gitDir: string; commonDir: string } }): Promise<LaunchSpec> {
  const cli = await resolveLocalCli(input.provider);
  await mkdir(input.controlDir, { recursive: true });
  await writeFile(resolve(input.controlDir, 'result-schema.json'), JSON.stringify(resultJsonSchema));
  const permissions: Permissions = input.gitWrite ? { profile: 'workspace_write', allowShell: true } : input.permissions;
  let args = buildArgs(input.provider, permissions, input.controlDir);
  if (input.gitWrite) args = withGitWrite(input.provider, args, input.gitWrite);
  if (input.provider === 'codex') args.splice(args.indexOf('exec') + 1, 0, '--cd', input.cwd);
  return { runId: input.runId, provider: input.provider, command: cli.command, args: [...cli.prefix, ...args], cwd: input.cwd, prompt: input.prompt, controlDir: input.controlDir, finalOutputPath: resolve(input.controlDir, 'final.json') };
}
