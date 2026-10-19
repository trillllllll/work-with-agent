import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseModelJson, planSchema, sequentialPlan, validatePlan } from './application/orchestration/planner.js';
import { checkDevelop, checkMerge, checkVerify, looksGitWriteDenied, looksRateLimited } from './application/orchestration/checks.js';
import { slug } from './application/orchestration/service.js';
import { withGitWrite } from './node-agent/cli.js';
import { buildArgs } from './runner/adapters.js';
import { cleanupWorktrees, collectFacts, fetchRef, inventory, prepareWorktree, probe, worktreePath } from './node-agent/git.js';

const subtasks = [{ id: 'a', title: 'A', description: '', sortOrder: 0 }, { id: 'b', title: 'B', description: '', sortOrder: 1 }, { id: 'c', title: 'C', description: '', sortOrder: 2 }];
const step = (taskId: string, dependsOn: string[] = []) => ({ taskId, dependsOn, acceptanceCriteria: '', rationale: '' });
const facts = (extra: Record<string, unknown> = {}) => ({ worktree: '/w', branch: 'orch/x-r1-a-a1', head: 'bbbbbbb', base: 'aaaaaaa', commits: [{ sha: 'bbbbbbb', subject: 'x' }], status: [], mergeInProgress: false, unmerged: [], includes: { ccccccc: true, ddddddd: true }, conflictMarkers: [], hooksChanged: false, ...extra });
const result = (extra: Record<string, unknown> = {}) => ({ outcome: 'ready_for_review' as const, summary: 's', questions: [], artifacts: [], checks: [{ name: 't', passed: true, detail: '' }], unfinished: [], proposedCommands: [], ...extra });

describe('plan validation', () => {
  it('accepts a DAG and orders dependencies first', () => {
    expect(validatePlan({ goalCriteria: 'g', steps: [step('c', ['a']), step('b'), step('a')] }, subtasks)).toEqual(['a', 'b', 'c']);
  });
  it('rejects missing, unknown, duplicate and cyclic plans', () => {
    expect(() => validatePlan({ goalCriteria: 'g', steps: [step('a'), step('b')] }, subtasks)).toThrow('漏掉');
    expect(() => validatePlan({ goalCriteria: 'g', steps: [step('a'), step('b'), step('x')] }, subtasks)).toThrow('不存在');
    expect(() => validatePlan({ goalCriteria: 'g', steps: [step('a'), step('a'), step('b')] }, subtasks)).toThrow('多次');
    expect(() => validatePlan({ goalCriteria: 'g', steps: [step('a', ['c']), step('b'), step('c', ['a'])] }, subtasks)).toThrow('环');
  });
  it('falls back to a strictly sequential plan', () => {
    const plan = sequentialPlan(subtasks, 'why');
    expect(plan.steps.map((item) => item.dependsOn)).toEqual([[], ['a'], ['b']]);
    expect(plan.fallback).toBe('why');
  });
  it('parses fenced model JSON', () => {
    expect(parseModelJson('```json\n{"goalCriteria":"g","steps":[{"taskId":"a"}]}\n```', planSchema).steps[0].dependsOn).toEqual([]);
  });
  it('makes ascii branch slugs with an id fallback', () => {
    expect(slug('Add Login Page!', 'x')).toBe('add-login-page');
    expect(slug('登录页', 'abcd1234')).toBe('abcd1234');
  });
});

describe('report comparisons', () => {
  it('develop requires a structured ready result, a new commit on the right branch and a clean tree', () => {
    expect(checkDevelop({ result: result(), facts: facts(), base: 'aaaaaaa', branch: 'orch/x-r1-a-a1' }).ok).toBe(true);
    expect(checkDevelop({ result: result(), facts: facts({ head: 'aaaaaaa' }), base: 'aaaaaaa', branch: 'orch/x-r1-a-a1' }).problems.join()).toContain('没有新的提交');
    expect(checkDevelop({ result: result(), facts: facts({ status: [' M a'] }), base: 'aaaaaaa', branch: 'orch/x-r1-a-a1' }).ok).toBe(false);
    expect(checkDevelop({ result: result(), facts: facts({ hooksChanged: true }), base: 'aaaaaaa', branch: 'orch/x-r1-a-a1' }).ok).toBe(false);
    expect(checkDevelop({ result: result({ outcome: 'partial' }), facts: facts(), base: 'aaaaaaa', branch: 'orch/x-r1-a-a1' }).ok).toBe(false);
    expect(checkDevelop({ result: result({ checks: [{ name: 'unit', passed: false, detail: '' }] }), facts: facts(), base: 'aaaaaaa', branch: 'orch/x-r1-a-a1' }).problems.join()).toContain('unit');
    expect(checkDevelop({ result: null, facts: null, base: 'aaaaaaa', branch: 'b' }).ok).toBe(false);
  });
  it('merge requires the subtask commit and the previous head as ancestors, no merge in progress and no markers', () => {
    const base = { result: result(), integrationBranch: 'orch/x-r1', preHead: 'ddddddd', resultCommit: 'ccccccc' };
    expect(checkMerge({ ...base, facts: facts({ branch: 'orch/x-r1' }) }).ok).toBe(true);
    expect(checkMerge({ ...base, facts: facts({ branch: 'orch/x-r1', includes: { ccccccc: false, ddddddd: true } }) }).problems.join()).toContain('不在集成分支');
    expect(checkMerge({ ...base, facts: facts({ branch: 'orch/x-r1', includes: { ccccccc: true, ddddddd: false } }) }).problems.join()).toContain('改写');
    expect(checkMerge({ ...base, facts: facts({ branch: 'orch/x-r1', mergeInProgress: true }) }).ok).toBe(false);
    expect(checkMerge({ ...base, facts: facts({ branch: 'orch/x-r1', conflictMarkers: ['a.ts'] }) }).ok).toBe(false);
    expect(checkMerge({ ...base, facts: facts({ branch: 'main' }) }).ok).toBe(false);
  });
  it('verify must see the same HEAD as the merge report', () => {
    const report = (head: string) => result({ artifacts: [{ name: 'wwa-report.json', kind: 'text', content: JSON.stringify({ head }) }] });
    expect(checkVerify({ result: report('bbbbbbb'), facts: facts(), expectedHead: 'bbbbbbb', resultCommit: 'ccccccc' }).ok).toBe(true);
    expect(checkVerify({ result: report('bbbbbbb'), facts: facts({ head: 'eeeeeee' }), expectedHead: 'bbbbbbb', resultCommit: 'ccccccc' }).problems.join()).toContain('HEAD 不一致');
    expect(checkVerify({ result: report('fffffff'), facts: facts(), expectedHead: 'bbbbbbb', resultCommit: 'ccccccc' }).ok).toBe(false);
  });
  it('recognizes rate limits and git write denials', () => {
    expect(looksRateLimited('Error: 429 Too Many Requests')).toBe(true);
    expect(looksRateLimited('syntax error')).toBe(false);
    expect(looksGitWriteDenied("fatal: Unable to create '/r/.git/worktrees/x/index.lock': Read-only file system")).toBe(true);
  });
});

describe('codex git write grant', () => {
  it('replaces :workspace with a profile that explicitly writes both gitdirs', () => {
    const args = withGitWrite('codex', buildArgs('codex', { profile: 'workspace_write', allowShell: true }, '/ctl'), { gitDir: '/repo/.git/worktrees/x', commonDir: '/repo/.git' });
    expect(args).not.toContain('default_permissions=":workspace"');
    expect(args).toContain('default_permissions="wwa_git"');
    expect(args).toContain('permissions.wwa_git.extends=":workspace"');
    const filesystem = args.find((arg) => arg.startsWith('permissions.wwa_git.filesystem='))!;
    expect(filesystem).toContain('"/repo/.git" = "write"');
    expect(filesystem).toContain('"/repo/.git/worktrees/x" = "write"');
    expect(args).not.toContain('shell_tool');
  });
  it('leaves claude arguments alone', () => {
    const args = buildArgs('claude', { profile: 'workspace_write', allowShell: true }, '/ctl');
    expect(withGitWrite('claude', args, { gitDir: '/a', commonDir: '/b' })).toEqual(args);
  });
});

describe('node git steps', () => {
  it('probes inside allowed roots, prepares worktrees idempotently and collects facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wwa-node-git-'));
    try {
      const repo = join(root, 'code', 'repo'); await mkdir(repo, { recursive: true });
      const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, encoding: 'utf8' }).trim();
      run(repo, 'init', '-b', 'main'); await writeFile(join(repo, 'demo.md'), '<<<<<<< sample in docs\n'); run(repo, 'add', '-A'); run(repo, 'commit', '-m', 'init');
      await expect(probe(repo, [join(root, 'elsewhere')])).rejects.toThrow('不在本机执行端允许');
      await expect(probe(join(repo, '..'), [root])).rejects.toThrow();
      expect((await probe(repo, [join(root, 'code')])).branches).toEqual(['main']);
      expect(() => worktreePath(root, '../escape')).toThrow();
      const data = join(root, 'data');
      const first = await prepareWorktree(repo, data, { branch: 'orch/t-r1', startPoint: 'main', worktreeName: 'o1/integration' });
      const again = await prepareWorktree(repo, data, { branch: 'orch/t-r1', startPoint: 'main', worktreeName: 'o1/integration' });
      expect(again.replay).toBe(true); expect(again.worktree).toBe(first.worktree);
      const sub = await prepareWorktree(repo, data, { branch: 'orch/t-r1-a', startPoint: first.head, worktreeName: 'o1/a' });
      await writeFile(join(sub.worktree, 'a.txt'), 'ok\n'); run(sub.worktree, 'add', '-A'); run(sub.worktree, 'commit', '-m', 'a');
      const subHead = run(sub.worktree, 'rev-parse', 'HEAD');
      // Conflict: both sides edit the same file.
      await writeFile(join(first.worktree, 'a.txt'), 'other\n'); run(first.worktree, 'add', '-A'); run(first.worktree, 'commit', '-m', 'other');
      const pre = run(first.worktree, 'rev-parse', 'HEAD');
      try { run(first.worktree, 'merge', '--no-ff', 'orch/t-r1-a'); } catch { /* conflict expected */ }
      const conflicted = await collectFacts(first.worktree, { includes: [subHead], preHead: pre });
      expect(conflicted.mergeInProgress).toBe(true);
      expect(conflicted.unmerged).toEqual(['a.txt']);
      await writeFile(join(first.worktree, 'a.txt'), '<<<<<<< HEAD\nother\n=======\nok\n>>>>>>> x\n'); run(first.worktree, 'add', '-A'); run(first.worktree, 'commit', '--no-edit');
      const committed = await collectFacts(first.worktree, { includes: [subHead], preHead: pre });
      expect(committed.mergeInProgress).toBe(false);
      expect(committed.includes[subHead]).toBe(true);
      expect(committed.conflictMarkers).toEqual(['a.txt']); // demo.md's pre-existing text is not reported
      expect(committed.status).toEqual([]);
      await expect(prepareWorktree(repo, data, { branch: 'orch/t-r1-a', startPoint: 'main', worktreeName: 'o1/b' })).rejects.toThrow('已存在');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('node transfer and cleanup steps', () => {
  it('fetches only the exact expected commit from the shared remote', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wwa-fetch-'));
    const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, encoding: 'utf8' }).trim();
    try {
      const remote = join(root, 'o.git'); const a = join(root, 'a');
      g(root, 'init', '-q', '--bare', '-b', 'main', remote);
      await mkdir(a); g(a, 'init', '-q', '-b', 'main'); await writeFile(join(a, 'f'), '1'); g(a, 'add', '-A'); g(a, 'commit', '-qm', '1'); g(a, 'remote', 'add', 'origin', remote);
      g(a, 'checkout', '-qb', 'feature'); await writeFile(join(a, 'f'), '2'); g(a, 'commit', '-qam', '2'); g(a, 'push', '-q', 'origin', 'main', 'feature');
      const tip = g(a, 'rev-parse', 'HEAD');
      g(root, 'clone', '-q', remote, 'b'); const b = join(root, 'b');
      expect(await fetchRef(b, { remote: 'origin', ref: 'feature', expect: tip })).toEqual({ ref: 'refs/remotes/origin/feature', head: tip });
      await expect(fetchRef(b, { remote: 'origin', ref: 'feature', expect: 'deadbeefdeadbeef' })).rejects.toMatchObject({ code: 'FETCH_MISMATCH' });
      await expect(fetchRef(b, { remote: 'origin', ref: 'missing', expect: 'deadbeefdeadbeef' })).rejects.toMatchObject({ code: 'FETCH_FAILED' });
      await expect(fetchRef(b, { remote: 'bad remote', ref: 'feature', expect: tip })).rejects.toMatchObject({ code: 'INVALID_REMOTE' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('lists managed worktrees and removes only clean ones inside the node data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wwa-clean-'));
    const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, encoding: 'utf8' }).trim();
    try {
      const repo = join(root, 'repo'); const data = join(root, 'data');
      await mkdir(repo); g(repo, 'init', '-q', '-b', 'main'); await writeFile(join(repo, 'f'), '1'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', '1');
      const clean = await prepareWorktree(repo, data, { branch: 'w/clean', startPoint: 'main', worktreeName: 'o1/clean' });
      const dirty = await prepareWorktree(repo, data, { branch: 'w/dirty', startPoint: 'main', worktreeName: 'o1/dirty' });
      await writeFile(join(dirty.worktree, 'scratch.txt'), 'x');
      const listed = await inventory(data);
      expect(listed.worktrees.map((item) => [item.name, item.branch, item.dirtyCount])).toEqual(expect.arrayContaining([['o1/clean', 'w/clean', 0], ['o1/dirty', 'w/dirty', 1]]));
      const outcome = await cleanupWorktrees(data, [clean.worktree, dirty.worktree, repo, join(data, 'worktrees', 'o1')], true);
      expect(outcome.removed).toEqual([{ path: clean.worktree, branch: 'w/clean', branchDeleted: true, branchNote: null }]);
      expect(outcome.skipped.map((item) => item.reason.split(':')[0])).toEqual(['DIRTY', 'WORKTREE_NOT_MANAGED', 'WORKTREE_NOT_MANAGED']);
      expect(g(repo, 'worktree', 'list')).not.toContain('o1/clean');
      expect(g(repo, 'branch', '--list', 'w/clean')).toBe('');
      expect(g(repo, 'branch', '--list', 'w/dirty')).toContain('w/dirty');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
