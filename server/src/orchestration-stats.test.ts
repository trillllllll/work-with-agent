import { afterAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import ownerRequest from './test-auth.js';
import { classifyFailure, failureKindFromStep, noNewCommitProblem } from './application/orchestration/checks.js';
import { aggregateDispatchStats, dispatchStats, parseStatsQuery, type StatsJob, type StatsRound, type StatsStep } from './application/orchestration/stats.js';

const owner = () => ownerRequest(app);
const stamp = `stats-${Date.now()}`;
const FROM = '2099-06-02T00:00:00.000Z';
const TO = '2099-06-09T00:00:00.000Z';
const day = 24 * 60 * 60 * 1000;
const ids: { tasks: string[]; orchestrations: string[]; projects: string[]; nodes: string[]; handoffs: string[]; runs: string[] } = { tasks: [], orchestrations: [], projects: [], nodes: [], handoffs: [], runs: [] };

const round = (extra: Partial<StatsRound> & Pick<StatsRound, 'id' | 'startedAt'>): StatsRound => ({
  taskId: 'task-a', projectId: 'project-p', status: 'running', rejectionReason: null, pauseReason: null, ...extra,
});
const step = (extra: Partial<StatsStep> & Pick<StatsStep, 'id' | 'kind' | 'status'>): StatsStep => ({
  orchestrationId: 'round-in', attempt: 1, continueCount: 0, retryCount: 0, failureKind: null, error: null, ...extra,
});
const job = (extra: Partial<StatsJob> & Pick<StatsJob, 'id' | 'endedAt'>): StatsJob => ({
  nodeId: 'node-1', orchestrationId: 'round-in', stepId: 'step-1', taskId: 'task-a', projectId: 'project-p', kind: 'run',
  startedAt: extra.endedAt, inputTokens: null, cachedInputTokens: null, outputTokens: null, costMicroUsd: null,
  filesChanged: null, linesAdded: null, linesDeleted: null, provider: 'codex', model: 'm1', ...extra,
});

function aggregate(extra: Partial<Parameters<typeof aggregateDispatchStats>[0]> = {}) {
  return aggregateDispatchStats({
    from: FROM,
    to: TO,
    rounds: [],
    steps: [],
    jobs: [],
    legacyRuns: [],
    tasks: [{ id: 'task-a', title: 'Alpha' }, { id: 'task-b', title: 'Beta' }],
    nodes: [{ id: 'node-1', name: 'Stats Node' }],
    projects: [{ id: 'project-p', name: 'P' }],
    ...extra,
  });
}

describe('dispatch stats aggregation', () => {
  it('rejects an invalid range and normalizes bounds', () => {
    expect(() => parseStatsQuery({ from: '2099-06-02', to: TO })).toThrow('统计的开始时间无效');
    expect(() => parseStatsQuery({ from: FROM, to: 'tomorrow' })).toThrow('统计的结束时间无效');
    expect(() => parseStatsQuery({ from: TO, to: FROM })).toThrow('统计区间的开始必须早于结束');
    expect(() => parseStatsQuery({ from: FROM, to: FROM })).toThrow('统计区间的开始必须早于结束');
    const exactly = new Date(Date.parse(FROM) + 366 * day).toISOString();
    expect(parseStatsQuery({ from: FROM, to: exactly }).to).toBe(exactly);
    expect(() => parseStatsQuery({ from: FROM, to: new Date(Date.parse(exactly) + 1).toISOString() })).toThrow('统计区间不能超过 366 天');
    expect(parseStatsQuery({ from: '2099-06-02T08:00:00+08:00', to: '2099-06-03T08:00:00+08:00', projectId: '  ' })).toEqual({
      from: FROM, to: '2099-06-03T00:00:00.000Z', projectId: null, fromMs: Date.parse(FROM), toMs: Date.parse('2099-06-03T00:00:00.000Z'),
    });
  });

  it('counts first-pass develop steps, skips drafts and skipped steps, and classifies failures', () => {
    const rounds: StatsRound[] = [
      round({ id: 'round-in', startedAt: FROM }),
      round({ id: 'round-rejected', startedAt: '2099-06-03T00:00:00.000Z', status: 'rejected', rejectionReason: '范围不对', latestPauseReason: 'merge_conflict_unresolved' }),
      round({ id: 'round-accepted', startedAt: '2099-06-04T00:00:00.000Z', status: 'accepted', rejectionReason: '' }),
      round({ id: 'round-draft', startedAt: '2099-06-04T01:00:00.000Z', status: 'draft' }),
      round({ id: 'round-before', startedAt: '2099-06-01T23:59:59.000Z' }),
      round({ id: 'round-end', startedAt: TO }),
      round({ id: 'round-other', startedAt: '2099-06-05T00:00:00.000Z', projectId: 'project-q', status: 'accepted' }),
    ];
    const failed = step({ id: 'dev-fail', kind: 'develop', status: 'needs_user', attempt: 2, continueCount: 1, retryCount: 1, error: `检查未通过：unit；${noNewCommitProblem}` });
    const steps: StatsStep[] = [
      step({ id: 'dev-pass', kind: 'develop', status: 'succeeded' }),
      failed,
      step({ id: 'dev-skip', kind: 'develop', status: 'skipped', attempt: 4, continueCount: 2 }),
      step({ id: 'merge-ok', kind: 'merge', status: 'succeeded' }),
      step({ id: 'merge-stored', kind: 'merge', status: 'needs_user', failureKind: 'cli_error', error: '429' }),
      step({ id: 'setup', kind: 'setup', status: 'failed', orchestrationId: 'round-in' }),
      step({ id: 'dev-tests', kind: 'develop', status: 'failed', orchestrationId: 'round-rejected', failureKind: 'tests_failed', continueCount: 2, retryCount: 3 }),
      step({ id: 'merge-conflict', kind: 'merge', status: 'needs_user', orchestrationId: 'round-rejected' }),
      step({ id: 'dev-again', kind: 'develop', status: 'succeeded', orchestrationId: 'round-accepted' }),
      step({ id: 'dev-draft', kind: 'develop', status: 'failed', orchestrationId: 'round-draft' }),
      step({ id: 'dev-outside', kind: 'develop', status: 'failed', orchestrationId: 'round-before', error: '429' }),
      step({ id: 'dev-other', kind: 'develop', status: 'succeeded', orchestrationId: 'round-other' }),
    ];
    const stats = aggregate({ rounds, steps, projectId: 'project-p' });
    expect(stats.roundCount).toBe(3);
    expect(stats.stepCount).toBe(8);
    expect(stats.firstPass).toEqual({ passed: 2, total: 4, rate: 0.5 });
    expect(stats.rework).toBe(9);
    expect(stats.rateRetries).toBe(4);
    expect(stats.rejected).toBe(1);
    expect(stats.accepted).toBe(1);
    expect(stats.succeeded).toBe(3);
    expect(stats.failed).toBe(4);
    expect(stats.failureKinds).toMatchObject({ no_commit: 1, cli_error: 1, tests_failed: 1, merge_conflict: 1, rate_limit: 0 });
    expect(failureKindFromStep(failed, null)).toBe(classifyFailure({
      pauseReason: null,
      error: failed.error,
      problems: (failed.error ?? '').split('；').map((part) => part.trim()).filter(Boolean),
    }));
    const open = aggregate({ rounds: [round({ id: 'round-in', startedAt: FROM })], steps: [step({ id: 'only-skip', kind: 'develop', status: 'skipped' })] });
    expect(open.firstPass).toEqual({ passed: 0, total: 0, rate: null });
  });

  it('sums usage once per job, keeps the last in-range diff, and ranks cost without nulls', () => {
    const early = '2099-06-02T01:00:00.000Z';
    const later = '2099-06-02T02:00:00.000Z';
    const jobs: StatsJob[] = [
      job({ id: 'job-early', stepId: 'dev', endedAt: early, startedAt: '2099-06-01T23:00:00.000Z', inputTokens: 100, cachedInputTokens: 10, outputTokens: 20, costMicroUsd: null, filesChanged: 1, linesAdded: 2, linesDeleted: 3 }),
      job({ id: 'job-later', stepId: 'dev', endedAt: later, startedAt: early, inputTokens: 40, cachedInputTokens: 4, outputTokens: 6, costMicroUsd: 2500, filesChanged: 4, linesAdded: 9, linesDeleted: 1, model: 'm2' }),
      job({ id: 'job-after', stepId: 'dev', endedAt: TO, inputTokens: 999, costMicroUsd: 999, filesChanged: 50, linesAdded: 50, linesDeleted: 50 }),
      job({ id: 'job-null', stepId: 'dev-2', endedAt: '2099-06-02T03:00:00.000Z', provider: null, model: null, nodeId: 'missing-node', filesChanged: 2, linesAdded: 2, linesDeleted: 2 }),
      job({ id: 'job-verify', stepId: 'merge', endedAt: '2099-06-02T05:00:00.000Z', startedAt: '2099-06-02T04:00:00.000Z', inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, costMicroUsd: 500, filesChanged: 8, linesAdded: 1, linesDeleted: 2, provider: 'claude', model: 'verify' }),
      job({ id: 'job-verify-early', stepId: 'merge', endedAt: '2099-06-02T04:00:00.000Z', inputTokens: 10, cachedInputTokens: 1, outputTokens: 1, filesChanged: 3, linesAdded: 3, linesDeleted: 3 }),
      job({ id: 'job-a', stepId: 'tie', endedAt: later, filesChanged: 1, linesAdded: 1, linesDeleted: 1, inputTokens: 1 }),
      job({ id: 'job-b', stepId: 'tie', endedAt: later, filesChanged: 9, linesAdded: 2, linesDeleted: 3, inputTokens: 1 }),
      job({ id: 'job-push', kind: 'push', endedAt: later, inputTokens: 5000 }),
      job({ id: 'job-orphan', orchestrationId: null, endedAt: later, inputTokens: 4000 }),
      job({ id: 'job-other', projectId: 'project-q', taskId: 'task-q', endedAt: later, inputTokens: 1000, costMicroUsd: 1 }),
      job({ id: 'job-beta', taskId: 'task-b', stepId: 'beta', endedAt: '2099-06-03T00:00:00.000Z', startedAt: '2099-06-02T00:00:00.000Z', inputTokens: 2, costMicroUsd: 9000, filesChanged: 1 }),
      job({ id: 'job-free', taskId: 'task-free', stepId: 'free', endedAt: later, startedAt: later, costMicroUsd: null, inputTokens: 0, filesChanged: 0, linesAdded: 0, linesDeleted: 0 }),
    ];
    for (let index = 0; index < 4; index += 1) {
      jobs.push(job({ id: `job-extra-${index}`, taskId: `task-extra-${index}`, stepId: `extra-${index}`, endedAt: later, startedAt: '2099-06-02T00:00:00.000Z', costMicroUsd: 100 - index, inputTokens: 1 }));
    }
    const stats = aggregate({
      jobs,
      tasks: [
        { id: 'task-a', title: 'Alpha' },
        { id: 'task-b', title: 'Beta' },
        { id: 'task-free', title: 'Free' },
        ...[0, 1, 2, 3].map((index) => ({ id: `task-extra-${index}`, title: `Extra ${index}` })),
      ],
      projectId: 'project-p',
      legacyRuns: [
        { id: 'run-1', startedAt: '2099-06-02T00:00:00.000Z', endedAt: '2099-06-02T00:00:05.000Z', inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, costMicroUsd: null },
        { id: 'run-2', startedAt: '2099-06-01T23:00:00.000Z', endedAt: FROM, inputTokens: 4, cachedInputTokens: 0, outputTokens: 1, costMicroUsd: 40 },
        { id: 'run-out', startedAt: TO, endedAt: TO, inputTokens: 9, cachedInputTokens: 0, outputTokens: 0, costMicroUsd: 1 },
      ],
    });
    expect(stats.resources).toMatchObject({
      jobs: 13,
      jobsWithUsage: 12,
      inputTokens: 100 + 40 + 5 + 10 + 1 + 1 + 2 + 0 + 1 + 1 + 1 + 1,
      cachedInputTokens: 10 + 4 + 0 + 1,
      outputTokens: 20 + 6 + 2 + 1,
      costMicroUsd: 2500 + 500 + 9000 + 100 + 99 + 98 + 97,
      costJobs: 7,
      noCostJobs: 6,
      filesChanged: 4 + 2 + 8 + 9 + 1 + 0,
      linesAdded: 9 + 2 + 1 + 2,
      linesDeleted: 1 + 2 + 2 + 3,
      durationMs: 12 * 60 * 60 * 1000 + day,
    });
    expect(stats.resources.filesChanged).not.toBe(4 + 1 + 50);
    expect(stats.byNode.map((group) => group.key)).toEqual(['Stats Node', 'unknown']);
    expect(stats.byProvider.find((group) => group.key === 'unknown')?.jobs).toBe(1);
    expect(stats.byModel.find((group) => group.key === 'm2')?.costMicroUsd).toBe(2500);
    expect(stats.top5ByDuration.map((item) => item.taskId)).toEqual(['task-b', 'task-a', 'task-extra-0', 'task-extra-1', 'task-extra-2']);
    expect(stats.top5ByCost.map((item) => item.title)).toEqual(['Beta', 'Alpha', 'Extra 0', 'Extra 1', 'Extra 2']);
    expect(stats.top5ByCost.some((item) => item.taskId === 'task-free')).toBe(false);
    expect(stats.legacy).toEqual({ count: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costMicroUsd: 0, costJobs: 0, noCostJobs: 0, durationMs: 0 });
    const all = aggregate({
      jobs,
      legacyRuns: [
        { id: 'run-1', startedAt: '2099-06-02T00:00:00.000Z', endedAt: '2099-06-02T00:00:05.000Z', inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, costMicroUsd: null },
        { id: 'run-2', startedAt: '2099-06-01T23:00:00.000Z', endedAt: FROM, inputTokens: 4, cachedInputTokens: 0, outputTokens: 1, costMicroUsd: 40 },
        { id: 'run-out', startedAt: TO, endedAt: TO, inputTokens: 9, cachedInputTokens: 0, outputTokens: 0, costMicroUsd: 1 },
      ],
    });
    expect(all.legacy).toMatchObject({ count: 2, inputTokens: 7, cachedInputTokens: 1, outputTokens: 3, costMicroUsd: 40, costJobs: 1, noCostJobs: 1, durationMs: 5000 + 60 * 60 * 1000 });
    expect(all.resources.inputTokens).toBe(stats.resources.inputTokens + 1000);
    expect(all.roundCount).toBe(0);
  });
});

describe('dispatch stats loader', () => {
  const created = { node: '', blank: '', project: '', other: '', alpha: '', beta: '', gamma: '' };

  afterAll(async () => {
    if (ids.orchestrations.length) {
      await prisma.orchestrationEvent.deleteMany({ where: { orchestrationId: { in: ids.orchestrations } } });
      await prisma.nodeJob.deleteMany({ where: { OR: [{ orchestrationId: { in: ids.orchestrations } }, { nodeId: { in: ids.nodes } }] } });
      await prisma.orchestrationStep.deleteMany({ where: { orchestrationId: { in: ids.orchestrations } } });
      await prisma.orchestration.deleteMany({ where: { id: { in: ids.orchestrations } } });
    }
    if (ids.runs.length) await prisma.run.deleteMany({ where: { id: { in: ids.runs } } });
    if (ids.handoffs.length) await prisma.handoff.deleteMany({ where: { id: { in: ids.handoffs } } });
    if (ids.projects.length) await prisma.project.deleteMany({ where: { id: { in: ids.projects } } });
    if (ids.nodes.length) await prisma.agentNode.deleteMany({ where: { id: { in: ids.nodes } } });
    if (ids.tasks.length) await prisma.task.deleteMany({ where: { id: { in: ids.tasks } } });
  });

  it('matches the pure rules and the same Prisma aggregate', async () => {
    const now = '2099-06-01T00:00:00.000Z';
    created.node = (await prisma.agentNode.create({ data: { name: 'Stats Node', tokenHash: `${stamp}-node`, createdAt: now, updatedAt: now } })).id;
    created.blank = (await prisma.agentNode.create({ data: { name: '', tokenHash: `${stamp}-blank`, createdAt: now, updatedAt: now } })).id;
    created.project = (await prisma.project.create({ data: { name: 'Stats P', createdAt: now, updatedAt: now } })).id;
    created.other = (await prisma.project.create({ data: { name: 'Stats Q', createdAt: now, updatedAt: now } })).id;
    created.alpha = (await prisma.task.create({ data: { title: 'Alpha', createdAt: now, updatedAt: now } })).id;
    created.beta = (await prisma.task.create({ data: { title: 'Beta', createdAt: now, updatedAt: now } })).id;
    created.gamma = (await prisma.task.create({ data: { title: 'Gamma', createdAt: now, updatedAt: now } })).id;
    const draftTask = (await prisma.task.create({ data: { title: 'Draft', createdAt: now, updatedAt: now } })).id;
    ids.nodes.push(created.node, created.blank);
    ids.projects.push(created.project, created.other);
    ids.tasks.push(created.alpha, created.beta, created.gamma, draftTask);

    const makeRound = async (taskId: string, roundNo: number, projectId: string, status: string, startedAt: string | null, rejectionReason: string | null = null) => {
      const row = await prisma.orchestration.create({ data: { taskId, round: roundNo, projectId, status, integrationBranch: `${stamp}-r${roundNo}-${taskId.slice(-4)}`, grantJson: '{}', taskSnapshotJson: '{}', startedAt, rejectionReason, createdAt: now, updatedAt: now } });
      ids.orchestrations.push(row.id);
      return row;
    };
    const main = await makeRound(created.alpha, 1, created.project, 'awaiting_acceptance', FROM);
    const rejected = await makeRound(created.beta, 1, created.project, 'rejected', '2099-06-03T00:00:00.000Z', '范围不对');
    await makeRound(created.alpha, 2, created.project, 'accepted', '2099-06-04T00:00:00.000Z', '');
    const other = await makeRound(created.gamma, 1, created.other, 'accepted', '2099-06-05T00:00:00.000Z');
    await makeRound(draftTask, 1, created.project, 'draft', '2099-06-05T01:00:00.000Z');
    const old = await makeRound(created.alpha, 4, created.project, 'accepted', '2099-06-01T12:00:00.000Z');
    await makeRound(created.alpha, 5, created.project, 'superseded', TO);
    await prisma.orchestrationEvent.create({ data: { orchestrationId: rejected.id, seq: 1, type: 'paused', actorKind: 'user', payload: JSON.stringify({ reason: 'user_paused' }), createdAt: now } });
    await prisma.orchestrationEvent.create({ data: { orchestrationId: rejected.id, seq: 2, type: 'paused', actorKind: 'server', payload: JSON.stringify({ reason: 'merge_conflict_unresolved' }), createdAt: now } });

    const makeStep = (orchestrationId: string, kind: string, position: number, status: string, extra: Record<string, unknown> = {}) => prisma.orchestrationStep.create({ data: { orchestrationId, kind, position, status, createdAt: now, updatedAt: now, ...extra } });
    const devPass = await makeStep(main.id, 'develop', 1, 'succeeded');
    const devFail = await makeStep(main.id, 'develop', 2, 'needs_user', { attempt: 2, continueCount: 1, retryCount: 1, error: noNewCommitProblem });
    await makeStep(main.id, 'develop', 3, 'skipped', { attempt: 4, continueCount: 2 });
    const mergeOk = await makeStep(main.id, 'merge', 4, 'succeeded');
    const mergeStored = await makeStep(main.id, 'merge', 5, 'needs_user', { failureKind: 'cli_error', error: '429' });
    await makeStep(main.id, 'setup', 6, 'failed', { failureKind: 'other' });
    const devTests = await makeStep(rejected.id, 'develop', 1, 'failed', { failureKind: 'tests_failed', continueCount: 2, retryCount: 3 });
    await makeStep(rejected.id, 'merge', 2, 'needs_user');
    const acceptedRound = ids.orchestrations[2]!;
    await makeStep(acceptedRound, 'develop', 1, 'succeeded');
    await makeStep(other.id, 'develop', 1, 'succeeded');
    const devOld = await makeStep(old.id, 'develop', 1, 'succeeded');

    const makeJob = (data: Record<string, unknown>) => prisma.nodeJob.create({ data: { nodeId: created.node, kind: 'run', phase: 'work', payloadJson: '{}', status: 'done', provider: 'codex', model: 'm1', createdAt: now, updatedAt: now, ...data } as never });
    await makeJob({ dispatchKey: `${stamp}-early`, orchestrationId: main.id, stepId: devPass.id, startedAt: '2099-06-01T23:00:00.000Z', endedAt: FROM, inputTokens: 100, cachedInputTokens: 10, outputTokens: 20, costMicroUsd: null, filesChanged: 1, linesAdded: 2, linesDeleted: 3 });
    await makeJob({ dispatchKey: `${stamp}-later`, orchestrationId: main.id, stepId: devPass.id, startedAt: '2099-06-02T01:00:00.000Z', endedAt: '2099-06-02T02:00:00.000Z', inputTokens: 40, cachedInputTokens: 4, outputTokens: 6, costMicroUsd: 2500, filesChanged: 4, linesAdded: 9, linesDeleted: 1, model: 'm2' });
    await makeJob({ dispatchKey: `${stamp}-after`, orchestrationId: main.id, stepId: devPass.id, startedAt: TO, endedAt: TO, inputTokens: 999, costMicroUsd: 999, filesChanged: 50, linesAdded: 50, linesDeleted: 50 });
    await makeJob({ dispatchKey: `${stamp}-null`, nodeId: created.blank, orchestrationId: main.id, stepId: devFail.id, startedAt: '2099-06-02T03:00:00.000Z', endedAt: '2099-06-02T03:00:00.500Z', provider: null, model: null, filesChanged: 2, linesAdded: 2, linesDeleted: 2 });
    await makeJob({ dispatchKey: `${stamp}-merge`, orchestrationId: main.id, stepId: mergeOk.id, startedAt: '2099-06-02T04:00:00.000Z', endedAt: '2099-06-02T04:00:02.000Z', inputTokens: 10, cachedInputTokens: 1, outputTokens: 1, filesChanged: 3, linesAdded: 3, linesDeleted: 3 });
    await makeJob({ dispatchKey: `${stamp}-verify`, orchestrationId: main.id, stepId: mergeOk.id, phase: 'verify', startedAt: '2099-06-02T04:00:02.000Z', endedAt: '2099-06-02T04:00:03.500Z', inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, costMicroUsd: 500, filesChanged: 8, linesAdded: 1, linesDeleted: 2, provider: 'claude', model: 'verify' });
    await makeJob({ id: `${stamp}-a`, dispatchKey: `${stamp}-tie-a`, orchestrationId: main.id, stepId: mergeStored.id, startedAt: '2099-06-02T06:00:00.000Z', endedAt: '2099-06-02T06:00:00.010Z', inputTokens: 1, filesChanged: 1, linesAdded: 1, linesDeleted: 1 });
    await makeJob({ id: `${stamp}-b`, dispatchKey: `${stamp}-tie-b`, orchestrationId: main.id, stepId: mergeStored.id, startedAt: '2099-06-02T06:00:00.000Z', endedAt: '2099-06-02T06:00:00.010Z', inputTokens: 1, filesChanged: 9, linesAdded: 2, linesDeleted: 3 });
    await makeJob({ dispatchKey: `${stamp}-beta`, orchestrationId: rejected.id, stepId: devTests.id, startedAt: '2099-06-03T00:00:00.000Z', endedAt: '2099-06-03T00:00:10.000Z', inputTokens: 2, costMicroUsd: 9000, filesChanged: 1, linesAdded: 0, linesDeleted: 0 });
    await makeJob({ dispatchKey: `${stamp}-old`, orchestrationId: old.id, stepId: devOld.id, startedAt: '2099-06-06T00:00:00.000Z', endedAt: '2099-06-06T00:00:00.100Z', inputTokens: 7, cachedInputTokens: 1, outputTokens: 1, costMicroUsd: 100, filesChanged: 6, linesAdded: 6, linesDeleted: 6 });
    await makeJob({ dispatchKey: `${stamp}-nostep`, orchestrationId: main.id, stepId: null, startedAt: '2099-06-06T01:00:00.000Z', endedAt: '2099-06-06T01:00:00.050Z', inputTokens: 3, cachedInputTokens: 0, outputTokens: 1, model: null });
    await makeJob({ dispatchKey: `${stamp}-other`, orchestrationId: other.id, stepId: null, startedAt: '2099-06-06T02:00:00.000Z', endedAt: '2099-06-06T02:00:00.010Z', inputTokens: 1000, costMicroUsd: 1, filesChanged: 1, linesAdded: 1, linesDeleted: 1 });
    await makeJob({ dispatchKey: `${stamp}-push`, orchestrationId: main.id, kind: 'push', startedAt: FROM, endedAt: '2099-06-02T08:00:00.000Z', inputTokens: 5000 });
    await makeJob({ dispatchKey: `${stamp}-orphan`, orchestrationId: null, startedAt: FROM, endedAt: '2099-06-02T08:00:00.000Z', inputTokens: 4000 });

    const handoff = await prisma.handoff.create({ data: { taskId: created.alpha, provider: 'codex', mode: 'manual', instruction: 'legacy', inputSnapshot: '{}', inputHash: `${stamp}-hash`, createdAt: now, updatedAt: now } });
    ids.handoffs.push(handoff.id);
    const runIn = await prisma.run.create({ data: { handoffId: handoff.id, provider: 'codex', mode: 'manual', status: 'returned', startedAt: '2099-06-02T00:00:00.000Z', endedAt: '2099-06-02T00:00:05.000Z', inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, costMicroUsd: null, createdAt: now, updatedAt: now } });
    const runEdge = await prisma.run.create({ data: { handoffId: handoff.id, provider: 'codex', mode: 'manual', status: 'returned', startedAt: '2099-06-01T23:00:00.000Z', endedAt: FROM, inputTokens: 4, cachedInputTokens: 0, outputTokens: 1, costMicroUsd: 40, createdAt: now, updatedAt: now } });
    const runOut = await prisma.run.create({ data: { handoffId: handoff.id, provider: 'codex', mode: 'manual', status: 'returned', startedAt: TO, endedAt: TO, inputTokens: 9, createdAt: now, updatedAt: now } });
    ids.runs.push(runIn.id, runEdge.id, runOut.id);

    const stats = await dispatchStats({ from: FROM, to: TO, projectId: created.project });
    expect(stats).toMatchObject({
      from: FROM,
      to: TO,
      projectId: created.project,
      roundCount: 3,
      stepCount: 8,
      firstPass: { passed: 2, total: 4, rate: 0.5 },
      rework: 9,
      rateRetries: 4,
      rejected: 1,
      accepted: 1,
      succeeded: 3,
      failed: 4,
      resources: {
        jobs: 10,
        jobsWithUsage: 9,
        inputTokens: 169,
        cachedInputTokens: 16,
        outputTokens: 31,
        costMicroUsd: 12100,
        costJobs: 4,
        noCostJobs: 6,
        filesChanged: 30,
        linesAdded: 20,
        linesDeleted: 14,
      },
    });
    expect(stats.failureKinds).toMatchObject({ no_commit: 1, cli_error: 1, tests_failed: 1, merge_conflict: 1 });
    expect(stats.failureKinds.no_commit).toBe(1);
    expect(failureKindFromStep({ failureKind: null, error: noNewCommitProblem }, null)).toBe('no_commit');
    expect(stats.top5ByDuration[0]).toMatchObject({ taskId: created.alpha, title: 'Alpha' });
    expect(stats.top5ByCost[0]).toMatchObject({ taskId: created.beta, title: 'Beta', costMicroUsd: 9000 });
    expect(stats.top5ByCost.some((item) => item.costMicroUsd === 0)).toBe(false);
    expect(stats.byNode.find((group) => group.key === 'unknown')?.jobs).toBe(1);
    expect(stats.legacy).toEqual({ count: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costMicroUsd: 0, costJobs: 0, noCostJobs: 0, durationMs: 0 });

    const projectIds = (await prisma.orchestration.findMany({ where: { projectId: created.project }, select: { id: true } })).map((row) => row.id);
    const summed = await prisma.nodeJob.aggregate({
      where: { kind: 'run', endedAt: { gte: FROM, lt: TO }, orchestrationId: { in: projectIds } },
      _sum: { inputTokens: true, cachedInputTokens: true, outputTokens: true },
    });
    expect(stats.resources.inputTokens).toBe(summed._sum.inputTokens ?? 0);
    expect(stats.resources.cachedInputTokens).toBe(summed._sum.cachedInputTokens ?? 0);
    expect(stats.resources.outputTokens).toBe(summed._sum.outputTokens ?? 0);
    expect(stats.roundCount).toBe(await prisma.orchestration.count({ where: { projectId: created.project, status: { not: 'draft' }, startedAt: { gte: FROM, lt: TO } } }));

    const all = await dispatchStats({ from: FROM, to: TO });
    const allSum = await prisma.nodeJob.aggregate({
      where: { kind: 'run', endedAt: { gte: FROM, lt: TO }, orchestrationId: { not: null } },
      _sum: { inputTokens: true, outputTokens: true },
    });
    expect(all.resources.inputTokens).toBe(allSum._sum.inputTokens ?? 0);
    expect(all.resources.outputTokens).toBe(allSum._sum.outputTokens ?? 0);
    expect(all.roundCount).toBe(await prisma.orchestration.count({ where: { status: { not: 'draft' }, startedAt: { gte: FROM, lt: TO } } }));
    expect(all.legacy.count).toBe(await prisma.run.count({ where: { endedAt: { gte: FROM, lt: TO } } }));
    expect(all.legacy.inputTokens).toBe(7);
    expect(all.resources.inputTokens).toBe(stats.resources.inputTokens + 1000);
    expect(all.legacy.inputTokens).not.toBe(all.resources.inputTokens);

    const missing = await dispatchStats({ from: FROM, to: TO, projectId: `${stamp}-missing` });
    expect(missing.roundCount).toBe(0);
    expect(missing.resources.jobs).toBe(0);
    expect(missing.legacy.count).toBe(0);
    expect(missing.firstPass.rate).toBeNull();

    const bad = await owner().get('/api/orchestrations/stats').query({ from: 'nope', to: TO });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: '统计的开始时间无效', code: 'INVALID_STATS_RANGE' });
    const wide = await owner().get('/api/orchestrations/stats').query({ from: FROM, to: new Date(Date.parse(FROM) + 366 * day + 1).toISOString() });
    expect(wide.status).toBe(400);
    expect(wide.body.error).toBe('统计区间不能超过 366 天');
    const ok = await owner().get('/api/orchestrations/stats').query({ from: '2099-06-02T08:00:00+08:00', to: '2099-06-09T08:00:00+08:00', projectId: created.project });
    expect(ok.status).toBe(200);
    expect(ok.body.data.roundCount).toBe(3);
    expect(ok.body.data.from).toBe(FROM);
  });
});
