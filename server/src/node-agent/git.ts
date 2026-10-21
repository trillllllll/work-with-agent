/** Mechanical, deterministic git steps run by the local executor. No judgment, no edits to code. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rmdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { emptyDiff, type DiffStat, type FetchSpec, type GitFacts, type InventoryResult, type PreparePayload, type WorktreeEntry } from './protocol.js';

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
  throw new NodeError('PATH_NOT_ALLOWED', `路径不在这台电脑允许的目录内：${path}`);
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
  if (!inside(root, path)) throw new NodeError('WORKTREE_NOT_MANAGED', '只能复用这台电脑创建的 worktree');
  const actual = await realpath(path).catch(() => { throw new NodeError('WORKTREE_MISSING', `worktree 已不存在：${path}`); });
  if (!inside(await realpath(root), actual)) throw new NodeError('WORKTREE_NOT_MANAGED', '只能复用这台电脑创建的 worktree');
  return actual;
}
async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

/** Idempotent: an existing worktree on the same branch is a replay; a pre-existing branch is only reused if it still points at startPoint. */
export async function prepareWorktree(repo: string, dataDir: string, input: Omit<PreparePayload, 'repoPath'> & { fetch?: FetchSpec }) {
  const path = worktreePath(dataDir, input.worktreeName);
  if (input.fetch && !await exists(path)) await fetchRef(repo, input.fetch);
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
const DIFF_FILE_CAP = 200;
/** `git diff --numstat -z`: `added\tdeleted\tpath\0`, renames as `added\tdeleted\t\0old\0new\0`. Binary rows are `-\t-`. */
function parseNumstatZ(text: string): Array<{ path: string; added: number; deleted: number; binary: boolean }> {
  if (!text) return [];
  const parts = text.split('\0');
  const files: Array<{ path: string; added: number; deleted: number; binary: boolean }> = [];
  for (let i = 0; i < parts.length; i++) {
    const header = parts[i];
    if (!header) continue;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(header);
    if (!match) continue;
    const binary = match[1] === '-' || match[2] === '-';
    const added = binary ? 0 : Number(match[1]);
    const deleted = binary ? 0 : Number(match[2]);
    if (!binary && (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted))) continue;
    let path = match[3];
    if (path === '') {
      const oldPath = parts[++i] ?? '';
      path = parts[++i] || oldPath;
    }
    if (!path) continue;
    files.push({ path: path.slice(0, 4096), added, deleted, binary });
  }
  return files;
}
function parseShortstat(text: string): { files: number; added: number; deleted: number } | null {
  const line = text.split('\n').map((item) => item.trim()).filter(Boolean).at(-1) ?? '';
  const files = /(\d+) files? changed/.exec(line);
  if (!files) return null;
  const added = /(\d+) insertions?\(\+\)/.exec(line);
  const deleted = /(\d+) deletions?\(-\)/.exec(line);
  return { files: Number(files[1]), added: added ? Number(added[1]) : 0, deleted: deleted ? Number(deleted[1]) : 0 };
}
function diffFrom(numstat: string, shortstat: string): DiffStat {
  const parsed = parseNumstatZ(numstat);
  const totals = parseShortstat(shortstat);
  const summed = parsed.reduce((acc, file) => ({ files: acc.files + 1, added: acc.added + file.added, deleted: acc.deleted + file.deleted }), { files: 0, added: 0, deleted: 0 });
  return { files: parsed.slice(0, DIFF_FILE_CAP), filesChanged: totals?.files ?? summed.files, linesAdded: totals?.added ?? summed.added, linesDeleted: totals?.deleted ?? summed.deleted, truncated: parsed.length > DIFF_FILE_CAP };
}
async function diffStat(worktree: string, base: string | null, head: string | null): Promise<DiffStat> {
  if (!base || !head || base === head) return emptyDiff();
  try {
    const numstat = await git(worktree, ['-c', 'diff.renames=true', 'diff', '--numstat', '-z', base, head]);
    const shortstat = await git(worktree, ['-c', 'diff.renames=true', 'diff', '--shortstat', base, head], { env: { LC_ALL: 'C', LANG: 'C' } });
    return diffFrom(numstat, shortstat);
  } catch { return emptyDiff(); }
}
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
  const diff = await diffStat(worktree, base, head);
  return { worktree, branch, head, base, commits, status, mergeInProgress, unmerged, includes, conflictMarkers: conflictMarkers.slice(0, 500), hooksChanged, diff };
}

export async function pushBranch(worktree: string, branch: string, remote: string) {
  const current = await git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
  if (current !== branch) throw new NodeError('BRANCH_MISMATCH', `worktree 当前分支是 ${current || '（分离 HEAD）'}，不是 ${branch}`);
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new NodeError('INVALID_REMOTE', '远端名不合法');
  // Never force; the user's own credentials, no prompts.
  const result = await exec('git', ['-C', worktree, 'push', '-u', remote, `refs/heads/${branch}:refs/heads/${branch}`], { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { output: `${result.stdout}\n${result.stderr}`.trim().slice(-20_000), head: await git(worktree, ['rev-parse', 'HEAD']) };
}

/**
 * Cross-machine transfer: fetch `refs/heads/<ref>` from the shared remote into `refs/remotes/<remote>/<ref>` (never forced)
 * and verify the fetched commit is exactly the one the server expects. Returns the local ref name.
 */
export async function fetchRef(repo: string, spec: FetchSpec) {
  if (!/^[A-Za-z0-9._-]+$/.test(spec.remote)) throw new NodeError('INVALID_REMOTE', '远端名不合法');
  if (!await gitOk(repo, ['check-ref-format', '--branch', spec.ref])) throw new NodeError('INVALID_BRANCH', `分支名不合法：${spec.ref}`);
  const local = `refs/remotes/${spec.remote}/${spec.ref}`;
  const have = await git(repo, ['rev-parse', '--verify', '--quiet', `${spec.expect}^{commit}`]).catch(() => '');
  if (!have) {
    try { await git(repo, ['fetch', '--no-tags', spec.remote, `refs/heads/${spec.ref}:${local}`], { timeoutMs: 120_000 }); }
    catch (error) { throw new NodeError('FETCH_FAILED', `无法从 ${spec.remote} 获取 ${spec.ref}：${(error as Error).message.slice(-2000)}`); }
  } else {
    // The commit is already here (same machine or an earlier fetch); still refresh the tracking ref when possible.
    await git(repo, ['fetch', '--no-tags', spec.remote, `refs/heads/${spec.ref}:${local}`], { timeoutMs: 120_000 }).catch(() => undefined);
  }
  const fetched = await git(repo, ['rev-parse', '--verify', '--quiet', `${spec.expect}^{commit}`]).catch(() => '');
  if (!fetched || !fetched.startsWith(spec.expect.slice(0, 7))) throw new NodeError('FETCH_MISMATCH', `${spec.remote}/${spec.ref} 上没有期望的提交 ${spec.expect}`);
  const tip = await git(repo, ['rev-parse', '--verify', '--quiet', local]).catch(() => '');
  if (tip && tip !== fetched && !await gitOk(repo, ['merge-base', '--is-ancestor', fetched, tip])) throw new NodeError('FETCH_MISMATCH', `${local} 不包含期望的提交 ${spec.expect}`);
  return { ref: local, head: fetched };
}

async function dirSize(root: string, budget = { files: 200_000 }): Promise<{ bytes: number; truncated: boolean }> {
  let bytes = 0; let truncated = false;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (--budget.files < 0) return { bytes, truncated: true };
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) bytes += (await lstat(full).catch(() => null))?.size ?? 0;
    }
  }
  return { bytes, truncated };
}

/** Read-only listing of the worktrees this node created (`<data>/worktrees/<group>/<name>`) and its runner records. */
export async function inventory(dataDir: string, freeBytes: number | null = null): Promise<InventoryResult> {
  const root = resolve(dataDir, 'worktrees');
  const worktrees: WorktreeEntry[] = [];
  for (const group of (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory())) {
    for (const item of (await readdir(join(root, group.name), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory())) {
      const path = join(root, group.name, item.name);
      const isWorktree = await exists(join(path, '.git'));
      const branch = isWorktree ? (await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')) || null : null;
      const head = isWorktree ? (await git(path, ['rev-parse', 'HEAD']).catch(() => '')) || null : null;
      const dirtyCount = isWorktree ? (await git(path, ['status', '--porcelain']).catch(() => '')).split('\n').filter(Boolean).length : 0;
      const size = await dirSize(path);
      const modifiedAt = (await stat(path).catch(() => null))?.mtime.toISOString() ?? null;
      worktrees.push({ path, name: `${group.name}/${item.name}`, branch, head, dirtyCount, sizeBytes: size.bytes, sizeTruncated: size.truncated, modifiedAt, broken: !isWorktree || !head });
    }
  }
  const runsRoot = resolve(dataDir, 'runner', 'runs');
  const runIds = await readdir(runsRoot).catch(() => [] as string[]);
  const runsSize = await dirSize(runsRoot);
  return { worktrees: worktrees.slice(0, 2000), runs: { count: runIds.length, sizeBytes: runsSize.bytes }, freeBytes, scannedAt: new Date().toISOString() };
}

/**
 * Remove worktrees this node created. Only clean ones (no uncommitted or untracked files) are removed, with
 * `git worktree remove` without --force; branches are only deleted with `git branch -d` (refuses unmerged work).
 */
export async function cleanupWorktrees(dataDir: string, paths: string[], deleteBranches: boolean) {
  const removed: Array<{ path: string; branch: string | null; branchDeleted: boolean; branchNote: string | null }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const root = resolve(dataDir, 'worktrees');
  for (const path of [...new Set(paths)]) {
    try {
      const actual = await assertManagedWorktree(dataDir, path);
      const rel = relative(await realpath(root), actual).split(sep);
      if (rel.length !== 2) throw new NodeError('WORKTREE_NOT_MANAGED', '只能删除这台电脑创建的 worktree 目录');
      if (!await exists(join(actual, '.git'))) {
        // A leftover directory without git metadata: only remove it when empty.
        await rmdir(actual).catch(() => { throw new NodeError('BROKEN_NOT_EMPTY', '目录不是 worktree 且不为空，请手动检查'); });
        removed.push({ path, branch: null, branchDeleted: false, branchNote: '空目录' });
        continue;
      }
      const status = (await git(actual, ['status', '--porcelain', '--untracked-files=normal'])).split('\n').filter(Boolean);
      if (status.length) throw new NodeError('DIRTY', `有 ${status.length} 个未提交或未跟踪的文件，不删除`);
      if (await gitOk(actual, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) throw new NodeError('MERGE_IN_PROGRESS', '有进行中的合并，不删除');
      const branch = (await git(actual, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')) || null;
      const { commonDir } = await gitDirs(actual);
      await git(commonDir, ['--git-dir', commonDir, 'worktree', 'remove', actual]);
      await rmdir(dirname(actual)).catch(() => undefined);
      let branchDeleted = false; let branchNote: string | null = null;
      if (deleteBranches && branch) {
        try { await git(commonDir, ['--git-dir', commonDir, 'branch', '-d', branch]); branchDeleted = true; }
        catch (error) { branchNote = `分支保留：${(error as Error).message.split('\n').filter(Boolean).slice(-1)[0] ?? '未合入'}`.slice(0, 2000); }
      }
      removed.push({ path, branch, branchDeleted, branchNote });
    } catch (error) {
      skipped.push({ path, reason: `${error instanceof NodeError ? `${error.code}: ` : ''}${(error as Error).message}`.slice(0, 2000) });
    }
  }
  return { removed, skipped };
}

/** Optional PR creation with the user's local GitHub CLI login. Idempotent: an existing PR for the branch is returned. */
export async function createPullRequest(worktree: string, input: { branch: string; base: string; title: string; body: string }) {
  const current = await git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
  if (current !== input.branch) throw new NodeError('BRANCH_MISMATCH', `worktree 当前分支是 ${current || '（分离 HEAD）'}，不是 ${input.branch}`);
  const gh = process.env.WWA_GH_BIN || 'gh';
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
  const options = { cwd: worktree, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env };
  const existing = await exec(gh, ['pr', 'view', input.branch, '--json', 'url,state', '--jq', 'select(.state == "OPEN") | .url'], options).then((result) => result.stdout.trim(), () => '');
  if (existing) return { url: existing, existing: true, output: '' };
  let result: { stdout: string; stderr: string };
  try { result = await exec(gh, ['pr', 'create', '--head', input.branch, '--base', input.base, '--title', input.title, '--body', input.body || ' '], options); }
  catch (error) { throw new NodeError('PR_FAILED', `gh pr create 失败：${String((error as { stderr?: string }).stderr ?? (error as Error).message).slice(-4000)}`); }
  const url = `${result.stdout}`.split('\n').map((line) => line.trim()).filter((line) => /^https?:\/\//.test(line)).pop();
  if (!url) throw new NodeError('PR_FAILED', `gh 没有返回 PR 地址：${`${result.stdout}\n${result.stderr}`.slice(-2000)}`);
  return { url, existing: false, output: `${result.stdout}\n${result.stderr}`.trim().slice(-20_000) };
}

export async function ghAvailable() {
  try { await exec(process.env.WWA_GH_BIN || 'gh', ['--version'], { windowsHide: true, timeout: 10_000 }); return true; } catch { return false; }
}
