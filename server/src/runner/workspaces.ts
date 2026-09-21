import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile, rm, lstat, readdir, copyFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { DomainError } from '../domain/task.js';
import type { Workspace } from './contracts.js';

const exec = promisify(execFile);
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function inside(root: string, path: string) { const rel = relative(resolve(root), resolve(path)); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }
export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) { const result = await exec('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env }); return result.stdout.trimEnd(); }
const inputBytesLimit = 32 * 1024 * 1024;
export function normalizeInputFiles(files: string[] = []): string[] {
  if (files.length > 100) throw new DomainError('INPUT_FILES_LIMIT', '输入最多选择 100 个文件', 400);
  const paths = new Map<string, string>();
  for (const value of files) {
    const slash = value.replace(/\\/g, '/');
    const segments = slash.split('/');
    if (!value || value.length > 4096 || slash.startsWith('/') || segments.some((part) => part === '..') || /[<>:"|?*\u0000-\u001f]/.test(slash)) throw new DomainError('INVALID_INPUT_PATH', '输入必须是源目录内的相对文件路径，不能包含绝对路径或 ..', 400);
    const parts = segments.filter((part) => part !== '' && part !== '.');
    if (!parts.length || parts.some((part) => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new DomainError('INVALID_INPUT_PATH', '输入文件名不受支持', 400);
    const path = parts.join('/');
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (paths.has(key) && paths.get(key) !== path) throw new DomainError('INVALID_INPUT_PATH', '输入路径不能仅大小写不同', 400);
    paths.set(key, path);
  }
  return [...paths.values()].sort();
}
async function readSelectedInputs(sourcePath: string, files: string[]) {
  const inputs: Array<{ path: string; hash: string; size: number; content: Buffer }> = [];
  let total = 0;
  for (const path of files) {
    let candidate = sourcePath;
    let before: Awaited<ReturnType<typeof lstat>> | undefined;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      candidate = resolve(candidate, parts[index]);
      if (!inside(sourcePath, candidate)) throw new DomainError('INVALID_INPUT_PATH', '输入路径越界', 400);
      before = await lstat(candidate).catch((error) => { if (error.code === 'ENOENT') throw new DomainError('INPUT_FILE_NOT_FOUND', `所选输入不存在：${path}`, 400); throw error; });
      if (before.isSymbolicLink()) throw new DomainError('INPUT_SYMLINK', `输入不能经过符号链接：${path}`, 400);
      if (index < parts.length - 1 ? !before.isDirectory() : !before.isFile()) throw new DomainError('INPUT_NOT_REGULAR_FILE', `只可选择普通文件：${path}`, 400);
    }
    const canonical = await realpath(candidate);
    if (!inside(sourcePath, canonical)) throw new DomainError('INVALID_INPUT_PATH', '输入实际路径越界', 400);
    const file = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== before!.dev || opened.ino !== before!.ino || !inside(sourcePath, await realpath(candidate))) throw new DomainError('INPUT_FILE_CHANGED', `输入在复制前发生变化：${path}`);
      if (opened.size > inputBytesLimit - total) throw new DomainError('INPUT_FILES_LIMIT', '输入文件合计不能超过 32 MiB', 400);
      // A bounded buffer prevents a concurrently growing file from bypassing the byte limit.
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.length) { const read = await file.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      const after = await file.stat();
      if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new DomainError('INPUT_FILE_CHANGED', `输入在复制时发生变化：${path}`);
      const content = buffer.subarray(0, length); total += length;
      inputs.push({ path, size: length, hash: digest(content), content });
    } finally { await file.close(); }
  }
  return inputs;
}
export async function prepareWorkspace(source: string, root: string, runId: string, inputFiles: string[] = []): Promise<Workspace> {
  const selected = normalizeInputFiles(inputFiles);
  const sourcePath = await realpath(resolve(source));
  if (!(await stat(sourcePath)).isDirectory()) throw new DomainError('INVALID_WORKSPACE', '执行目录必须是本机文件夹', 400);
  const workPath = resolve(root, 'workspaces', runId);
  await mkdir(resolve(root, 'workspaces'), { recursive: true });
  let repo: string | undefined;
  try { repo = await git(sourcePath, ['rev-parse', '--show-toplevel']); } catch { /* Plain directories copy only explicitly selected inputs. */ }
  if (!repo) {
    const inputs = await readSelectedInputs(sourcePath, selected);
    await mkdir(workPath);
    for (const input of inputs) { const target = resolve(workPath, input.path); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, input.content, { flag: 'wx' }); }
    return { kind: 'directory', sourcePath, workPath, excludedDirty: false, inputs: inputs.map(({ content: _content, ...input }) => input) };
  }
  if (selected.length) throw new DomainError('INPUT_FILES_NOT_ALLOWED', 'Git 执行从 HEAD 创建副本，不能选择输入文件或带入未提交内容', 400);
  const canonicalRepo = await realpath(repo);
  const baseHead = await git(canonicalRepo, ['rev-parse', 'HEAD']);
  const sourceBranch = await git(canonicalRepo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
  const excludedDirty = Boolean(await git(canonicalRepo, ['status', '--porcelain']));
  const branch = `codex/agent-run-${runId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 50)}`;
  await git(canonicalRepo, ['worktree', 'add', '-b', branch, workPath, baseHead]);
  return { kind: 'git', sourcePath: canonicalRepo, workPath, baseHead, sourceBranch, branch, excludedDirty, inputs: [] };
}
export async function capturePatch(workspace: Workspace, controlDir: string) {
  if (workspace.kind !== 'git' || !workspace.baseHead) return null;
  const index = resolve(controlDir, 'capture.index');
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(workspace.workPath, ['read-tree', workspace.baseHead], env);
    await git(workspace.workPath, ['add', '-A', '--', '.'], env);
    const patch = await git(workspace.workPath, ['diff', '--cached', '--binary', '--full-index', workspace.baseHead, '--'], env);
    const paths = await git(workspace.workPath, ['diff', '--cached', '--name-status', workspace.baseHead, '--'], env);
    return { patch: patch ? `${patch}\n` : '', paths, baseHead: workspace.baseHead, hash: digest(patch ? `${patch}\n` : '') };
  } finally { await rm(index, { force: true }); }
}
export async function assertApplyTarget(workspace: Workspace, expectedHead: string) {
  if (workspace.kind !== 'git' || expectedHead !== workspace.baseHead) throw new DomainError('INVALID_APPLY_TARGET', '补丁的基准提交不一致');
  if (await realpath(workspace.sourcePath) !== workspace.sourcePath) throw new DomainError('INVALID_APPLY_TARGET', '原仓库路径发生变化');
  const head = await git(workspace.sourcePath, ['rev-parse', 'HEAD']);
  const branch = await git(workspace.sourcePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
  if (head !== expectedHead || branch !== workspace.sourceBranch) throw new DomainError('WORKSPACE_CHANGED', '原仓库分支或 HEAD 已变化；请导出补丁手动合并');
  if (await git(workspace.sourcePath, ['status', '--porcelain', '--untracked-files=all'])) throw new DomainError('WORKSPACE_DIRTY', '原仓库存在未提交内容；请保留副本或导出补丁');
}
export async function applyPatch(workspace: Workspace, patchPath: string, expectedHead: string) {
  await assertApplyTarget(workspace, expectedHead);
  await git(workspace.sourcePath, ['apply', '--check', '--', patchPath]);
  await assertApplyTarget(workspace, expectedHead);
  await git(workspace.sourcePath, ['apply', '--', patchPath]);
}
/** Copy only regular output files, never follow model-created symlinks outside the workspace. */
export async function captureOutputFiles(workspace: Workspace, controlDir: string) {
  const files: Array<{ name: string; path: string; hash: string; size: number }> = [];
  let total = 0;
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { await walk(path); continue; }
      if (!info.isFile()) continue;
      total += info.size;
      if (files.length >= 200 || total > 32 * 1024 * 1024) throw new DomainError('ARTIFACT_LIMIT', '产物超过 200 个文件或 32 MiB，请从执行副本检查完整内容');
      const name = relative(workspace.workPath, path);
      const target = resolve(controlDir, 'artifacts', name);
      if (!inside(resolve(controlDir, 'artifacts'), target)) throw new DomainError('INVALID_ARTIFACT', '产物路径越界');
      await mkdir(resolve(target, '..'), { recursive: true });
      await copyFile(path, target);
      files.push({ name, path: target, hash: digest(await readFile(target)), size: info.size });
    }
  }
  await walk(workspace.workPath);
  return files;
}
