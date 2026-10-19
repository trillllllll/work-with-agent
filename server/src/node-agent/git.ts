/** Mechanical, deterministic git steps run by the local executor. No judgment, no edits to code. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GitFacts, PreparePayload } from './protocol.js';

const exec = promisify(execFile);
export class NodeError extends Error { constructor(public code: string, message: string) { super(message); } }

/** Read-only git for fact collection: never takes optional locks and never runs hooks. */
export async function git(cwd: string, args: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const result = await exec('git', ['-C', cwd, '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: options.timeoutMs ?? 60_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...options.env } });
  return result.stdout.replace(/\s+$/, '');
}
async function gitOk(cwd: string, args: string[]) { try { await git(cwd, args); return true; } catch { return false; } }
export function inside(root: string, path: string) { const rel = relative(resolve(root), resolve(path)); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }

/** The path must resolve inside one of the roots configured on THIS machine; the server cannot widen them. */
export async function assertAllowed(path: string, roots: string[]) {
  if (!isAbsolute(path)) throw new NodeError('PATH_NOT_ABSOLUTE', `路径必须是绝对路径：${path}`);
  let actual: string;
  try { actual = await realpath(path); } catch { throw new NodeError('PATH_NOT_FOUND', `路径不存在：${path}`); }
  for (const root of roots) {
    const canonical = await realpath(root).catch(() => null);
    if (canonical && inside(canonical, actual)) return actual;
  }
  throw new NodeError('PATH_NOT_ALLOWED', `路径不在本机执行端允许的目录内：${path}`);
}

export async function probe(path: string, roots: string[]) {
  const actual = await assertAllowed(path, roots);
  let toplevel: string;
  try { toplevel = await realpath(await git(actual, ['rev-parse', '--show-toplevel'])); } catch { throw new NodeError('NOT_A_REPO', '该路径不是 git 仓库'); }
  if (toplevel !== actual) throw new NodeError('NOT_REPO_ROOT', `请填写仓库顶层目录：${toplevel}`);
  const rootCommit = (await git(toplevel, ['rev-list', '--max-parents=0', 'HEAD']).catch(() => '')).split('\n')[0] || null;
  const originUrl = (await git(toplevel, ['remote', 'get-url', 'origin']).catch(() => '')) || null;
  const branches = (await git(toplevel, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).catch(() => '')).split('\n').filter(Boolean).slice(0, 500);
  const head = (await git(toplevel, ['rev-parse', 'HEAD']).catch(() => '')) || null;
  const dirtyCount = (await git(toplevel, ['status', '--porcelain']).catch(() => '')).split('\n').filter(Boolean).length;
  return { toplevel, rootCommit, originUrl, branches, head, dirtyCount };
}

const segment = /^[A-Za-z0-9._-]{1,100}$/;
export function worktreePath(dataDir: string, name: string) {
  const parts = name.split('/');
  if (!parts.length || parts.some((part) => !segment.test(part) || part === '.' || part === '..')) throw new NodeError('INVALID_WORKTREE_NAME', `worktree 名称不合法：${name}`);
  return resolve(dataDir, 'worktrees', ...parts);
}
/** Worktrees reused by later jobs must be ones this node created. */
export async function assertManagedWorktree(dataDir: string, path: string) {
  const root = resolve(dataDir, 'worktrees');
  if (!inside(root, path)) throw new NodeError('WORKTREE_NOT_MANAGED', '只能复用本执行端创建的 worktree');
  const actual = await realpath(path).catch(() => { throw new NodeError('WORKTREE_MISSING', `worktree 已不存在：${path}`); });
  if (!inside(await realpath(root), actual)) throw new NodeError('WORKTREE_NOT_MANAGED', '只能复用本执行端创建的 worktree');
  return actual;
}
async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

/** Idempotent: an existing worktree on the same branch is a replay; a pre-existing branch is only reused if it still points at startPoint. */
export async function prepareWorktree(repo: string, dataDir: string, input: Omit<PreparePayload, 'repoPath'>) {
  const path = worktreePath(dataDir, input.worktreeName);
  if (await exists(path)) {
    const branch = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
    if (branch !== input.branch) throw new NodeError('WORKTREE_CONFLICT', `目录已存在但分支是 ${branch || '（分离 HEAD）'}`);
    return { worktree: path, branch, head: await git(path, ['rev-parse', 'HEAD']), replay: true, dirtyCount: (await git(repo, ['status', '--porcelain'])).split('\n').filter(Boolean).length };
  }
  if (!await gitOk(repo, ['check-ref-format', '--branch', input.branch])) throw new NodeError('INVALID_BRANCH', `分支名不合法：${input.branch}`);
  const start = await git(repo, ['rev-parse', '--verify', `${input.startPoint}^{commit}`]).catch(() => { throw new NodeError('START_NOT_FOUND', `找不到起点：${input.startPoint}`); });
  await mkdir(resolve(path, '..'), { recursive: true });
  const branchExists = await gitOk(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}`]);
  if (branchExists) {
    const current = await git(repo, ['rev-parse', `refs/heads/${input.branch}`]);
    if (current !== start) throw new NodeError('BRANCH_EXISTS', `分支 ${input.branch} 已存在且不在起点上，不会覆盖`);
    await git(repo, ['worktree', 'add', path, input.branch]);
  } else await git(repo, ['worktree', 'add', '-b', input.branch, path, start]);
  const dirtyCount = (await git(repo, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
  return { worktree: path, branch: input.branch, head: await git(path, ['rev-parse', 'HEAD']), replay: false, dirtyCount };
}

export async function gitDirs(worktree: string) {
  const gitDir = await git(worktree, ['rev-parse', '--absolute-git-dir']);
  const commonDir = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return { gitDir, commonDir };
}

/** Hash of hooks and the hooks-related git config; any change during a run is reported. */
export async function hooksFingerprint(worktree: string) {
  const { commonDir, gitDir } = await gitDirs(worktree);
  const hash = createHash('sha256');
  for (const dir of [...new Set([join(commonDir, 'hooks'), join(gitDir, 'hooks')])]) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const entry of entries.sort()) { hash.update(entry); hash.update(await readFile(join(dir, entry)).catch(() => Buffer.alloc(0))); }
  }
  hash.update(await readFile(join(commonDir, 'config')).catch(() => Buffer.alloc(0)));
  return hash.digest('hex');
}

const markers = /^(<{7}|>{7})( |$)/m;
export async function collectFacts(worktree: string, input: { base?: string | null; includes?: string[]; hooksBefore?: string | null; preHead?: string | null }): Promise<GitFacts> {
  const branch = (await git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')) || null;
  const head = (await git(worktree, ['rev-parse', 'HEAD']).catch(() => '')) || null;
  const base = input.base ?? null;
  const commits = head && base && head !== base
    ? (await git(worktree, ['log', '--format=%H%x09%s', '--max-count=500', `${base}..${head}`]).catch(() => '')).split('\n').filter(Boolean).map((line) => { const [sha, ...subject] = line.split('\t'); return { sha, subject: subject.join('\t').slice(0, 1000) }; })
    : [];
  const status = (await git(worktree, ['status', '--porcelain', '--untracked-files=normal']).catch(() => '')).split('\n').filter(Boolean).slice(0, 500);
  const mergeInProgress = await gitOk(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  const unmerged = [...new Set((await git(worktree, ['ls-files', '-u']).catch(() => '')).split('\n').filter(Boolean).map((line) => line.split('\t')[1]))].slice(0, 500);
  const includes: Record<string, boolean> = {};
  for (const sha of [...new Set([...(input.includes ?? []), ...(input.preHead ? [input.preHead] : [])])]) includes[sha] = head ? await gitOk(worktree, ['merge-base', '--is-ancestor', sha, head]) : false;
  // Only files changed since the pre-run HEAD are scanned, so pre-existing sample text is not a false positive.
  const conflictMarkers: string[] = [];
  const changedFrom = input.preHead ?? base;
  if (head && changedFrom && changedFrom !== head) {
    const files = (await git(worktree, ['diff', '--name-only', '--diff-filter=AM', changedFrom, head]).catch(() => '')).split('\n').filter(Boolean).slice(0, 2000);
    for (const file of files) {
      const content = await readFile(join(worktree, file), 'utf8').catch(() => '');
      if (content && !content.includes('\u0000') && markers.test(content)) conflictMarkers.push(file);
    }
  }
  for (const file of unmerged) if (!conflictMarkers.includes(file)) conflictMarkers.push(file);
  const hooksChanged = input.hooksBefore ? (await hooksFingerprint(worktree).catch(() => '')) !== input.hooksBefore : false;
  return { worktree, branch, head, base, commits, status, mergeInProgress, unmerged, includes, conflictMarkers: conflictMarkers.slice(0, 500), hooksChanged };
}

export async function pushBranch(worktree: string, branch: string, remote: string) {
  const current = await git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
  if (current !== branch) throw new NodeError('BRANCH_MISMATCH', `worktree 当前分支是 ${current || '（分离 HEAD）'}，不是 ${branch}`);
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new NodeError('INVALID_REMOTE', '远端名不合法');
  // Never force; the user's own credentials, no prompts.
  const result = await exec('git', ['-C', worktree, 'push', '-u', remote, `refs/heads/${branch}:refs/heads/${branch}`], { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { output: `${result.stdout}\n${result.stderr}`.trim().slice(-20_000), head: await git(worktree, ['rev-parse', 'HEAD']) };
}
