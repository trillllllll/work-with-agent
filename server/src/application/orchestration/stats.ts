/**
 * Dispatch stats. Round metrics follow the round's startedAt. Usage follows each run job's endedAt.
 * The server only aggregates rows it already stored. It does not run git or read a workspace.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/prisma.js';
import { DomainError } from '../../domain/task.js';
import { failureKindFromStep, type FailureKind } from './checks.js';

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const WORK_KINDS = new Set(['develop', 'merge']);
const ENDED = new Set(['succeeded', 'needs_user', 'failed']);
const FAILED = new Set(['needs_user', 'failed']);

export type StatsRound = {
  id: string;
  taskId: string;
  projectId: string;
  status: string;
  startedAt: string | null;
  rejectionReason: string | null;
  pauseReason: string | null;
  /** Latest paused-event reason, falling back to the row's pauseReason. */
  latestPauseReason?: string | null;
};

export type StatsStep = {
  id: string;
  orchestrationId: string;
  kind: string;
  status: string;
  attempt: number;
  continueCount: number;
  retryCount: number;
  failureKind: string | null;
  error: string | null;
};

export type StatsJob = {
  id: string;
  nodeId: string;
  orchestrationId: string | null;
  stepId: string | null;
  taskId: string | null;
  projectId: string | null;
  kind: string;
  startedAt: string | null;
  endedAt: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number | null;
  filesChanged: number | null;
  linesAdded: number | null;
  linesDeleted: number | null;
  provider: string | null;
  model: string | null;
};

export type StatsLegacyRun = {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number | null;
};

export type StatsTask = { id: string; title: string };
export type StatsNode = { id: string; name: string };
export type StatsProject = { id: string; name: string };

export type UsageGroup = {
  key: string;
  jobs: number;
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
};

export type DispatchStats = {
  from: string;
  to: string;
  projectId: string | null;
  roundCount: number;
  stepCount: number;
  firstPass: { passed: number; total: number; rate: number | null };
  rework: number;
  rateRetries: number;
  rejected: number;
  accepted: number;
  succeeded: number;
  failed: number;
  failureKinds: Record<FailureKind, number>;
  resources: {
    jobs: number;
    jobsWithUsage: number;
    durationMs: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costMicroUsd: number;
    costJobs: number;
    noCostJobs: number;
    filesChanged: number;
    linesAdded: number;
    linesDeleted: number;
  };
  byNode: UsageGroup[];
  byProvider: UsageGroup[];
  byModel: UsageGroup[];
  top5ByDuration: Array<{ taskId: string; title: string; durationMs: number; jobs: number }>;
  top5ByCost: Array<{ taskId: string; title: string; costMicroUsd: number; jobs: number }>;
  legacy: {
    count: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costMicroUsd: number;
    costJobs: number;
    noCostJobs: number;
    durationMs: number;
  };
};

export function parseStatsQuery(query: { from?: string | null; to?: string | null; projectId?: string | null }) {
  const from = typeof query.from === 'string' ? query.from.trim() : '';
  const to = typeof query.to === 'string' ? query.to.trim() : '';
  if (!ISO_DATETIME.test(from) || Number.isNaN(Date.parse(from))) throw new DomainError('INVALID_STATS_RANGE', '统计的开始时间无效', 400);
  if (!ISO_DATETIME.test(to) || Number.isNaN(Date.parse(to))) throw new DomainError('INVALID_STATS_RANGE', '统计的结束时间无效', 400);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (fromMs >= toMs) throw new DomainError('INVALID_STATS_RANGE', '统计区间的开始必须早于结束', 400);
  if (toMs - fromMs > MAX_RANGE_MS) throw new DomainError('INVALID_STATS_RANGE', '统计区间不能超过 366 天', 400);
  const projectId = typeof query.projectId === 'string' && query.projectId.trim() ? query.projectId.trim() : null;
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), projectId, fromMs, toMs };
}

function inRange(value: string | null | undefined, fromMs: number, toMs: number) {
  if (!value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= fromMs && ms < toMs;
}

function durationMs(startedAt: string | null, endedAt: string | null) {
  if (!startedAt || !endedAt) return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start;
}

function emptyKinds(): Record<FailureKind, number> {
  return { rate_limit: 0, git_denied: 0, no_commit: 0, tests_failed: 0, merge_conflict: 0, review_failed: 0, cli_error: 0, other: 0 };
}

function emptyGroup(key: string): UsageGroup {
  return { key, jobs: 0, durationMs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costMicroUsd: 0 };
}

function addUsage(group: UsageGroup, job: StatsJob) {
  group.jobs += 1;
  group.durationMs += durationMs(job.startedAt, job.endedAt);
  group.inputTokens += job.inputTokens ?? 0;
  group.cachedInputTokens += job.cachedInputTokens ?? 0;
  group.outputTokens += job.outputTokens ?? 0;
  group.costMicroUsd += job.costMicroUsd ?? 0;
}

function sortedGroups(groups: Map<string, UsageGroup>) {
  return [...groups.values()].sort((a, b) => b.jobs - a.jobs || a.key.localeCompare(b.key));
}

export function aggregateDispatchStats(input: {
  from: string;
  to: string;
  projectId?: string | null;
  rounds: StatsRound[];
  steps: StatsStep[];
  jobs: StatsJob[];
  legacyRuns: StatsLegacyRun[];
  tasks: StatsTask[];
  nodes: StatsNode[];
  projects: StatsProject[];
}): DispatchStats {
  const parsed = parseStatsQuery({ from: input.from, to: input.to, projectId: input.projectId });
  const projectId = parsed.projectId;
  const titles = new Map(input.tasks.map((task) => [task.id, task.title]));
  const nodeNames = new Map(input.nodes.map((node) => [node.id, node.name]));
  // `projects` is part of the loader payload (names are not needed for the counts).
  void input.projects;

  const rounds = input.rounds.filter((round) => round.status !== 'draft' && (!projectId || round.projectId === projectId) && inRange(round.startedAt, parsed.fromMs, parsed.toMs));
  const roundIds = new Set(rounds.map((round) => round.id));
  const pauseByRound = new Map(rounds.map((round) => [round.id, round.latestPauseReason ?? round.pauseReason ?? null]));
  const steps = input.steps.filter((step) => roundIds.has(step.orchestrationId) && WORK_KINDS.has(step.kind));

  let rework = 0;
  let rateRetries = 0;
  let succeeded = 0;
  let failed = 0;
  let passed = 0;
  let total = 0;
  const kinds = emptyKinds();
  for (const step of steps) {
    rework += step.continueCount + Math.max(0, step.attempt - 1);
    rateRetries += step.retryCount;
    if (step.status === 'succeeded') succeeded += 1;
    if (FAILED.has(step.status)) {
      failed += 1;
      const kind = failureKindFromStep(step, pauseByRound.get(step.orchestrationId) ?? null);
      kinds[kind] += 1;
    }
    if (step.kind === 'develop' && ENDED.has(step.status)) {
      total += 1;
      if (step.status === 'succeeded' && step.attempt === 1 && step.continueCount === 0) passed += 1;
    }
  }

  const jobs = input.jobs.filter((job) => job.kind === 'run' && job.orchestrationId && (!projectId || job.projectId === projectId) && inRange(job.endedAt, parsed.fromMs, parsed.toMs));
  const resources = { jobs: 0, jobsWithUsage: 0, durationMs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costMicroUsd: 0, costJobs: 0, noCostJobs: 0, filesChanged: 0, linesAdded: 0, linesDeleted: 0 };
  const byNode = new Map<string, UsageGroup>();
  const byProvider = new Map<string, UsageGroup>();
  const byModel = new Map<string, UsageGroup>();
  const durationByTask = new Map<string, { taskId: string; durationMs: number; jobs: number }>();
  const costByTask = new Map<string, { taskId: string; costMicroUsd: number; jobs: number }>();
  const lastDiff = new Map<string, StatsJob>();

  for (const job of jobs) {
    resources.jobs += 1;
    resources.durationMs += durationMs(job.startedAt, job.endedAt);
    resources.inputTokens += job.inputTokens ?? 0;
    resources.cachedInputTokens += job.cachedInputTokens ?? 0;
    resources.outputTokens += job.outputTokens ?? 0;
    if (job.inputTokens != null || job.cachedInputTokens != null || job.outputTokens != null) resources.jobsWithUsage += 1;
    if (job.costMicroUsd == null) resources.noCostJobs += 1;
    else {
      resources.costJobs += 1;
      resources.costMicroUsd += job.costMicroUsd;
    }
    const nodeKey = nodeNames.get(job.nodeId) || 'unknown';
    const providerKey = job.provider || 'unknown';
    const modelKey = job.model || 'unknown';
    for (const [map, key] of [[byNode, nodeKey], [byProvider, providerKey], [byModel, modelKey]] as const) {
      const group = map.get(key) ?? emptyGroup(key);
      addUsage(group, job);
      map.set(key, group);
    }
    if (job.taskId) {
      const duration = durationByTask.get(job.taskId) ?? { taskId: job.taskId, durationMs: 0, jobs: 0 };
      duration.durationMs += durationMs(job.startedAt, job.endedAt);
      duration.jobs += 1;
      durationByTask.set(job.taskId, duration);
      if (job.costMicroUsd != null) {
        const cost = costByTask.get(job.taskId) ?? { taskId: job.taskId, costMicroUsd: 0, jobs: 0 };
        cost.costMicroUsd += job.costMicroUsd;
        cost.jobs += 1;
        costByTask.set(job.taskId, cost);
      }
    }
    if (job.stepId) {
      const previous = lastDiff.get(job.stepId);
      if (!previous || (job.endedAt ?? '') > (previous.endedAt ?? '') || ((job.endedAt ?? '') === (previous.endedAt ?? '') && job.id > previous.id)) lastDiff.set(job.stepId, job);
    }
  }
  for (const job of lastDiff.values()) {
    resources.filesChanged += job.filesChanged ?? 0;
    resources.linesAdded += job.linesAdded ?? 0;
    resources.linesDeleted += job.linesDeleted ?? 0;
  }

  const rankTitle = (taskId: string) => titles.get(taskId) || taskId;
  const top5ByDuration = [...durationByTask.values()].sort((a, b) => b.durationMs - a.durationMs || a.taskId.localeCompare(b.taskId)).slice(0, 5).map((item) => ({ ...item, title: rankTitle(item.taskId) }));
  const top5ByCost = [...costByTask.values()].sort((a, b) => b.costMicroUsd - a.costMicroUsd || a.taskId.localeCompare(b.taskId)).slice(0, 5).map((item) => ({ ...item, title: rankTitle(item.taskId) }));

  const legacy = { count: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costMicroUsd: 0, costJobs: 0, noCostJobs: 0, durationMs: 0 };
  if (!projectId) {
    for (const run of input.legacyRuns) {
      if (!inRange(run.endedAt, parsed.fromMs, parsed.toMs)) continue;
      legacy.count += 1;
      legacy.durationMs += durationMs(run.startedAt, run.endedAt);
      legacy.inputTokens += run.inputTokens ?? 0;
      legacy.cachedInputTokens += run.cachedInputTokens ?? 0;
      legacy.outputTokens += run.outputTokens ?? 0;
      if (run.costMicroUsd == null) legacy.noCostJobs += 1;
      else { legacy.costJobs += 1; legacy.costMicroUsd += run.costMicroUsd; }
    }
  }

  return {
    from: parsed.from,
    to: parsed.to,
    projectId,
    roundCount: rounds.length,
    stepCount: steps.length,
    firstPass: { passed, total, rate: total === 0 ? null : passed / total },
    rework,
    rateRetries,
    rejected: rounds.filter((round) => round.rejectionReason != null && round.rejectionReason !== '').length,
    accepted: rounds.filter((round) => round.status === 'accepted').length,
    succeeded,
    failed,
    failureKinds: kinds,
    resources,
    byNode: sortedGroups(byNode),
    byProvider: sortedGroups(byProvider),
    byModel: sortedGroups(byModel),
    top5ByDuration,
    top5ByCost,
    legacy,
  };
}

function pauseReasonOf(payload: string) {
  try {
    const parsed = JSON.parse(payload) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : null;
  } catch {
    return null;
  }
}

export async function dispatchStats(query: { from: string; to: string; projectId?: string | null }) {
  const parsed = parseStatsQuery(query);
  const projectId = parsed.projectId;
  const roundWhere: Prisma.OrchestrationWhereInput = { status: { not: 'draft' }, startedAt: { gte: parsed.from, lt: parsed.to }, ...(projectId ? { projectId } : {}) };
  const rounds = await prisma.orchestration.findMany({ where: roundWhere, include: { steps: true } });
  const roundIds = rounds.map((round) => round.id);
  const pauses = roundIds.length
    ? await prisma.orchestrationEvent.findMany({ where: { orchestrationId: { in: roundIds }, type: 'paused' }, select: { orchestrationId: true, seq: true, payload: true } })
    : [];
  const latestPause = new Map<string, { seq: number; reason: string | null }>();
  for (const event of pauses) {
    const previous = latestPause.get(event.orchestrationId);
    if (previous && previous.seq >= event.seq) continue;
    latestPause.set(event.orchestrationId, { seq: event.seq, reason: pauseReasonOf(event.payload) });
  }

  const projectOrchestrations = projectId
    ? await prisma.orchestration.findMany({ where: { projectId }, select: { id: true, taskId: true, projectId: true } })
    : [];
  const jobWhere: Prisma.NodeJobWhereInput = {
    kind: 'run',
    endedAt: { gte: parsed.from, lt: parsed.to },
    orchestrationId: projectId ? { in: projectOrchestrations.map((row) => row.id) } : { not: null },
  };
  const jobs = await prisma.nodeJob.findMany({ where: jobWhere, include: { node: { select: { id: true, name: true } } } });
  const jobOrchestrationIds = [...new Set(jobs.map((job) => job.orchestrationId).filter((id): id is string => !!id))];
  const jobOrchestrations = jobOrchestrationIds.length
    ? await prisma.orchestration.findMany({ where: { id: { in: jobOrchestrationIds } }, select: { id: true, taskId: true, projectId: true } })
    : [];
  const orchestrationById = new Map(jobOrchestrations.map((row) => [row.id, row]));
  const taskIds = [...new Set([...rounds.map((round) => round.taskId), ...jobOrchestrations.map((row) => row.taskId)])];
  const [tasks, projects, legacyRuns] = await Promise.all([
    taskIds.length ? prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true } }) : Promise.resolve([]),
    prisma.project.findMany({ select: { id: true, name: true } }),
    projectId ? Promise.resolve([]) : prisma.run.findMany({ where: { endedAt: { gte: parsed.from, lt: parsed.to } }, select: { id: true, startedAt: true, endedAt: true, inputTokens: true, cachedInputTokens: true, outputTokens: true, costMicroUsd: true } }),
  ]);
  const nodes = [...new Map(jobs.map((job) => [job.nodeId, { id: job.nodeId, name: job.node?.name || 'unknown' }])).values()];

  return aggregateDispatchStats({
    from: parsed.from,
    to: parsed.to,
    projectId,
    projects,
    tasks,
    nodes,
    legacyRuns,
    rounds: rounds.map((round) => ({
      id: round.id,
      taskId: round.taskId,
      projectId: round.projectId,
      status: round.status,
      startedAt: round.startedAt,
      rejectionReason: round.rejectionReason,
      pauseReason: round.pauseReason,
      latestPauseReason: latestPause.get(round.id)?.reason ?? round.pauseReason,
    })),
    steps: rounds.flatMap((round) => round.steps.map((step) => ({
      id: step.id,
      orchestrationId: step.orchestrationId,
      kind: step.kind,
      status: step.status,
      attempt: step.attempt,
      continueCount: step.continueCount,
      retryCount: step.retryCount,
      failureKind: step.failureKind,
      error: step.error,
    }))),
    jobs: jobs.map((job) => {
      const owner = job.orchestrationId ? orchestrationById.get(job.orchestrationId) : undefined;
      return {
        id: job.id,
        nodeId: job.nodeId,
        orchestrationId: job.orchestrationId,
        stepId: job.stepId,
        taskId: owner?.taskId ?? null,
        projectId: owner?.projectId ?? null,
        kind: job.kind,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        inputTokens: job.inputTokens,
        cachedInputTokens: job.cachedInputTokens,
        outputTokens: job.outputTokens,
        costMicroUsd: job.costMicroUsd,
        filesChanged: job.filesChanged,
        linesAdded: job.linesAdded,
        linesDeleted: job.linesDeleted,
        provider: job.provider,
        model: job.model,
      };
    }),
  });
}
