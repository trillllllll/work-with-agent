import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, open, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { buildArgs, codexWindowsSandboxArgs, parseStream } from './adapters.js';
import { applyPatch, capturePatch, digest, git, inside, normalizeInputFiles, prepareWorkspace } from './workspaces.js';
import { launchSupervisor, readReceipt, requestCancel } from './supervisor.js';
import { resultSchema, type LaunchSpec } from './contracts.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { providerEnvironment } from './environment.js';

let root: string;
const priorRoot = process.env.WWA_RUNNER_DIR;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'wwa-runner-test-')); process.env.WWA_RUNNER_DIR = root; });
afterAll(async () => { process.env.WWA_RUNNER_DIR = priorRoot; if (!priorRoot) delete process.env.WWA_RUNNER_DIR; if (inside(tmpdir(), root) && root !== tmpdir()) await rm(root, { recursive: true, force: true }); });

describe('CLI boundary contracts', () => {
  it('uses explicit sessions, structured output and noninteractive restricted permissions', () => {
    const codex = buildArgs('codex', { profile: 'workspace_write', allowShell: false }, '/tmp/run', 'session-123');
    expect(codex).toContain('default_permissions=":workspace"'); expect(codex).toContain('--ignore-user-config'); expect(codex).toContain('session-123'); expect(codex).not.toContain('--last'); expect(codex).toContain('shell_tool'); expect(codex).toContain('unified_exec'); expect(codex).toContain('hooks'); expect(codex).toContain('plugins');
    const shellAllowed = buildArgs('codex', { profile: 'workspace_write', allowShell: true }, '/tmp/run'); expect(shellAllowed).not.toContain('shell_tool'); expect(shellAllowed).toContain('hooks');
    const claude = buildArgs('claude', { profile: 'read_only', allowShell: false }, '/tmp/run', 'session-123');
    expect(claude).toContain('--permission-prompts'); expect(claude).toContain('none'); expect(claude).toContain('--resume'); expect(claude).toContain('--safe-mode'); expect(claude).not.toContain('--bare'); expect(claude.join(' ')).not.toContain('Bash');
    const isolated = providerEnvironment({ CODEX_HOME: 'auth-directory', CODEX_APP_TOOLS_PIPE_PATH: 'parent-pipe', CODEX_PERMISSION_PROFILE: ':danger-full-access', CODEX_SESSION_ID: 'parent', CLAUDECODE: '1', PATH: 'tools' });
    expect(isolated).toEqual({ CODEX_HOME: 'auth-directory', PATH: 'tools' });
    expect(codexWindowsSandboxArgs('win32', 'unelevated')).toEqual(['-c', 'windows.sandbox="unelevated"']);
    expect(codexWindowsSandboxArgs('win32', 'elevated')).toEqual(['-c', 'windows.sandbox="elevated"']);
    expect(codexWindowsSandboxArgs('linux', 'unelevated')).toEqual([]);
    expect(() => codexWindowsSandboxArgs('win32', 'disabled')).toThrow();
  });
  it('does not confuse session initialization, permission denials and model completion', () => {
    const result = { outcome: 'ready_for_review', summary: '完成', questions: [], artifacts: [], checks: [] };
    const parsed = parseStream('claude', [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }), JSON.stringify({ type: 'system', subtype: 'permission_denied' }), JSON.stringify({ type: 'result', subtype: 'success', structured_output: result })].join('\n'));
    expect(parsed.running).toBe(false); expect(parsed.sessionId).toBe('s'); expect(parsed.permissionDenials).toHaveLength(1); expect(parsed.result).toMatchObject(result); expect(parsed.error).toBeUndefined();
    expect(parseStream('codex', '{"type":"thread.started","thread_id":"c"}\n{"type":"turn.started"}\n{"broken').running).toBe(true);
    expect(() => resultSchema.parse({ ...result, outcome: 'needs_input' })).toThrow();
  });
});
describe('managed execution workspace', () => {
  it('pins HEAD, excludes dirty changes and captures committed, staged, unstaged and untracked changes', async () => {
    const source = resolve(root, 'repository'); await mkdir(source);
    await git(source, ['init']); await git(source, ['config', 'core.autocrlf', 'false']); await git(source, ['config', 'user.email', 'test@example.invalid']); await git(source, ['config', 'user.name', 'Runner test']);
    await writeFile(resolve(source, 'original.txt'), 'base\n'); await git(source, ['add', '.']); await git(source, ['commit', '-m', 'base']);
    await writeFile(resolve(source, 'original.txt'), 'user dirty\n');
    await expect(prepareWorkspace(source, root, 'git-input-forbidden', ['original.txt'])).rejects.toMatchObject({ code: 'INPUT_FILES_NOT_ALLOWED' });
    const workspace = await prepareWorkspace(source, root, 'workspace-run');
    expect(workspace.excludedDirty).toBe(true); expect(await readFile(resolve(workspace.workPath, 'original.txt'), 'utf8')).toBe('base\n');
    await writeFile(resolve(workspace.workPath, 'original.txt'), 'agent update\n'); await writeFile(resolve(workspace.workPath, 'new.txt'), 'new file\n');
    const controlDir = resolve(root, 'capture'); await mkdir(controlDir);
    const captured = (await capturePatch(workspace, controlDir))!;
    expect(captured.patch).toContain('new file'); expect(captured.patch).toContain('agent update');
    const patchPath = resolve(controlDir, 'changes.patch'); await writeFile(patchPath, captured.patch);
    await expect(applyPatch(workspace, patchPath, workspace.baseHead!)).rejects.toMatchObject({ code: 'WORKSPACE_DIRTY' });
    await writeFile(resolve(source, 'original.txt'), 'base\n');
    await applyPatch(workspace, patchPath, workspace.baseHead!);
    expect(await readFile(resolve(source, 'new.txt'), 'utf8')).toBe('new file\n');
    await expect(applyPatch(workspace, patchPath, workspace.baseHead!)).rejects.toMatchObject({ code: 'WORKSPACE_DIRTY' });
  });
  it('copies only selected regular inputs with relative paths and immutable byte hashes', async () => {
    const source = resolve(root, 'selected-source'); await mkdir(resolve(source, 'notes'), { recursive: true });
    const content = '明确选择的资料\n';
    await writeFile(resolve(source, 'notes', 'selected.txt'), content); await writeFile(resolve(source, 'private.txt'), 'not selected');
    const workspace = await prepareWorkspace(source, root, 'selected-copy', ['./notes\\selected.txt', 'notes/selected.txt']);
    expect(workspace.kind).toBe('directory'); expect(await readdir(workspace.workPath)).toEqual(['notes']);
    expect(workspace.inputs).toEqual([{ path: 'notes/selected.txt', hash: digest(content), size: Buffer.byteLength(content) }]);
    expect(await readFile(resolve(workspace.workPath, 'notes', 'selected.txt'), 'utf8')).toBe(content);
    await writeFile(resolve(source, 'notes', 'selected.txt'), 'later source update');
    expect(await readFile(resolve(workspace.workPath, 'notes', 'selected.txt'), 'utf8')).toBe(content);
    const empty = await prepareWorkspace(source, root, 'empty-copy'); expect(empty.inputs).toEqual([]); expect(await readdir(empty.workPath)).toEqual([]);
    expect(normalizeInputFiles(['z.txt', './notes//selected.txt', 'z.txt'])).toEqual(['notes/selected.txt', 'z.txt']);
  });
  it('rejects escaping paths, symlink components, missing/nonregular inputs and oversized selections before copying', async () => {
    const source = resolve(root, 'unsafe-source'); const outside = resolve(root, 'outside-input'); await mkdir(source); await mkdir(outside);
    await writeFile(resolve(outside, 'private.txt'), 'outside'); await mkdir(resolve(source, 'directory'));
    for (const path of ['../outside-input/private.txt', '/absolute.txt', 'C:\\absolute.txt', 'notes/../../outside.txt', 'input.txt:stream']) expect(() => normalizeInputFiles([path])).toThrow();
    expect(() => normalizeInputFiles(Array.from({ length: 101 }, (_, index) => `${index}.txt`))).toThrow();
    await expect(prepareWorkspace(source, root, 'missing-input', ['missing.txt'])).rejects.toMatchObject({ code: 'INPUT_FILE_NOT_FOUND' });
    await expect(prepareWorkspace(source, root, 'directory-input', ['directory'])).rejects.toMatchObject({ code: 'INPUT_NOT_REGULAR_FILE' });
    await symlink(outside, resolve(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareWorkspace(source, root, 'linked-input', ['linked/private.txt'])).rejects.toMatchObject({ code: 'INPUT_SYMLINK' });
    const oversized = await open(resolve(source, 'too-large.bin'), 'w'); await oversized.truncate(32 * 1024 * 1024 + 1); await oversized.close();
    await expect(prepareWorkspace(source, root, 'oversized-input', ['too-large.bin'])).rejects.toMatchObject({ code: 'INPUT_FILES_LIMIT' });
    for (const id of ['missing-input', 'directory-input', 'linked-input', 'oversized-input']) await expect(readdir(resolve(root, 'workspaces', id))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
describe('persistent supervisor', () => {
  async function waitFor(id: string, predicate: (receipt: Awaited<ReturnType<typeof readReceipt>>) => boolean) {
    for (let i = 0; i < 300; i++) { const receipt = await readReceipt(id); if (predicate(receipt)) return receipt!; await new Promise((done) => setTimeout(done, 100)); }
    const diagnostic = await readFile(resolve(root, 'runs', id, 'supervisor.log'), 'utf8').catch(() => 'no supervisor log');
    throw new Error(`No expected receipt for ${id}: ${JSON.stringify(await readReceipt(id))}; ${diagnostic}`);
  }
  async function launch(id: string, code: string) {
    const controlDir = resolve(root, 'runs', id); await mkdir(controlDir, { recursive: true });
    const spec: LaunchSpec = { runId: id, provider: 'codex', command: process.execPath, args: ['-e', code], cwd: root, prompt: '', controlDir, finalOutputPath: resolve(controlDir, 'final.json') };
    await launchSupervisor(spec); return spec;
  }
  it('persists final output and never relaunches the same run', async () => {
    const spec = await launch('success', 'process.stdout.write(JSON.stringify({type:"turn.started"})+"\\n")');
    const receipt = await waitFor('success', (value) => value?.state === 'ended');
    expect(receipt.exitCode).toBe(0); expect(receipt.supervisorPid).not.toBe(process.pid);
    expect(await readFile(resolve(spec.controlDir, 'stdout.jsonl'), 'utf8')).toContain('turn.started');
    await expect(launchSupervisor(spec)).rejects.toMatchObject({ code: 'RUN_ALREADY_LAUNCHED' });
  }, 40000);
  it('cancels an owned process and preserves the cancellation receipt', async () => {
    await launch('cancel', 'const {spawn}=require("child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});process.stdout.write(JSON.stringify({childPid:child.pid})+"\\n");setInterval(()=>{},1000)');
    await waitFor('cancel', (value) => value?.state === 'running');
    await requestCancel('cancel');
    const receipt = await waitFor('cancel', (value) => value?.state === 'ended');
    expect(receipt.cancelled).toBe(true);
    const descendant = JSON.parse((await readFile(resolve(root, 'runs', 'cancel', 'stdout.jsonl'), 'utf8')).trim()).childPid;
    expect(() => process.kill(descendant, 0)).toThrow();
  }, 40000);
  it('survives the launcher process exiting and can be observed and cancelled by a new caller', async () => {
    const id = 'launcher-exit'; const controlDir = resolve(root, 'runs', id); await mkdir(controlDir, { recursive: true });
    const spec: LaunchSpec = { runId: id, provider: 'codex', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: root, prompt: '', controlDir, finalOutputPath: resolve(controlDir, 'final.json') };
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const module = new URL('./supervisor.ts', import.meta.url).href;
    await promisify(execFile)(process.execPath, ['--import', loader, '--input-type=module', '-e', `import {launchSupervisor} from ${JSON.stringify(module)};await launchSupervisor(${JSON.stringify(spec)});`], { windowsHide: true });
    expect((await waitFor(id, (value) => value?.state === 'running')).state).toBe('running');
    await requestCancel(id); expect((await waitFor(id, (value) => value?.state === 'ended')).cancelled).toBe(true);
  }, 40000);
});
