/** Read-only history for AI rounds. The server only reads the database; it never runs git or opens a worktree. */
import { prisma } from '../../infrastructure/prisma.js';

const CLIP = 2000;
const FEED_STATUSES = ['running', 'paused', 'awaiting_acceptance', 'accepted', 'rejected', 'cancelled', 'superseded'] as const;
const OPEN_FEED = ['running', 'paused', 'awaiting_acceptance'] as const;
const CHECK_TYPES = ['develop_check', 'merge_check', 'verify_check'] as const;
const EVENT_TYPES = ['ai_review', 'final_review', ...CHECK_TYPES, 'accepted', 'rejected'] as const;

export type HistoryQuery = { status?: string; projectId?: string; cursor?: string; limit?: number };

type Review = { decision: string; comment: string | null };
type Commit = { sha: string; subject: string };
type Check = { name: string; passed: boolean };

function asRecord(value: unknown): Record<string, unknown> | null {
  return !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}
function clip(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.length > CLIP ? value.slice(0, CLIP) : value;
}
function isNum(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
/** Null means the CLI did not report the figure. A sum of only nulls stays null; never treat null as zero. */
function sumNullable(values: Array<number | null | undefined>): number | null {
  const nums = values.filter(isNum);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) : null;
}
function durationMs(startedAt: string | null | undefined, endedAt: string | null | undefined): number | null {
  if (!startedAt || !endedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}
function providerOf(grantJson: string | null | undefined): string | null {
  const grant = asRecord(parseJson(grantJson));
  return typeof grant?.provider === 'string' ? grant.provider : null;
}
function snapshotOf(json: string | null | undefined) {
  const snap = asRecord(parseJson(json));
  const main = asRecord(snap?.main);
  const subtasks = new Map<string, string>();
  if (Array.isArray(snap?.subtasks)) {
    for (const item of snap.subtasks) {
      const row = asRecord(item);
      if (typeof row?.id === 'string' && typeof row.title === 'string') subtasks.set(row.id, row.title);
    }
  }
  return { mainTitle: typeof main?.title === 'string' ? main.title : null, subtasks };
}
function runBody(parsed: unknown): Record<string, unknown> | null {
  const root = asRecord(parsed);
  if (!root) return null;
  const inner = asRecord(root.result);
  if (inner && (inner.facts !== undefined || inner.result !== undefined)) return inner;
  return root;
}
function commitsOf(parsed: unknown): Commit[] {
  const facts = asRecord(runBody(parsed)?.facts);
  if (!Array.isArray(facts?.commits)) return [];
  const commits: Commit[] = [];
  for (const item of facts.commits) {
    const row = asRecord(item);
    if (!row || typeof row.sha !== 'string') continue;
    commits.push({ sha: row.sha, subject: typeof row.subject === 'string' ? row.subject : '' });
    if (commits.length === 5) break;
  }
  return commits;
}
function checksOf(parsed: unknown): Check[] {
  const result = asRecord(runBody(parsed)?.result);
  if (!Array.isArray(result?.checks)) return [];
  const checks: Check[] = [];
  for (const item of result.checks) {
    const row = asRecord(item);
    if (!row || typeof row.name !== 'string' || typeof row.passed !== 'boolean') continue;
    checks.push({ name: row.name, passed: row.passed });
  }
  return checks;
}
function shownJob(job: { kind: string; phase: string }) {
  if (job.kind === 'run' || job.kind === 'push' || job.kind === 'pull_request' || job.kind === 'publish') return true;
  return job.phase === 'publish';
}
function clampLimit(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 30;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

const jobSelect = {
  id: true, nodeId: true, orchestrationId: true, stepId: true, kind: true, phase: true, status: true, error: true,
  createdAt: true, startedAt: true, endedAt: true, exitCode: true, provider: true, cliVersion: true, model: true,
  inputTokens: true, cachedInputTokens: true, outputTokens: true, costMicroUsd: true, cliDurationMs: true, runDurationMs: true,
  filesChanged: true, linesAdded: true, linesDeleted: true, resultJson: true,
} as const;

type JobRow = {
  id: string; nodeId: string; orchestrationId: string | null; stepId: string | null; kind: string; phase: string; status: string; error: string | null;
  createdAt: string; startedAt: string | null; endedAt: string | null; exitCode: number | null; provider: string | null; cliVersion: string | null; model: string | null;
  inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; costMicroUsd: number | null; cliDurationMs: number | null; runDurationMs: number | null;
  filesChanged: number | null; linesAdded: number | null; linesDeleted: number | null; resultJson: string | null;
};
type EventRow = { orchestrationId: string; seq: number; type: string; stepId: string | null; payload: string };

function jobDto(job: JobRow, nodeName: string | null) {
  const parsed = parseJson(job.resultJson);
  return {
    id: job.id,
    phase: job.phase,
    status: job.status,
    nodeId: job.nodeId,
    nodeName,
    provider: job.provider,
    cliVersion: job.cliVersion,
    model: job.model,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    durationMs: durationMs(job.startedAt, job.endedAt),
    cliDurationMs: job.cliDurationMs,
    runDurationMs: job.runDurationMs,
    exitCode: job.exitCode,
    inputTokens: job.inputTokens,
    cachedInputTokens: job.cachedInputTokens,
    outputTokens: job.outputTokens,
    costMicroUsd: job.costMicroUsd,
    filesChanged: job.filesChanged,
    linesAdded: job.linesAdded,
    linesDeleted: job.linesDeleted,
    commits: commitsOf(parsed),
    checks: checksOf(parsed),
    error: clip(job.error),
  };
}

function reviewOf(events: EventRow[], stepId: string, kind: string): Review | null {
  const reviews = events.filter((event) => event.stepId === stepId && event.type === 'ai_review');
  const latest = reviews.length ? reviews[reviews.length - 1] : null;
  if (latest) {
    const value = asRecord(parseJson(latest.payload))?.value;
    if (value == null) return null;
    const row = asRecord(value);
    if (!row || typeof row.decision !== 'string') return null;
    return { decision: row.decision, comment: typeof row.comment === 'string' ? row.comment : null };
  }
  if (kind !== 'final') return null;
  const finals = events.filter((event) => event.stepId === stepId && event.type === 'final_review');
  const finalEvent = finals.length ? finals[finals.length - 1] : null;
  if (!finalEvent) return null;
  const value = asRecord(asRecord(parseJson(finalEvent.payload))?.value);
  if (!value || typeof value.satisfied !== 'boolean') return null;
  return { decision: value.satisfied ? 'satisfied' : 'unsatisfied', comment: typeof value.comment === 'string' ? value.comment : null };
}

function problemsOf(events: EventRow[], stepId: string): string[] | null {
  const checks = events.filter((event) => event.stepId === stepId && (CHECK_TYPES as readonly string[]).includes(event.type));
  const latest = checks.length ? checks[checks.length - 1] : null;
  if (!latest) return null;
  const problems = asRecord(parseJson(latest.payload))?.problems;
  if (!Array.isArray(problems)) return null;
  return problems.filter((item): item is string => typeof item === 'string');
}

function totalsOf(jobs: JobRow[], steps: Array<{ kind: string; continueCount: number; attempt: number; retryCount: number }>) {
  const runs = jobs.filter((job) => job.kind === 'run');
  const reworkSteps = steps.filter((step) => step.kind === 'develop' || step.kind === 'merge');
  return {
    durationMs: sumNullable(runs.map((job) => durationMs(job.startedAt, job.endedAt))),
    inputTokens: sumNullable(runs.map((job) => job.inputTokens)),
    outputTokens: sumNullable(runs.map((job) => job.outputTokens)),
    cachedInputTokens: sumNullable(runs.map((job) => job.cachedInputTokens)),
    costMicroUsd: sumNullable(runs.map((job) => job.costMicroUsd)),
    costJobs: runs.filter((job) => isNum(job.costMicroUsd)).length,
    jobs: runs.length,
    rework: reworkSteps.reduce((sum, step) => sum + step.continueCount + Math.max(0, step.attempt - 1), 0),
    rateRetries: reworkSteps.reduce((sum, step) => sum + step.retryCount, 0),
  };
}

export async function aiHistory(taskId: string) {
  const mainRows = await prisma.orchestration.findMany({
    where: { taskId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const mainIds = new Set(mainRows.map((row) => row.id));
  const subLinks = await prisma.orchestrationStep.findMany({
    where: { subtaskId: taskId, ...(mainIds.size ? { orchestrationId: { notIn: [...mainIds] } } : {}) },
    select: { orchestrationId: true },
  });
  const subIds = [...new Set(subLinks.map((row) => row.orchestrationId))];
  const subRows = subIds.length ? await prisma.orchestration.findMany({ where: { id: { in: subIds } } }) : [];
  const tagged = [
    ...mainRows.map((row) => ({ row, role: 'main' as const })),
    ...subRows.map((row) => ({ row, role: 'subtask' as const })),
  ].sort((a, b) => b.row.createdAt.localeCompare(a.row.createdAt) || b.row.id.localeCompare(a.row.id));
  const ids = tagged.map((item) => item.row.id);
  const [steps, jobs, events, handoffs] = await Promise.all([
    ids.length ? prisma.orchestrationStep.findMany({ where: { orchestrationId: { in: ids } }, orderBy: [{ position: 'asc' }, { id: 'asc' }] }) : Promise.resolve([]),
    ids.length ? prisma.nodeJob.findMany({ where: { orchestrationId: { in: ids }, stepId: { not: null } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: jobSelect }) : Promise.resolve([]),
    ids.length ? prisma.orchestrationEvent.findMany({ where: { orchestrationId: { in: ids }, type: { in: [...EVENT_TYPES] } }, orderBy: { seq: 'asc' }, select: { orchestrationId: true, seq: true, type: true, stepId: true, payload: true } }) : Promise.resolve([]),
    prisma.handoff.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, status: true, provider: true, mode: true, createdAt: true,
        runs: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true, status: true, provider: true, mode: true, createdAt: true, startedAt: true, endedAt: true, exitCode: true,
            cliVersion: true, model: true, inputTokens: true, cachedInputTokens: true, outputTokens: true, costMicroUsd: true,
            numTurns: true, cliDurationMs: true, runDurationMs: true, resultJson: true, error: true,
          },
        },
      },
    }),
  ]);
  const taskIds = new Set<string>([taskId, ...tagged.map((item) => item.row.taskId)]);
  for (const step of steps) if (step.subtaskId) taskIds.add(step.subtaskId);
  const nodeIds = new Set<string>();
  for (const row of tagged) if (row.row.nodeId) nodeIds.add(row.row.nodeId);
  for (const job of jobs) nodeIds.add(job.nodeId);
  const [tasks, nodes] = await Promise.all([
    prisma.task.findMany({ where: { id: { in: [...taskIds] } }, select: { id: true, title: true } }),
    nodeIds.size ? prisma.agentNode.findMany({ where: { id: { in: [...nodeIds] } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  const taskTitle = new Map(tasks.map((task) => [task.id, task.title]));
  const nodeName = new Map(nodes.map((node) => [node.id, node.name]));
  const stepsByOrchestration = new Map<string, typeof steps>();
  for (const step of steps) {
    const list = stepsByOrchestration.get(step.orchestrationId) ?? [];
    list.push(step);
    stepsByOrchestration.set(step.orchestrationId, list);
  }
  const jobsByStep = new Map<string, JobRow[]>();
  for (const job of jobs) {
    if (!job.stepId || !shownJob(job)) continue;
    const list = jobsByStep.get(job.stepId) ?? [];
    list.push(job);
    jobsByStep.set(job.stepId, list);
  }
  const eventsByOrchestration = new Map<string, EventRow[]>();
  for (const event of events) {
    const list = eventsByOrchestration.get(event.orchestrationId) ?? [];
    list.push(event);
    eventsByOrchestration.set(event.orchestrationId, list);
  }

  const rounds = tagged.map(({ row, role }) => {
    const snap = snapshotOf(row.taskSnapshotJson);
    const roundEvents = eventsByOrchestration.get(row.id) ?? [];
    const visible = (stepsByOrchestration.get(row.id) ?? []).filter((step) => role === 'main' || step.kind === 'final' || (step.subtaskId === taskId && (step.kind === 'develop' || step.kind === 'merge')));
    const visibleJobs = visible.flatMap((step) => jobsByStep.get(step.id) ?? []);
    const stepDtos = visible.map((step) => {
      const stepJobs = jobsByStep.get(step.id) ?? [];
      const runs = stepJobs.filter((job) => job.kind === 'run');
      const last = runs.length ? runs[runs.length - 1] : null;
      return {
        id: step.id,
        kind: step.kind,
        subtaskId: step.subtaskId,
        subtaskTitle: step.subtaskId ? snap.subtasks.get(step.subtaskId) ?? taskTitle.get(step.subtaskId) ?? null : null,
        status: step.status,
        attempt: step.attempt,
        continueCount: step.continueCount,
        retryCount: step.retryCount,
        resultCommit: step.resultCommit,
        mergeCommit: step.mergeCommit,
        error: clip(step.error),
        review: reviewOf(roundEvents, step.id, step.kind),
        checkProblems: problemsOf(roundEvents, step.id),
        filesChanged: last?.filesChanged ?? null,
        linesAdded: last?.linesAdded ?? null,
        linesDeleted: last?.linesDeleted ?? null,
        inputTokens: sumNullable(runs.map((job) => job.inputTokens)),
        outputTokens: sumNullable(runs.map((job) => job.outputTokens)),
        cachedInputTokens: sumNullable(runs.map((job) => job.cachedInputTokens)),
        costMicroUsd: sumNullable(runs.map((job) => job.costMicroUsd)),
        durationMs: sumNullable(runs.map((job) => durationMs(job.startedAt, job.endedAt))),
        jobs: stepJobs.map((job) => jobDto(job, nodeName.get(job.nodeId) ?? null)),
      };
    });
    return {
      id: row.id,
      taskId: row.taskId,
      taskTitle: taskTitle.get(row.taskId) ?? snap.mainTitle,
      role,
      round: row.round,
      status: row.status,
      pauseReason: row.pauseReason,
      finalComment: row.finalComment,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      acceptedAt: row.acceptedAt,
      provider: providerOf(row.grantJson),
      integrationBranch: row.integrationBranch,
      totals: totalsOf(visibleJobs, visible),
      userVerdicts: roundEvents.filter((event) => event.type === 'accepted' || event.type === 'rejected').map((event) => ({ type: event.type, payload: parseJson(event.payload) })),
      steps: stepDtos,
    };
  });

  const legacy = handoffs.map((handoff) => ({
    id: handoff.id,
    status: handoff.status,
    provider: handoff.provider,
    mode: handoff.mode,
    createdAt: handoff.createdAt,
    runs: handoff.runs.map((run) => {
      const summary = asRecord(parseJson(run.resultJson))?.summary;
      return {
        id: run.id,
        status: run.status,
        provider: run.provider,
        mode: run.mode,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        exitCode: run.exitCode,
        cliVersion: run.cliVersion,
        model: run.model,
        inputTokens: run.inputTokens,
        cachedInputTokens: run.cachedInputTokens,
        outputTokens: run.outputTokens,
        costMicroUsd: run.costMicroUsd,
        numTurns: run.numTurns,
        cliDurationMs: run.cliDurationMs,
        runDurationMs: run.runDurationMs,
        summary: typeof summary === 'string' ? clip(summary) : null,
        error: clip(run.error),
      };
    }),
  }));
  return { rounds, legacy };
}

function feedStatusWhere(status: string | undefined): { status: { not: string } | { in: string[] } | string } | null {
  const value = status?.trim();
  if (!value || value === 'all') return { status: { not: 'draft' } };
  if (value === 'open') return { status: { in: [...OPEN_FEED] } };
  if ((FEED_STATUSES as readonly string[]).includes(value)) return { status: value };
  return null;
}

export async function orchestrationFeed(query: HistoryQuery = {}) {
  const limit = clampLimit(query.limit);
  const statusWhere = feedStatusWhere(query.status);
  if (!statusWhere) return { items: [], nextCursor: null as string | null };
  const filters: Array<Record<string, unknown>> = [statusWhere];
  if (query.projectId) filters.push({ projectId: query.projectId });
  const cursor = query.cursor?.trim();
  if (cursor) {
    const sep = cursor.indexOf('|');
    const createdAt = sep > 0 ? cursor.slice(0, sep) : '';
    const id = sep > 0 ? cursor.slice(sep + 1) : '';
    if (!createdAt || !id) return { items: [], nextCursor: null as string | null };
    filters.push({ OR: [{ createdAt: { lt: createdAt } }, { AND: [{ createdAt }, { id: { lt: id } }] }] });
  }
  const rows = await prisma.orchestration.findMany({
    where: { AND: filters },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: { id: true, taskId: true, round: true, status: true, projectId: true, pauseReason: true, startedAt: true, endedAt: true, createdAt: true, nodeId: true, grantJson: true },
  });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit && page.length ? `${page[page.length - 1].createdAt}|${page[page.length - 1].id}` : null;
  const ids = page.map((row) => row.id);
  const taskIds = [...new Set(page.map((row) => row.taskId))];
  const projectIds = [...new Set(page.map((row) => row.projectId))];
  const nodeIds = [...new Set(page.map((row) => row.nodeId).filter((id): id is string => !!id))];
  const [tasks, projects, nodes, jobs] = await Promise.all([
    taskIds.length ? prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true } }) : Promise.resolve([]),
    projectIds.length ? prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    nodeIds.length ? prisma.agentNode.findMany({ where: { id: { in: nodeIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ids.length ? prisma.nodeJob.findMany({ where: { orchestrationId: { in: ids }, kind: 'run' }, select: { orchestrationId: true, inputTokens: true, cachedInputTokens: true, outputTokens: true, costMicroUsd: true, startedAt: true, endedAt: true } }) : Promise.resolve([]),
  ]);
  const taskTitle = new Map(tasks.map((task) => [task.id, task.title]));
  const projectName = new Map(projects.map((project) => [project.id, project.name]));
  const nodeName = new Map(nodes.map((node) => [node.id, node.name]));
  const jobsByOrchestration = new Map<string, typeof jobs>();
  for (const job of jobs) {
    if (!job.orchestrationId) continue;
    const list = jobsByOrchestration.get(job.orchestrationId) ?? [];
    list.push(job);
    jobsByOrchestration.set(job.orchestrationId, list);
  }
  const items = page.map((row) => {
    const runs = jobsByOrchestration.get(row.id) ?? [];
    return {
      id: row.id,
      taskId: row.taskId,
      taskTitle: taskTitle.get(row.taskId) ?? null,
      round: row.round,
      status: row.status,
      projectId: row.projectId,
      projectName: projectName.get(row.projectId) ?? null,
      pauseReason: row.pauseReason,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      provider: providerOf(row.grantJson),
      nodeName: row.nodeId ? nodeName.get(row.nodeId) ?? null : null,
      totals: {
        durationMs: sumNullable(runs.map((job) => durationMs(job.startedAt, job.endedAt))),
        inputTokens: sumNullable(runs.map((job) => job.inputTokens)),
        outputTokens: sumNullable(runs.map((job) => job.outputTokens)),
        cachedInputTokens: sumNullable(runs.map((job) => job.cachedInputTokens)),
        costMicroUsd: sumNullable(runs.map((job) => job.costMicroUsd)),
        costJobs: runs.filter((job) => isNum(job.costMicroUsd)).length,
        jobs: runs.length,
      },
    };
  });
  return { items, nextCursor };
}
