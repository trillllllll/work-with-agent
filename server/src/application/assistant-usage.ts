/**
 * Built-in assistant chat usage, shared by the stats overview section and the
 * dispatch stats assistant block. Runs bucket by `updatedAt` (half-open), so a
 * turn still in flight lands in the window it finishes in. Tokens come from the
 * run's stored columns; a request the provider reported no usage for counts as
 * a request with zero tokens, not a missing one.
 */
import { prisma } from '../infrastructure/prisma.js';
import { assertTimeZone, calendarFormatter, localCalendarDate } from './reviews-clock.js';

export type AssistantUsageRun = {
  id: string;
  conversationId: string;
  identityId: string;
  model: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  createdAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export type AssistantUsageGroup = {
  key: string;
  runs: number;
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type AssistantUsageTotals = {
  runs: number;
  runsWithUsage: number;
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type AssistantUsageDay = { date: string; runs: number; inputTokens: number; outputTokens: number };

export type AssistantUsage = {
  totals: AssistantUsageTotals;
  byIdentity: AssistantUsageGroup[];
  byModel: AssistantUsageGroup[];
  byDay: AssistantUsageDay[];
};

export type AssistantUsageConversation = {
  conversationId: string;
  title: string | null;
  identityId: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
};

export type AssistantMemoryJobs = { jobs: number; failed: number; inputTokens: number; outputTokens: number; totalTokens: number };

/** Every run last touched in `[from, to)`, with its conversation identity. Runs are cheap rows; callers aggregate in memory. */
export async function loadAssistantRuns(range: { from: string; to: string }): Promise<AssistantUsageRun[]> {
  const rows = await prisma.agentRun.findMany({
    where: { updatedAt: { gte: range.from, lt: range.to } },
    select: {
      id: true,
      conversationId: true,
      model: true,
      inputTokens: true,
      cachedInputTokens: true,
      outputTokens: true,
      createdAt: true,
      completedAt: true,
      updatedAt: true,
      conversation: { select: { identityId: true } },
    },
  });
  return rows.map((row) => ({ ...row, identityId: row.conversation?.identityId || 'work' }));
}

function inRange(value: string | null | undefined, fromMs: number, toMs: number) {
  if (!value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= fromMs && ms < toMs;
}

function runDuration(run: Pick<AssistantUsageRun, 'createdAt' | 'completedAt' | 'updatedAt'>) {
  const start = run.createdAt ? Date.parse(run.createdAt) : Number.NaN;
  const end = Date.parse(run.completedAt ?? run.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start;
}

const emptyGroup = (key: string): AssistantUsageGroup => ({ key, runs: 0, durationMs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });

function sortedGroups(groups: Map<string, AssistantUsageGroup>) {
  return [...groups.values()].sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));
}

export function aggregateAssistantUsage(runs: readonly AssistantUsageRun[], range: { fromMs: number; toMs: number; tz?: string | null }): AssistantUsage {
  const tz = range.tz?.trim() || 'UTC';
  if (range.tz?.trim()) assertTimeZone(range.tz);
  const format = calendarFormatter(tz);
  const totals: AssistantUsageTotals = { runs: 0, runsWithUsage: 0, durationMs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  const byIdentity = new Map<string, AssistantUsageGroup>();
  const byModel = new Map<string, AssistantUsageGroup>();
  const byDay = new Map<string, AssistantUsageDay>();
  for (const run of runs) {
    if (!inRange(run.updatedAt, range.fromMs, range.toMs)) continue;
    const input = run.inputTokens ?? 0;
    const cached = run.cachedInputTokens ?? 0;
    const output = run.outputTokens ?? 0;
    const duration = runDuration(run);
    totals.runs += 1;
    if (run.inputTokens != null || run.outputTokens != null) totals.runsWithUsage += 1;
    totals.durationMs += duration;
    totals.inputTokens += input;
    totals.cachedInputTokens += cached;
    totals.outputTokens += output;
    // A run without usage or model stays out of `byModel` (it would only add a
    // junk "unknown" row); it still counts above and in its identity group.
    const groups: Array<[Map<string, AssistantUsageGroup>, string]> = [[byIdentity, run.identityId || 'work']];
    if (run.inputTokens != null || run.outputTokens != null || run.model) groups.push([byModel, run.model || 'unknown']);
    for (const [map, key] of groups) {
      const group = map.get(key) ?? emptyGroup(key);
      group.runs += 1;
      group.durationMs += duration;
      group.inputTokens += input;
      group.cachedInputTokens += cached;
      group.outputTokens += output;
      map.set(key, group);
    }
    const date = localCalendarDate(new Date(Date.parse(run.updatedAt)), tz, format);
    const bucket = byDay.get(date) ?? { date, runs: 0, inputTokens: 0, outputTokens: 0 };
    bucket.runs += 1;
    bucket.inputTokens += input;
    bucket.outputTokens += output;
    byDay.set(date, bucket);
  }
  return { totals, byIdentity: sortedGroups(byIdentity), byModel: sortedGroups(byModel), byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

/** Top conversations by input+output tokens. The title is the first user message, trimmed to 40 characters. */
export async function loadAssistantTopConversations(runs: readonly AssistantUsageRun[], limit = 5): Promise<AssistantUsageConversation[]> {
  const totals = new Map<string, AssistantUsageConversation>();
  for (const run of runs) {
    const row = totals.get(run.conversationId) ?? { conversationId: run.conversationId, title: null, identityId: run.identityId, runs: 0, inputTokens: 0, outputTokens: 0 };
    row.runs += 1;
    row.inputTokens += run.inputTokens ?? 0;
    row.outputTokens += run.outputTokens ?? 0;
    totals.set(run.conversationId, row);
  }
  const top = [...totals.values()]
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || a.conversationId.localeCompare(b.conversationId))
    .slice(0, limit);
  await Promise.all(top.map(async (row) => {
    const first = await prisma.message.findFirst({
      where: { conversationId: row.conversationId, role: 'user' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { content: true },
    });
    const title = first?.content.replace(/\s+/g, ' ').trim().slice(0, 40);
    row.title = title || null;
  }));
  return top;
}

/** Background memory-extraction jobs (work identity only). Kept separate from chat tokens on purpose. */
export async function loadAssistantMemoryJobs(range: { from: string; to: string }): Promise<AssistantMemoryJobs> {
  const where = { createdAt: { gte: range.from, lt: range.to } };
  const [aggregate, failed] = await Promise.all([
    prisma.autoMemoryJob.aggregate({ where, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, totalTokens: true } }),
    prisma.autoMemoryJob.count({ where: { ...where, status: 'failed' } }),
  ]);
  return {
    jobs: aggregate._count._all,
    failed,
    inputTokens: aggregate._sum.inputTokens ?? 0,
    outputTokens: aggregate._sum.outputTokens ?? 0,
    totalTokens: aggregate._sum.totalTokens ?? 0,
  };
}
