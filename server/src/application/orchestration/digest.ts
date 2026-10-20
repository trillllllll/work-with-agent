/** Prior-round digest for the planner and local prompts. Pure formatting plus a database read. No git, no local files. */
import { prisma } from '../../infrastructure/prisma.js';

const FIELD_MAX = 500;
const ROUND_MAX = 2000;
const TOTAL_MAX = 4000;

export type DigestStep = {
  kind: string;
  subtaskTitle: string | null;
  status: string;
  attempt: number;
  continueCount: number;
  pauseReason?: string | null;
  failureKind?: string | null;
  error: string | null;
  review?: string | null;
  problems?: string[];
};

export type DigestRound = {
  round: number;
  status: string;
  finalComment: string | null;
  rejectionReason: string | null;
  acceptanceNote: string | null;
  steps: DigestStep[];
};

function clip(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length <= FIELD_MAX ? value : value.slice(0, FIELD_MAX);
}

function reworked(step: DigestStep) {
  return step.status === 'needs_user' || step.status === 'failed' || step.continueCount > 0 || step.attempt > 1;
}

function compactStep(step: DigestStep) {
  const value: Record<string, unknown> = {
    kind: clip(step.kind) ?? step.kind,
    status: step.status,
    attempt: step.attempt,
    continueCount: step.continueCount,
  };
  const subtaskTitle = clip(step.subtaskTitle);
  const pauseReason = clip(step.pauseReason);
  const failureKind = clip(step.failureKind);
  const error = clip(step.error);
  const review = clip(step.review);
  const problems = (step.problems ?? []).map((item) => clip(item)).filter((item): item is string => !!item).slice(0, 3);
  if (subtaskTitle) value.subtaskTitle = subtaskTitle;
  if (pauseReason) value.pauseReason = pauseReason;
  if (failureKind) value.failureKind = failureKind;
  if (error) value.error = error;
  if (review) value.review = review;
  if (problems.length) value.problems = problems;
  return value;
}

function renderRound(round: DigestRound, opts?: { subtaskTitle?: string }): string | null {
  const title = opts?.subtaskTitle;
  const steps = round.steps.filter((step) => (!title || step.subtaskTitle === title) && reworked(step)).map(compactStep);
  const rejectionReason = clip(round.rejectionReason);
  const finalComment = clip(round.finalComment);
  const acceptanceNote = title ? null : clip(round.acceptanceNote);
  if (!steps.length && !rejectionReason && !finalComment && !acceptanceNote) return null;
  const head: Record<string, unknown> = { round: round.round, status: round.status };
  if (rejectionReason) head.rejectionReason = rejectionReason;
  if (finalComment) head.finalComment = finalComment;
  if (acceptanceNote) head.acceptanceNote = acceptanceNote;
  const emit = (list: Array<Record<string, unknown>>) => JSON.stringify(list.length ? { ...head, steps: list } : head);
  let kept = steps;
  let text = emit(kept);
  while (text.length > ROUND_MAX && kept.length) {
    kept = kept.slice(0, -1);
    text = emit(kept);
  }
  if (text.length > ROUND_MAX) text = text.slice(0, ROUND_MAX);
  return text;
}

/** Two most recent rounds, failing or reworked steps only. Empty when there is nothing to carry forward. */
export function priorRoundDigest(rounds: DigestRound[], opts?: { subtaskTitle?: string }): string {
  const selected = [...rounds].sort((a, b) => b.round - a.round).slice(0, 2);
  const parts: string[] = [];
  let used = 0;
  for (const round of selected) {
    const text = renderRound(round, opts);
    if (!text) continue;
    const sep = parts.length ? 1 : 0;
    const room = TOTAL_MAX - used - sep;
    if (room <= 0) break;
    const chunk = text.length > room ? text.slice(0, room) : text;
    parts.push(chunk);
    used += sep + chunk.length;
  }
  return parts.join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function titlesOf(json: string) {
  const map = new Map<string, string>();
  try {
    const parsed = JSON.parse(json) as { subtasks?: Array<{ id?: string; title?: string }> };
    for (const item of parsed.subtasks ?? []) {
      if (item && typeof item.id === 'string' && typeof item.title === 'string') map.set(item.id, item.title);
    }
  } catch { /* a bad snapshot contributes no titles */ }
  return map;
}

function reviewComment(payload: Record<string, unknown>): string | null {
  const value = asRecord(payload.value);
  return typeof value?.comment === 'string' && value.comment ? value.comment : null;
}

function problemList(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.problems)) return [];
  return payload.problems.filter((item): item is string => typeof item === 'string').slice(0, 3);
}

/** Non-draft rounds for a task, excluding the round currently being planned or dispatched. */
export async function loadPriorRounds(taskId: string, excludeId?: string): Promise<DigestRound[]> {
  const rows = await prisma.orchestration.findMany({
    where: { taskId, status: { not: 'draft' }, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    include: { steps: { orderBy: { position: 'asc' } } },
    orderBy: { round: 'desc' },
  });
  if (!rows.length) return [];
  const events = await prisma.orchestrationEvent.findMany({
    where: {
      orchestrationId: { in: rows.map((row) => row.id) },
      OR: [{ type: 'paused' }, { type: 'ai_review' }, { type: { endsWith: '_check' } }],
    },
    orderBy: [{ seq: 'asc' }],
  });
  const review = new Map<string, string | null>();
  const problems = new Map<string, string[]>();
  const pauseReason = new Map<string, string>();
  for (const event of events) {
    let payload: Record<string, unknown> | null = null;
    try { payload = asRecord(JSON.parse(event.payload)); } catch { payload = null; }
    if (!payload) continue;
    if (event.type === 'paused' && typeof payload.reason === 'string' && payload.reason) pauseReason.set(event.orchestrationId, payload.reason);
    if (!event.stepId) continue;
    if (event.type === 'ai_review') review.set(event.stepId, reviewComment(payload));
    if (event.type.endsWith('_check')) problems.set(event.stepId, problemList(payload));
  }
  return rows.map((row) => {
    const titles = titlesOf(row.taskSnapshotJson);
    const paused = pauseReason.get(row.id);
    return {
      round: row.round,
      status: row.status,
      finalComment: row.finalComment,
      rejectionReason: row.rejectionReason,
      acceptanceNote: row.acceptanceNote,
      steps: row.steps.map((step) => ({
        kind: step.kind,
        subtaskTitle: step.subtaskId ? titles.get(step.subtaskId) ?? null : null,
        status: step.status,
        attempt: step.attempt,
        continueCount: step.continueCount,
        ...(paused && (step.status === 'needs_user' || step.status === 'failed') ? { pauseReason: paused } : {}),
        error: step.error,
        review: review.get(step.id) ?? null,
        problems: problems.get(step.id) ?? [],
      })),
    };
  });
}
