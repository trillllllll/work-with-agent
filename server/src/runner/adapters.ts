import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DomainError } from '../domain/task.js';
import { providerSchema, resultJsonSchema, resultSchema, type LaunchSpec, type Permissions, type Provider, type RunResult } from './contracts.js';
import { commandFromPath, discoverCli, fileExists, isCliProvider, pathFromProcessPath, resolveConfiguredPath, storedCommands } from './cli-commands.js';

const exec = promisify(execFile);
export type CliCommand = { command: string; prefix: string[] };
export function codexWindowsSandboxArgs(platform = process.platform, backend = process.env.WWA_CODEX_WINDOWS_SANDBOX ?? 'unelevated'): string[] {
  if (platform !== 'win32') return [];
  if (!['unelevated', 'elevated'].includes(backend)) throw new DomainError('INVALID_SANDBOX_BACKEND', 'WWA_CODEX_WINDOWS_SANDBOX 仅支持 unelevated 或 elevated', 503);
  // --ignore-user-config also omits this required native backend. Keep :workspace/:read-only
  // permissions; selecting a backend does not grant full access or modify global settings.
  return ['-c', `windows.sandbox="${backend}"`];
}
async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
export async function resolveCli(provider: Provider): Promise<CliCommand> {
  providerSchema.parse(provider);
  if (isCliProvider(provider)) {
    const saved = await storedCommands(provider);
    if (saved.manualCommand) {
      const path = resolveConfiguredPath(saved.manualCommand);
      if (!await fileExists(path)) throw new DomainError('CLI_NOT_FOUND', `已保存的 ${provider} 命令不存在：${path}`, 503);
      return commandFromPath(path);
    }
  }
  const configured = process.env[provider === 'codex' ? 'WWA_CODEX_BIN' : 'WWA_CLAUDE_BIN'];
  if (configured) {
    const path = resolve(configured);
    if (!await exists(path) || /\.(?:cmd|bat|ps1)$/i.test(path)) throw new DomainError('CLI_NOT_FOUND', '配置的 CLI 必须是可执行文件或 JavaScript 入口', 503);
    return /\.[cm]?js$/i.test(path) ? { command: process.execPath, prefix: [path] } : { command: path, prefix: [] };
  }
  if (isCliProvider(provider)) {
    const saved = await storedCommands(provider);
    if (saved.autoCommand && await fileExists(saved.autoCommand)) return commandFromPath(saved.autoCommand);
    try {
      const discovered = await discoverCli(provider);
      if (discovered.command && await fileExists(discovered.command)) return commandFromPath(discovered.command);
    } catch { /* The settings page reports a missing login-shell command. */ }
  }
  const fromPath = isCliProvider(provider) ? await pathFromProcessPath(provider) : '';
  if (fromPath) return commandFromPath(fromPath);
  throw new DomainError('CLI_NOT_FOUND', `未找到 ${provider} CLI；请在设置中自动检查或手动填写`, 503);
}
export async function capabilities() {
  return Promise.all((['codex', 'claude'] as const).map(async (provider) => {
    try {
      const command = await resolveCli(provider);
      const { stdout } = await exec(command.command, [...command.prefix, '--version'], { windowsHide: true, timeout: 15000, maxBuffer: 100000 });
      return { provider, available: true, version: stdout.trim(), launch: true, resume: true, cancelOwnedProcess: true, resumeRequiresSessionId: true, interactiveInput: false, osWriteSandbox: provider === 'codex', authenticated: 'not_checked' };
    } catch (error) { return { provider, available: false, error: error instanceof Error ? error.message : 'CLI 不可用', launch: false, resume: false, cancelOwnedProcess: false, interactiveInput: false }; }
  }));
}
export function buildArgs(provider: Provider, permissions: Permissions, controlDir: string, sessionId?: string): string[] {
  const schemaPath = resolve(controlDir, 'result-schema.json');
  const outputPath = resolve(controlDir, 'final.json');
  if (provider === 'codex') {
    const permissionProfile = permissions.profile === 'workspace_write' ? ':workspace' : ':read-only';
    const disabled = ['apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'image_generation', 'workspace_dependencies', 'skill_search', 'in_app_browser', ...(!permissions.allowShell ? ['shell_tool', 'unified_exec'] : [])];
    // Modern profiles survive exec's app-server round-trip; do not mix legacy sandbox_mode.
    return ['--ask-for-approval', 'never', ...disabled.flatMap((feature) => ['--disable', feature]), 'exec', ...(sessionId ? ['resume', sessionId] : []), '-c', `default_permissions="${permissionProfile}"`, ...codexWindowsSandboxArgs(), '-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json', '--output-schema', schemaPath, '--output-last-message', outputPath, '-'];
  }
  const write = permissions.profile === 'workspace_write';
  const allowed = ['Read', 'Glob', 'Grep', ...(write ? ['Edit', 'Write'] : []), ...(permissions.allowShell ? ['Bash'] : [])];
  return ['-p', '--verbose', '--safe-mode', '--output-format', 'stream-json', '--json-schema', JSON.stringify(resultJsonSchema), '--permission-mode', write ? 'acceptEdits' : 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', allowed.join(','), '--allowedTools', allowed.join(','), ...(sessionId ? ['--resume', sessionId] : [])];
}
export async function createLaunchSpec(input: { runId: string; provider: Provider; permissions: Permissions; cwd: string; controlDir: string; prompt: string; externalSessionId?: string }): Promise<LaunchSpec> {
  const cli = await resolveCli(input.provider);
  await mkdir(input.controlDir, { recursive: true });
  await writeFile(resolve(input.controlDir, 'result-schema.json'), JSON.stringify(resultJsonSchema));
  const args = buildArgs(input.provider, input.permissions, input.controlDir, input.externalSessionId);
  if (input.provider === 'codex') args.splice(args.indexOf('exec') + 1, 0, '--cd', input.cwd);
  return { runId: input.runId, provider: input.provider, command: cli.command, args: [...cli.prefix, ...args], cwd: input.cwd, prompt: input.prompt, controlDir: input.controlDir, finalOutputPath: resolve(input.controlDir, 'final.json'), externalSessionId: input.externalSessionId };
}
/** Normalized CLI usage. Codex totals already include cached input and reasoning output; do not add those again. */
export type CliUsage = {
  model: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  numTurns: number | null;
  cliDurationMs: number | null;
  raw: unknown;
};
function finiteInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) return null;
  return value;
}
function finiteCost(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}
function addInt(left: number | null, right: number | null): number | null {
  if (left == null && right == null) return null;
  const sum = (left ?? 0) + (right ?? 0);
  return Number.isSafeInteger(sum) ? sum : null;
}
function modelName(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}
function streamEvents(text: string): Array<Record<string, any>> {
  const events: Array<Record<string, any>> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
    } catch { /* Incomplete or non-JSON lines are ignored. */ }
  }
  return events;
}
/**
 * Codex `turn.completed.usage` is a thread-cumulative total, so only the last event counts.
 * Claude prefers `modelUsage` (includes subagents); `usage` is the fallback. No result and no init yields null.
 */
export function parseUsage(provider: Provider, text: string): CliUsage | null {
  const events = streamEvents(text);
  if (provider === 'codex') {
    let saw = false;
    let usage: Record<string, unknown> | null = null;
    for (const event of events) {
      if (event.type !== 'turn.completed') continue;
      saw = true;
      usage = event.usage && typeof event.usage === 'object' && !Array.isArray(event.usage) ? event.usage as Record<string, unknown> : null;
    }
    if (!saw || !usage) return null;
    return {
      model: null,
      inputTokens: finiteInt(usage.input_tokens),
      cachedInputTokens: finiteInt(usage.cached_input_tokens),
      outputTokens: finiteInt(usage.output_tokens),
      costUsd: null,
      numTurns: null,
      cliDurationMs: null,
      raw: usage,
    };
  }
  let model: string | null = null;
  let sawInit = false;
  let result: Record<string, any> | null = null;
  for (const event of events) {
    if (event.type === 'system' && event.subtype === 'init') {
      sawInit = true;
      const name = modelName(event.model);
      if (name) model = name;
    }
    if (event.type === 'result') result = event;
  }
  if (!result && !sawInit) return null;
  const modelUsage = result?.modelUsage && typeof result.modelUsage === 'object' && !Array.isArray(result.modelUsage) ? result.modelUsage as Record<string, unknown> : null;
  if (!model && modelUsage) {
    const keys = Object.keys(modelUsage);
    if (keys.length === 1) model = modelName(keys[0]);
  }
  let inputTokens: number | null = null;
  let cachedInputTokens: number | null = null;
  let outputTokens: number | null = null;
  if (modelUsage) {
    for (const value of Object.values(modelUsage)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      inputTokens = addInt(inputTokens, addInt(addInt(finiteInt(row.inputTokens), finiteInt(row.cacheReadInputTokens)), finiteInt(row.cacheCreationInputTokens)));
      cachedInputTokens = addInt(cachedInputTokens, finiteInt(row.cacheReadInputTokens));
      outputTokens = addInt(outputTokens, finiteInt(row.outputTokens));
    }
  } else if (result?.usage && typeof result.usage === 'object' && !Array.isArray(result.usage)) {
    const usage = result.usage as Record<string, unknown>;
    inputTokens = addInt(addInt(finiteInt(usage.input_tokens), finiteInt(usage.cache_read_input_tokens)), finiteInt(usage.cache_creation_input_tokens));
    cachedInputTokens = finiteInt(usage.cache_read_input_tokens);
    outputTokens = finiteInt(usage.output_tokens);
  }
  return {
    model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: result ? finiteCost(result.total_cost_usd) : null,
    numTurns: result ? finiteInt(result.num_turns) : null,
    cliDurationMs: result ? finiteInt(result.duration_ms) : null,
    raw: result ? { usage: result.usage ?? null, modelUsage: result.modelUsage ?? null } : null,
  };
}
export type ParsedStream = { sessionId?: string; running: boolean; result?: RunResult; error?: string; permissionDenials: unknown[]; events: Array<{ type: string; payload: unknown; eventId: string }>; usage: CliUsage | null };
export function parseStream(provider: Provider, text: string): ParsedStream {
  const parsed: ParsedStream = { running: false, permissionDenials: [], events: [], usage: null };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let event: any;
    try { event = JSON.parse(lines[i]); } catch { continue; } // Last line can be incomplete while running.
    if (!event || typeof event !== 'object') continue;
    parsed.events.push({ type: String(event.type ?? 'output'), payload: event, eventId: `stdout:${i}` });
    if (provider === 'codex') {
      if (event.type === 'thread.started') parsed.sessionId = event.thread_id;
      if (event.type === 'turn.started') parsed.running = true;
      if (event.type === 'turn.failed' || event.type === 'error') parsed.error = typeof event.error?.message === 'string' ? event.error.message : typeof event.message === 'string' ? event.message : 'Codex 执行失败';
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        try { parsed.result = resultSchema.parse(JSON.parse(event.item.text)); } catch { /* Only a validated final result is accepted. */ }
      }
    } else {
      if (typeof event.session_id === 'string') parsed.sessionId = event.session_id;
      if (event.type === 'assistant' || event.type === 'stream_event') parsed.running = true;
      if (event.type === 'system' && event.subtype === 'permission_denied') parsed.permissionDenials.push(event);
      if (event.type === 'result') {
        parsed.permissionDenials.push(...(Array.isArray(event.permission_denials) ? event.permission_denials : []));
        if (event.is_error || (event.subtype && event.subtype !== 'success')) parsed.error = (event.errors ?? [event.result ?? event.subtype]).join('; ');
        try { parsed.result = resultSchema.parse(event.structured_output ?? JSON.parse(event.result)); } catch { /* Missing schema output is a protocol failure. */ }
      }
    }
  }
  parsed.usage = parseUsage(provider, text);
  return parsed;
}
export async function readRunnerOutput(controlDir: string, provider: Provider) {
  const stdout = await readFile(resolve(controlDir, 'stdout.jsonl'), 'utf8').catch(() => '');
  const parsed = parseStream(provider, stdout);
  if (provider === 'codex') {
    try { parsed.result = resultSchema.parse(JSON.parse(await readFile(resolve(controlDir, 'final.json'), 'utf8'))); } catch { /* The process may not have produced its final output yet. */ }
  }
  return parsed;
}
