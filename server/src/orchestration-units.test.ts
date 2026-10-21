import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseModelJson, planSchema, sequentialPlan, validatePlan } from './application/orchestration/planner.js';
import { checkDevelop, checkMerge, checkVerify, classifyFailure, failureKindFromStep, looksGitWriteDenied, looksRateLimited, noNewCommitProblem } from './application/orchestration/checks.js';
import { columnsForRunReport } from './application/orchestration/nodes.js';
import { slug } from './application/orchestration/service.js';
import { NodeAgent } from './node-agent/agent.js';
import { withGitWrite } from './node-agent/cli.js';
import { emptyDiff, runResultSchema, type GitFacts } from './node-agent/protocol.js';
import { buildArgs } from './runner/adapters.js';
import { cleanupWorktrees, collectFacts, fetchRef, inventory, prepareWorktree, probe, worktreePath } from './node-agent/git.js';

const subtasks = [{ id: 'a', title: 'A', description: '', sortOrder: 0 }, { id: 'b', title: 'B', description: '', sortOrder: 1 }, { id: 'c', title: 'C', description: '', sortOrder: 2 }];
const step = (taskId: string, dependsOn: string[] = []) => ({ taskId, dependsOn, acceptanceCriteria: '', rationale: '' });
const facts = (extra: Partial<GitFacts> = {}): GitFacts => ({ worktree: '/w', branch: 'orch/x-r1-a-a1', head: 'bbbbbbb', base: 'aaaaaaa', commits: [{ sha: 'bbbbbbb', subject: 'x' }], status: [], mergeInProgress: false, unmerged: [], includes: { ccccccc: true, ddddddd: true }, conflictMarkers: [], hooksChanged: false, diff: emptyDiff(), ...extra });
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

describe('classifyFailure', () => {
  const noCommit = checkDevelop({ result: result(), facts: facts({ head: 'aaaaaaa' }), base: 'aaaaaaa', branch: 'orch/x-r1-a-a1' }).problems.find((problem) => problem.includes(noNewCommitProblem))!;

  it('returns null for user pauses and task revisions even when other signals are present', () => {
    expect(classifyFailure({ pauseReason: 'user_paused', error: '429', exitCode: 1, hasResult: false })).toBeNull();
    expect(classifyFailure({ pauseReason: 'task_revised', problems: [noCommit], checks: [{ passed: false }] })).toBeNull();
  });

  it('prefers rate_limit, then git_denied, then the exact no-commit problem', () => {
    expect(classifyFailure({ pauseReason: 'rate_limited' })).toBe('rate_limit');
    expect(classifyFailure({ error: 'HTTP 429', pauseReason: 'git_write_denied' })).toBe('rate_limit');
    expect(classifyFailure({ stderr: 'usage limit reached' })).toBe('rate_limit');
    expect(classifyFailure({ pauseReason: 'git_write_denied', problems: [noCommit] })).toBe('git_denied');
    expect(classifyFailure({ error: "fatal: Unable to create 'index.lock': Read-only file system" })).toBe('git_denied');
    expect(classifyFailure({ problems: [`前缀；${noCommit}`], checks: [{ passed: false }], facts: { unmerged: ['a.ts'] } })).toBe('no_commit');
    expect(noCommit).toBe(noNewCommitProblem);
  });

  it('prefers merge conflicts over failed checks, then review reasons, then a missing CLI result', () => {
    expect(classifyFailure({ pauseReason: 'merge_conflict_unresolved', checks: [{ passed: false }] })).toBe('merge_conflict');
    expect(classifyFailure({ facts: { unmerged: ['a.ts'] }, checks: [{ passed: false }] })).toBe('merge_conflict');
    expect(classifyFailure({ facts: { conflictMarkers: ['b.ts'] } })).toBe('merge_conflict');
    expect(classifyFailure({ pauseReason: 'merge_tests_failed', decision: 'fail' })).toBe('tests_failed');
    expect(classifyFailure({ checks: [{ passed: true }, { passed: false }] })).toBe('tests_failed');
    expect(classifyFailure({ decision: 'fail', hasResult: false, exitCode: 2 })).toBe('review_failed');
    expect(classifyFailure({ pauseReason: 'final_unsatisfied' })).toBe('review_failed');
    expect(classifyFailure({ pauseReason: 'merge_unverified', hasResult: false })).toBe('review_failed');
    expect(classifyFailure({ pauseReason: 'develop_failed', hasResult: true })).toBe('review_failed');
    expect(classifyFailure({ pauseReason: 'develop_failed', hasResult: false })).toBe('cli_error');
    expect(classifyFailure({ hasResult: false })).toBe('cli_error');
    expect(classifyFailure({ exitCode: 2 })).toBe('cli_error');
    expect(classifyFailure({ exitCode: 0 })).toBe('other');
    expect(classifyFailure({ pauseReason: 'setup_failed' })).toBe('other');
    expect(classifyFailure({ pauseReason: 'transfer_failed' })).toBe('other');
    expect(classifyFailure({ pauseReason: 'invalid_model_output' })).toBe('other');
    expect(classifyFailure({ pauseReason: 'node_offline' })).toBe('other');
    expect(classifyFailure({ pauseReason: 'computer_offline', error: '429', exitCode: 1, hasResult: false })).toBeNull();
    expect(classifyFailure({})).toBe('other');
  });

  it('keeps a stored kind and otherwise classifies the step error the same way', () => {
    expect(failureKindFromStep({ failureKind: 'cli_error', error: '429' }, 'rate_limited')).toBe('cli_error');
    expect(failureKindFromStep({ failureKind: 'not-a-kind', error: `检查未通过：unit；${noNewCommitProblem}` }, 'develop_failed')).toBe('no_commit');
    expect(failureKindFromStep({ failureKind: null, error: null }, 'user_paused')).toBe('other');
    expect(failureKindFromStep({ error: '核对检查未通过：unit' }, 'merge_tests_failed')).toBe(classifyFailure({ pauseReason: 'merge_tests_failed', error: '核对检查未通过：unit', problems: ['核对检查未通过：unit'] }));
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
      await expect(probe(repo, [join(root, 'elsewhere')])).rejects.toThrow('不在这台电脑允许');
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

  it('counts numstat for add, modify, delete, binary and rename, and reports zero when base is missing or equal to head', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wwa-numstat-'));
    const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, encoding: 'utf8' }).trim();
    try {
      const repo = join(root, 'repo');
      await mkdir(repo, { recursive: true });
      run(repo, 'init', '-b', 'main');
      run(repo, 'config', 'diff.renames', 'true');
      await writeFile(join(repo, 'keep.txt'), 'same\n');
      await writeFile(join(repo, 'mod.txt'), 'old\n');
      await writeFile(join(repo, 'del.txt'), 'gone\n');
      await writeFile(join(repo, 'ren.txt'), 'line\n'.repeat(20));
      run(repo, 'add', '-A');
      run(repo, 'commit', '-m', 'init');
      const base = run(repo, 'rev-parse', 'HEAD');
      await writeFile(join(repo, 'mod.txt'), 'old\nnew\n');
      run(repo, 'rm', 'del.txt');
      run(repo, 'mv', 'ren.txt', 'moved.txt');
      await writeFile(join(repo, 'moved.txt'), `${'line\n'.repeat(20)}extra\n`);
      await writeFile(join(repo, 'bin.dat'), Buffer.from([0x78, 0x00, 0x79]));
      await writeFile(join(repo, 'new.txt'), 'fresh\n');
      run(repo, 'add', '-A');
      run(repo, 'commit', '-m', 'edit');
      const changed = await collectFacts(repo, { base });
      expect(changed.diff.truncated).toBe(false);
      expect(changed.diff.filesChanged).toBe(5);
      expect(changed.diff.linesAdded).toBe(3);
      expect(changed.diff.linesDeleted).toBe(1);
      expect(changed.diff.files).toHaveLength(5);
      const byPath = Object.fromEntries(changed.diff.files.map((file) => [file.path, file]));
      expect(Object.keys(byPath).sort()).toEqual(['bin.dat', 'del.txt', 'mod.txt', 'moved.txt', 'new.txt']);
      expect(byPath['mod.txt']).toEqual({ path: 'mod.txt', added: 1, deleted: 0, binary: false });
      expect(byPath['del.txt']).toEqual({ path: 'del.txt', added: 0, deleted: 1, binary: false });
      expect(byPath['moved.txt']).toEqual({ path: 'moved.txt', added: 1, deleted: 0, binary: false });
      expect(byPath['bin.dat']).toEqual({ path: 'bin.dat', added: 0, deleted: 0, binary: true });
      expect(byPath['new.txt']).toEqual({ path: 'new.txt', added: 1, deleted: 0, binary: false });
      const head = run(repo, 'rev-parse', 'HEAD');
      expect((await collectFacts(repo, { base: head })).diff).toEqual(emptyDiff());
      expect((await collectFacts(repo, {})).diff).toEqual(emptyDiff());

      const mid = head;
      for (let i = 0; i < 201; i++) await writeFile(join(repo, `n${String(i).padStart(3, '0')}.txt`), 'x\n');
      run(repo, 'add', '-A');
      run(repo, 'commit', '-m', 'many');
      const many = await collectFacts(repo, { base: mid });
      expect(many.diff.files).toHaveLength(200);
      expect(many.diff.truncated).toBe(true);
      expect(many.diff.filesChanged).toBe(201);
      expect(many.diff.linesAdded).toBe(201);
      expect(many.diff.linesDeleted).toBe(0);
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

describe('usage result negotiation', () => {
  const bare = { worktree: '/w', result: null, facts: null };
  it('parses old run results and fills columns only for keys the node actually sent', () => {
    const parsed = runResultSchema.parse(bare);
    expect(parsed.exitCode).toBeNull();
    expect(parsed.usage).toBeNull();
    expect(parsed.sessionId).toBeNull();
    const withFacts = runResultSchema.parse({ ...bare, facts: { worktree: '/w', branch: null, head: null } });
    expect(withFacts.facts?.diff).toEqual(emptyDiff());
    expect(runResultSchema.parse({ ...bare, exitCode: -1 }).exitCode).toBe(-1);
    expect(runResultSchema.safeParse({ ...bare, extra: true }).success).toBe(false);

    const job = { kind: 'run', payloadJson: JSON.stringify({ provider: 'codex' }) };
    expect(columnsForRunReport(job, { ok: true, result: bare })).toEqual({ provider: 'codex' });
    expect(columnsForRunReport(job, { ok: true, result: { ...bare, exitCode: 7, usage: null } })).toEqual({ provider: 'codex', exitCode: 7 });
    expect(columnsForRunReport(job, { ok: true, result: { ...bare, exitCode: -1 } }).exitCode).toBe(-1);
    expect(columnsForRunReport({ kind: 'run', payloadJson: JSON.stringify({ provider: 'claude' }) }, { ok: false, result: { usage: { inputTokens: 1 } } })).toEqual({ provider: 'claude' });
    expect(columnsForRunReport(job, { ok: false })).toEqual({ provider: 'codex' });
    expect(columnsForRunReport(job, { ok: true, result: { nope: true } })).toEqual({});
    expect(columnsForRunReport({ kind: 'probe', payloadJson: job.payloadJson }, { ok: true, result: { ...bare, exitCode: 0 } })).toEqual({});
    expect(columnsForRunReport({ kind: 'run', payloadJson: '{}' }, { ok: false })).toEqual({});
    expect(columnsForRunReport({ kind: 'run', payloadJson: JSON.stringify({ provider: 'p'.repeat(201) }) }, { ok: false })).toEqual({});

    const usage = { model: 'gpt', inputTokens: 1200, cachedInputTokens: 200, outputTokens: 80, costUsd: 0.25, numTurns: 2, cliDurationMs: 40, runDurationMs: 50, cliVersion: 'stub-codex 0.0.0', raw: 'x'.repeat(9000) };
    const diff = { files: [{ path: 'a.txt', added: 3, deleted: 1, binary: false }], filesChanged: 4, linesAdded: 3, linesDeleted: 1, truncated: true };
    const full = columnsForRunReport(job, { ok: true, result: { ...bare, exitCode: 0, usage, facts: { worktree: '/w', branch: 'main', head: 'abc', base: 'def', diff } } });
    expect(full).toMatchObject({ provider: 'codex', exitCode: 0, model: 'gpt', inputTokens: 1200, cachedInputTokens: 200, outputTokens: 80, costMicroUsd: 250000, numTurns: 2, cliDurationMs: 40, runDurationMs: 50, cliVersion: 'stub-codex 0.0.0', filesChanged: 4, linesAdded: 3, linesDeleted: 1 });
    expect(String(full.usageJson).length).toBeLessThanOrEqual(8000);
    expect(JSON.parse(String(full.usageJson))).toMatchObject({ inputTokens: 1200, raw: null, rawTruncated: true });
    expect(JSON.parse(String(full.diffStatJson)).truncated).toBe(true);
    expect(columnsForRunReport(job, { ok: true, result: { ...bare, usage: { inputTokens: 3_000_000_000 } } }).inputTokens).toBeNull();
  });

  it('strips exitCode, usage and diff unless the lease accepts usage_v1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wwa-accepts-'));
    const previous = { runner: process.env.WWA_RUNNER_DIR, codex: process.env.WWA_CODEX_BIN };
    const reports: Array<{ ok?: boolean; result?: Record<string, unknown>; error?: string }> = [];
    const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, encoding: 'utf8' }).trim();
    try {
      const repo = join(root, 'repo');
      await mkdir(repo, { recursive: true });
      run(repo, 'init', '-b', 'main');
      await writeFile(join(repo, 'README.md'), 'hi\n');
      run(repo, 'add', '-A');
      run(repo, 'commit', '-m', 'init');
      const cli = join(root, 'fake-codex.mjs');
      await writeFile(cli, [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "if (args.includes('--version')) { console.log('fake-codex 9.9.9'); process.exit(0); }",
        "readFileSync(0);",
        "const output = args[args.indexOf('--output-last-message') + 1];",
        "writeFileSync(output, JSON.stringify({ outcome: 'ready_for_review', summary: 'ok', questions: [], artifacts: [], checks: [], unfinished: [], proposedCommandsJson: '[]' }));",
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-fake' }));",
        "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 80, reasoning_output_tokens: 10 } }));",
      ].join('\n'));
      process.env.WWA_CODEX_BIN = cli;
      const queue = [
        { id: 'job-old', branch: 'feature-old', name: 'g1/old', accepts: undefined as string[] | undefined },
        { id: 'job-new', branch: 'feature-new', name: 'g1/new', accepts: ['usage_v1'] },
      ];
      const http: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith('/lease')) {
          const next = queue.shift();
          const data: { jobs: unknown[]; cancel: string[]; accepts?: string[] } = { jobs: [], cancel: [] };
          if (next) {
            data.jobs = [{ id: next.id, kind: 'run', phase: 'work', leaseToken: '0123456789abcdef', payload: { repoPath: repo, provider: 'codex', permissions: { profile: 'read_only', allowShell: false }, worktree: { create: { branch: next.branch, startPoint: 'main', worktreeName: next.name } }, prompt: 'hello', expect: {} } }];
            if (next.accepts) data.accepts = next.accepts;
          }
          return Response.json({ data });
        }
        if (url.endsWith('/progress')) return Response.json({ data: { ok: true } });
        if (url.endsWith('/result')) { reports.push(JSON.parse(String(init?.body))); return Response.json({ data: { ok: true } }); }
        return Response.json({ code: 'NOPE' }, { status: 500 });
      };
      const agent = new NodeAgent({ server: 'http://127.0.0.1:9', token: 'token', roots: [root], dataDir: join(root, 'node-data'), maxConcurrent: 1, pollMs: 50 }, http);
      await agent.pollOnce();
      await agent.idle();
      await agent.pollOnce();
      await agent.idle();
      expect(reports).toHaveLength(2);
      for (const report of reports) if (!report.ok) throw new Error(JSON.stringify(report));
      const [oldReport, nextReport] = reports;
      expect(oldReport.result).not.toHaveProperty('exitCode');
      expect(oldReport.result).not.toHaveProperty('usage');
      expect(oldReport.result?.facts).not.toHaveProperty('diff');
      expect(oldReport.result?.error).toBeNull();
      expect(nextReport.result?.exitCode).toBe(0);
      expect(nextReport.result?.usage).toMatchObject({ inputTokens: 1200, cachedInputTokens: 200, outputTokens: 80, costUsd: null, cliVersion: 'fake-codex 9.9.9' });
      expect((nextReport.result?.usage as { runDurationMs: number }).runDurationMs).toBeGreaterThanOrEqual(0);
      expect((nextReport.result?.facts as { diff: unknown }).diff).toEqual(emptyDiff());
    } finally {
      if (previous.runner === undefined) delete process.env.WWA_RUNNER_DIR; else process.env.WWA_RUNNER_DIR = previous.runner;
      if (previous.codex === undefined) delete process.env.WWA_CODEX_BIN; else process.env.WWA_CODEX_BIN = previous.codex;
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
