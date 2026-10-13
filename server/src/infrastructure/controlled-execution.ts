import { resolve, relative, sep, dirname, basename, isAbsolute } from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type ExecutionKind = 'shell' | 'http' | 'file';
export type FileGrants = { files: string[]; directories: string[] };
export type ExecutionRequest = { kind: ExecutionKind; input: Record<string, unknown>; approvalId: string; timeoutMs?: number; maxOutputBytes?: number; workingDirectory?: string; fileGrants?: FileGrants };
export type ExecutionResult = { success: boolean; data?: unknown; error?: string; errorCode?: string; stdout?: string; stderr?: string; durationMs: number; reversible: boolean; redacted: boolean };
export interface ExecutionAdapter { execute(request: ExecutionRequest): Promise<ExecutionResult>; probe?(request: ExecutionRequest): Promise<ExecutionResult>; }
export type DnsResolver = (hostname: string) => Promise<Array<{ address: string }>>;

export class RecordOnlyExecutionAdapter implements ExecutionAdapter {
  async execute(request: ExecutionRequest): Promise<ExecutionResult> { return { success: true, data: { recorded: true, kind: request.kind, input: redact(request.input) }, durationMs: 0, reversible: false, redacted: true }; }
}

const MAX_TIMEOUT = 30_000;
const MAX_OUTPUT = 256 * 1024;
const workspaceRoot = resolve(process.env.AGENT_WORKSPACE_ROOT || process.cwd());
const sensitiveName = /authorization|api[-_]?key|cookie|token|secret|password/i;

function redactString(value: string) {
  let result = value.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]').replace(/((?:api[-_]?key|token|secret|password)=)[^&\s]+/gi, '$1[REDACTED]');
  try { const url = new URL(result); for (const key of [...url.searchParams.keys()]) if (sensitiveName.test(key)) url.searchParams.set(key, '[REDACTED]'); result = url.toString(); } catch { /* Most strings are not URLs. */ }
  return result;
}

export const redact = (value: unknown): unknown => {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item, index) => index > 0 && typeof value[index - 1] === 'string' && sensitiveName.test(value[index - 1]) ? '[REDACTED]' : redact(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => sensitiveName.test(key) ? [key, '[REDACTED]'] : [key, redact(item)]));
};

function boundedNumber(value: unknown, fallback: number, max: number) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), max) : fallback; }
type PathScope = { lexical: string; canonical: string };
type LocatedPath = { lexical: string; canonical: string; display: string };
const fileOperations = new Set(['read', 'list', 'write', 'mkdir', 'delete']);
function pathInside(root: string, target: string) { const rel = relative(root, target); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); }
function pathError(message: string, code: string): never { throw Object.assign(new Error(message), { code }); }
function requirePath(value: unknown) { if (typeof value !== 'string' || !value.trim()) pathError('文件路径不能为空', 'FILE_INVALID_PATH'); return value; }
async function scopeOf(path: string): Promise<PathScope> { const lexical = resolve(path); try { return { lexical, canonical: await fs.realpath(lexical) }; } catch (error: any) { if (error?.code !== 'ENOENT') throw error; return { lexical, canonical: lexical }; } }
async function canonicalOf(lexical: string, allowMissingLeaf: boolean) {
  let existing = lexical; const missingSegments: string[] = [];
  while (true) {
    try { return resolve(await fs.realpath(existing), ...missingSegments); }
    catch (error: any) { if (error?.code !== 'ENOENT' || !allowMissingLeaf) throw error; const parent = dirname(existing); if (parent === existing) throw error; missingSegments.unshift(basename(existing)); existing = parent; }
  }
}
async function workspacePath(value: unknown, allowMissingLeaf: boolean) {
  const lexical = resolve(workspaceRoot, requirePath(value)); const workspace = await scopeOf(workspaceRoot);
  if (!pathInside(workspace.lexical, lexical) && !pathInside(workspace.canonical, lexical)) pathError('文件路径超出工作区', 'FILE_PATH_DENIED');
  const canonical = await canonicalOf(lexical, allowMissingLeaf);
  if (!pathInside(workspace.canonical, canonical)) pathError('文件路径超出工作区', 'FILE_PATH_DENIED');
  return canonical;
}
async function grantedDirectory(lexical: string, canonical: string, grants?: FileGrants) {
  for (const dir of grants?.directories ?? []) {
    const scope = await scopeOf(dir);
    if ((lexical === scope.lexical || lexical === scope.canonical) && canonical === scope.canonical && pathInside(scope.canonical, canonical)) return true;
  }
  return false;
}
async function grantedFile(lexical: string, canonical: string, grants?: FileGrants) {
  for (const file of grants?.files ?? []) {
    const scope = await scopeOf(file);
    if (lexical !== scope.lexical && lexical !== scope.canonical) continue;
    if (canonical !== scope.canonical) continue;
    const parent = await scopeOf(dirname(scope.lexical));
    if (pathInside(parent.canonical, canonical)) return true;
  }
  return false;
}
async function grantedDirectChild(lexical: string, canonical: string, grants?: FileGrants) {
  for (const dir of grants?.directories ?? []) {
    const scope = await scopeOf(dir);
    const rel = relative(scope.canonical, canonical);
    if (!rel || rel === '..' || isAbsolute(rel) || rel.includes(sep) || !pathInside(scope.canonical, canonical)) continue;
    const parent = dirname(lexical);
    if (parent === scope.lexical || parent === scope.canonical || dirname(canonical) === scope.canonical) return true;
  }
  return false;
}
async function locate(value: unknown, operation: string, grants?: FileGrants): Promise<LocatedPath> {
  if (!fileOperations.has(operation)) pathError('文件操作不支持', 'FILE_OPERATION_DENIED');
  const raw = requirePath(value);
  const writing = operation === 'write' || operation === 'mkdir';
  const absoluteRequest = isAbsolute(raw);
  const lexical = absoluteRequest ? resolve(raw) : resolve(workspaceRoot, raw);
  const workspace = await scopeOf(workspaceRoot);
  const lexicalInside = pathInside(workspace.lexical, lexical) || pathInside(workspace.canonical, lexical);
  if (!absoluteRequest || lexicalInside) {
    if (!lexicalInside) pathError('文件路径超出工作区', 'FILE_PATH_DENIED');
    const canonical = await canonicalOf(lexical, writing);
    if (!pathInside(workspace.canonical, canonical)) pathError('文件路径超出工作区', 'FILE_PATH_DENIED');
    return { lexical, canonical, display: relative(workspace.canonical, canonical) || '.' };
  }
  if (operation !== 'read' && operation !== 'list') pathError('文件路径超出工作区', 'FILE_PATH_DENIED');
  const canonical = await canonicalOf(lexical, false);
  if (operation === 'list') {
    if (!(await grantedDirectory(lexical, canonical, grants))) pathError('文件路径超出工作区', 'FILE_PATH_DENIED');
    return { lexical, canonical, display: canonical };
  }
  if (!(await grantedFile(lexical, canonical, grants) || await grantedDirectChild(lexical, canonical, grants))) pathError('文件路径超出工作区', 'FILE_PATH_DENIED');
  return { lexical, canonical, display: canonical };
}
async function listDirectory(target: string, maxOutputBytes: number) {
  const dirents = await fs.readdir(target, { withFileTypes: true });
  const entries: Array<{ name: string; kind: 'file' | 'dir' | 'other' }> = [];
  for (const entry of dirents) {
    if (entries.length >= 200) break;
    const kind = entry.isSymbolicLink() ? 'other' : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';
    entries.push({ name: entry.name, kind });
  }
  let shown = entries;
  let truncated = dirents.length > shown.length;
  while (shown.length && Buffer.byteLength(JSON.stringify(shown)) > maxOutputBytes) { shown = shown.slice(0, -1); truncated = true; }
  if (!shown.length && entries.length) pathError('文件超过大小限制', 'FILE_SIZE_LIMIT');
  return { entries: shown, truncated };
}

function ipv4Number(address: string) { return address.split('.').reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0); }
function inIpv4Range(address: string, base: string, prefix: number) { const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0; return (ipv4Number(address) & mask) === (ipv4Number(base) & mask); }
const restrictedIpv4Ranges: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
function ipv6Groups(address: string) { let normalized = address; const ipv4Tail = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1]; if (ipv4Tail) { const value = ipv4Number(ipv4Tail); normalized = `${normalized.slice(0, -ipv4Tail.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`; } const [left = '', right = ''] = normalized.split('::'); const leftGroups = left ? left.split(':') : []; const rightGroups = right ? right.split(':') : []; const zeros = normalized.includes('::') ? 8 - leftGroups.length - rightGroups.length : 0; return [...leftGroups, ...Array(Math.max(0, zeros)).fill('0'), ...rightGroups].map((part) => Number.parseInt(part || '0', 16)); }
function inIpv6Range(groups: number[], base: number[], prefix: number) { const fullGroups = Math.floor(prefix / 16); const remainder = prefix % 16; for (let index = 0; index < fullGroups; index += 1) if (groups[index] !== base[index]) return false; if (!remainder) return true; const mask = (0xffff << (16 - remainder)) & 0xffff; return (groups[fullGroups] & mask) === (base[fullGroups] & mask); }
const restrictedIpv6Ranges: Array<[string, number]> = [['::', 96], ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]];
function restrictedAddress(address: string) { const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]; if (isIP(normalized) === 4) return restrictedIpv4Ranges.some(([base, prefix]) => inIpv4Range(normalized, base, prefix)); if (isIP(normalized) === 6) { const groups = ipv6Groups(normalized); if (groups.length !== 8 || groups.some(Number.isNaN)) return true; if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) { const mapped = `${groups[6] >>> 8}.${groups[6] & 0xff}.${groups[7] >>> 8}.${groups[7] & 0xff}`; return restrictedAddress(mapped); } return restrictedIpv6Ranges.some(([base, prefix]) => inIpv6Range(groups, ipv6Groups(base), prefix)); } return false; }
const defaultResolver: DnsResolver = async (hostname) => lookup(hostname, { all: true });
async function assertSafeTarget(url: string, resolver: DnsResolver = defaultResolver) { let parsed: URL; try { parsed = new URL(url); } catch { throw Object.assign(new Error('HTTP 地址无效'), { code: 'HTTP_INVALID_URL' }); } if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('仅支持 HTTP(S)'), { code: 'HTTP_PROTOCOL_DENIED' }); const host = parsed.hostname.toLowerCase(); if (host === 'localhost' || host === 'metadata.google.internal' || host.endsWith('.local') || restrictedAddress(host)) throw Object.assign(new Error('目标地址被禁止'), { code: 'HTTP_TARGET_DENIED' }); let addresses: Array<{ address: string }>; try { addresses = await resolver(host); } catch { throw Object.assign(new Error('目标地址 DNS 解析失败'), { code: 'HTTP_DNS_FAILED' }); } if (!addresses.length) throw Object.assign(new Error('目标地址 DNS 解析为空'), { code: 'HTTP_DNS_FAILED' }); if (addresses.some((item) => restrictedAddress(item.address))) throw Object.assign(new Error('目标地址解析到受限网络'), { code: 'HTTP_TARGET_DENIED' }); }

export class ControlledExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly resolver: DnsResolver = defaultResolver) {}
  async execute(request: ExecutionRequest): Promise<ExecutionResult> { const started = Date.now(); const timeoutMs = boundedNumber(request.timeoutMs, 10_000, MAX_TIMEOUT); const maxOutputBytes = boundedNumber(request.maxOutputBytes, MAX_OUTPUT, MAX_OUTPUT); try { const data = request.kind === 'shell' ? await this.shell(request.input, timeoutMs, maxOutputBytes) : request.kind === 'file' ? await this.file(request.input, maxOutputBytes, request.fileGrants) : await this.http(request.input, timeoutMs, maxOutputBytes); return { success: true, data: redact(data), durationMs: Date.now() - started, reversible: false, redacted: true }; } catch (error) { const e = error as any; return { success: false, error: e?.message ?? '执行失败', errorCode: e?.code ?? 'EXECUTION_FAILED', durationMs: Date.now() - started, reversible: false, redacted: true }; } }
  async probe(request: ExecutionRequest): Promise<ExecutionResult> {
    const started = Date.now();
    try {
      if (request.kind !== 'file') pathError('文件操作不支持', 'FILE_OPERATION_DENIED');
      const operation = String(request.input.operation || 'read');
      const located = await locate(request.input.path, operation, request.fileGrants);
      if (operation === 'list' || operation === 'read') {
        const info = await fs.stat(located.canonical);
        if (operation === 'list' && !info.isDirectory()) pathError('目录才能列出', 'FILE_OPERATION_DENIED');
        if (operation === 'read' && !info.isFile()) pathError('文件才能读取', 'FILE_OPERATION_DENIED');
      }
      return { success: true, data: { operation, path: located.display, allowed: true }, durationMs: Date.now() - started, reversible: false, redacted: true };
    } catch (error) { const e = error as any; return { success: false, error: e?.message ?? '执行失败', errorCode: e?.code ?? 'EXECUTION_FAILED', durationMs: Date.now() - started, reversible: false, redacted: true }; }
  }
  private async shell(input: Record<string, unknown>, timeoutMs: number, maxOutputBytes: number) { const command = String(input.command || ''); const args = Array.isArray(input.args) ? input.args.map(String) : []; const allowed = (process.env.AGENT_ALLOWED_COMMANDS || 'node,npm,git').split(',').map((item) => item.trim()).filter(Boolean); if (!allowed.includes(command)) throw Object.assign(new Error('命令不在白名单中'), { code: 'SHELL_COMMAND_DENIED' }); const cwd = await workspacePath(input.workingDirectory || '.', false); const child = spawn(command, args, { cwd, shell: false, windowsHide: true, env: { PATH: process.env.PATH, NODE_ENV: 'production' } }); const stdout: Buffer[] = []; const stderr: Buffer[] = []; let outputBytes = 0; let outputExceeded = false; let timedOut = false; const append = (target: Buffer[], chunk: Buffer) => { const remaining = maxOutputBytes - outputBytes; if (remaining > 0) { const accepted = chunk.subarray(0, remaining); target.push(accepted); outputBytes += accepted.byteLength; } if (chunk.byteLength > remaining) { outputExceeded = true; child.kill(); } }; child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk)); child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk)); const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs); const exitCode = await new Promise<number>((resolveExit, reject) => { child.on('error', reject); child.on('close', (code) => resolveExit(code ?? 1)); }).finally(() => clearTimeout(timer)); const output = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }; if (timedOut) throw Object.assign(new Error('命令执行超时'), { code: 'SHELL_TIMEOUT', ...output }); if (outputExceeded) throw Object.assign(new Error('命令输出超过大小限制'), { code: 'SHELL_OUTPUT_LIMIT', ...output }); if (exitCode !== 0) throw Object.assign(new Error(`命令退出码 ${exitCode}`), { code: 'SHELL_EXITED', ...output }); return { command, args, exitCode, ...output }; }
  private async file(input: Record<string, unknown>, maxOutputBytes: number, grants?: FileGrants) {
    const operation = String(input.operation || 'read');
    const located = await locate(input.path, operation, grants);
    const target = located.canonical;
    if (operation === 'list') {
      if (!(await fs.stat(target)).isDirectory()) pathError('目录才能列出', 'FILE_OPERATION_DENIED');
      return { operation, path: located.display, ...(await listDirectory(target, maxOutputBytes)) };
    }
    if (operation === 'read') { const info = await fs.stat(target); if (!info.isFile()) pathError('文件才能读取', 'FILE_OPERATION_DENIED'); if (info.size > maxOutputBytes) pathError('文件超过大小限制', 'FILE_SIZE_LIMIT'); return { operation, path: located.display, content: await fs.readFile(target, 'utf8') }; }
    if (operation === 'write') { const content = String(input.content ?? ''); if (Buffer.byteLength(content) > maxOutputBytes) pathError('文件超过大小限制', 'FILE_SIZE_LIMIT'); await fs.mkdir(dirname(target), { recursive: true }); await fs.writeFile(target, content, 'utf8'); return { operation, path: located.display, bytes: Buffer.byteLength(content) }; }
    if (operation === 'mkdir') { await fs.mkdir(target, { recursive: true }); return { operation, path: located.display }; }
    if (operation === 'delete') { await fs.rm(target, { recursive: Boolean(input.recursive), force: false }); return { operation, path: located.display }; }
    pathError('文件操作不支持', 'FILE_OPERATION_DENIED');
  }
  private async http(input: Record<string, unknown>, timeoutMs: number, maxOutputBytes: number) { const url = String(input.url || ''); await assertSafeTarget(url, this.resolver); const controller = new AbortController(); let timedOut = false; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); try { const headers = Object.fromEntries(Object.entries((input.headers as Record<string, unknown>) || {}).filter(([key]) => !/^(host|content-length)$/i.test(key)).map(([key, value]) => [key, String(value)])); const response = await fetch(url, { method: String(input.method || 'GET').toUpperCase(), headers, body: input.body == null ? undefined : JSON.stringify(input.body), signal: controller.signal, redirect: 'error' }); const chunks: Buffer[] = []; let bytes = 0; if (response.body) { const reader = response.body.getReader(); while (true) { const { value, done } = await reader.read(); if (done) break; const chunk = Buffer.from(value); bytes += chunk.byteLength; if (bytes > maxOutputBytes) { await reader.cancel(); throw Object.assign(new Error('响应超过大小限制'), { code: 'HTTP_RESPONSE_LIMIT' }); } chunks.push(chunk); } } return { url: new URL(url).origin, status: response.status, body: Buffer.concat(chunks).toString('utf8') }; } catch (error: any) { if (timedOut || error?.name === 'AbortError') throw Object.assign(new Error('HTTP 请求超时'), { code: 'HTTP_TIMEOUT' }); throw error; } finally { clearTimeout(timer); } }
}
