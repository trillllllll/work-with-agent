import { describe, expect, it } from 'vitest';
import { defaultParallelLimit, isBranchName, parallelCapForNodes, runParallelCap, topicsWithoutProject, unavailableEngine } from './logic.js';

describe('default parallel limit', () => {
  it('stays at 4 when no computer has reported a concurrency', () => {
    expect(defaultParallelLimit([])).toEqual({ limit: 4, limiterName: null });
    expect(defaultParallelLimit([{ maxConcurrent: null, name: 'a' }, { name: 'b', maxConcurrent: null }])).toEqual({ limit: 4, limiterName: null });
  });

  it('uses the smallest reported concurrency and ignores computers that have not reported', () => {
    expect(defaultParallelLimit([
      { maxConcurrent: null, name: 'silent' },
      { maxConcurrent: 4, name: 'wide' },
      { maxConcurrent: 2, name: 'laptop' },
      { maxConcurrent: 3, name: 'desk' },
    ])).toEqual({ limit: 2, limiterName: 'laptop' });
  });

  it('does not treat a non-finite report as a cap', () => {
    expect(defaultParallelLimit([{ maxConcurrent: Number.NaN, name: 'bad' }, { maxConcurrent: 3, name: 'ok' }])).toEqual({ limit: 3, limiterName: 'ok' });
  });
});

describe('run parallel cap', () => {
  it('stays at 4 until a computer is selected, then treats a missing report as 0', () => {
    expect(runParallelCap([])).toBe(4);
    expect(parallelCapForNodes([], [{ id: 'a', capabilities: { maxConcurrent: 1 } }])).toBe(4);
    expect(parallelCapForNodes(['a'], undefined)).toBe(4);
    expect(parallelCapForNodes(['missing'], [])).toBe(0);
    expect(runParallelCap([4, null, 2])).toBe(0);
    expect(runParallelCap([3, 2])).toBe(2);
  });

  it('names the first computer that has not reported the engine', () => {
    expect(unavailableEngine([
      { name: 'laptop', providers: [{ provider: 'codex', available: true }] },
      { name: 'desk', providers: [{ provider: 'claude', available: false }] },
    ], 'claude')).toBe('laptop');
    expect(unavailableEngine([{ name: 'laptop', providers: [{ provider: 'codex', available: true }] }], 'codex')).toBeNull();
  });
});

describe('topics without a project', () => {
  const topics = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }];

  it('lists topics that are unbound or only bound to an archived project', () => {
    const missing = topicsWithoutProject(topics, [
      { scopeId: 'a', projectArchived: false },
      { scopeId: 'b', projectArchived: true },
    ]);
    expect(missing.map((topic) => topic.id)).toEqual(['b', 'c']);
  });

  it('returns every topic when nothing is bound', () => {
    expect(topicsWithoutProject(topics, []).map((topic) => topic.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('branch names', () => {
  it('accepts a normal branch and rejects the same shapes the server rejects', () => {
    expect(isBranchName('main')).toBe(true);
    expect(isBranchName('feature/runner-settings')).toBe(true);
    expect(isBranchName('')).toBe(false);
    expect(isBranchName('-bad')).toBe(false);
    expect(isBranchName('has..dot')).toBe(false);
    expect(isBranchName('trailing/')).toBe(false);
    expect(isBranchName('no.lock')).toBe(false);
  });
});
