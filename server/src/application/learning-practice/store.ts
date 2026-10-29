import { randomUUID } from 'node:crypto';
import { Prisma, type LearningPracticeSession, type LearningPracticeItem, type LearningAnswerDraft, type LearningAttempt, type LearningGrade, type LearningJob, type LearningReviewItem } from '@prisma/client';
import { prisma } from '../../infrastructure/prisma.js';
import { DomainError } from '../../domain/task.js';
import { assertOwner, ownerActor, type Actor } from '../security.js';
import { commandDigest, runSerializedCommand } from '../commands.js';
import type { PracticeConfig, PracticeQuestionView, PracticeDraftView, PracticeAttemptView, PracticeGradeView, PracticeItemView, PracticeSessionView, PracticeJobView, PracticeReviewView, PracticeSummary, PracticeMutation } from '../../domain/learning-practice.js';
import type { FrozenQuestion, Candidate } from './input.js';
export type Db = Prisma.TransactionClient;
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const fail = (code: string, message: string, status = 409): never => {
  throw new DomainError(code, message, status);
};
export const json = <T>(raw: string): T => JSON.parse(raw) as T;
export function owner(actor: Actor) {
  assertOwner(actor);
  return actor.id;
}
export async function mutation<T extends object>(actor: Actor, requestId: string, operation: string, payload: unknown, run: (tx: Db) => Promise<T>): Promise<PracticeMutation<T>> {
  const ownerId = owner(actor), requestHash = commandDigest({ operation, payload });
  return runSerializedCommand(async (tx) => {
    const existing = await tx.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: ownerId, requestId } } });
    if (existing) {
      if (existing.requestHash !== requestHash)
        fail('IDEMPOTENCY_CONFLICT', '相同请求标识不能提交不同内容');
      return json<{
        result: PracticeMutation<T>;
      }>(existing.response).result;
    }
    const result = { status: 'applied' as const, requestId, ...await run(tx) };
    await tx.requestReceipt.create({ data: { actorId: ownerId, requestId, requestHash, response: JSON.stringify({ result, scopeRevision: actor.revision }), createdAt: now() } });
    return result;
  });
}
export async function requireMap(tx: Db, mapId: string) {
  const row = await tx.learningMap.findUnique({ where: { id: mapId } });
  if (!row || row.deletedAt)
    fail('NOT_FOUND', '学习主题不存在或已归档', 404);
  return row!;
}
export async function requireNode(tx: Db, nodeId: string, mapId?: string) {
  const row = await tx.learningNode.findUnique({ where: { id: nodeId } });
  if (!row || row.deletedAt || row.kind !== 'item' || mapId && row.mapId !== mapId)
    fail('NOT_FOUND', '知识点不存在或不属于该主题', 404);
  await requireMap(tx, row!.mapId);
  return row!;
}
export async function requireSession(tx: Db, sessionId: string, ownerId: string, writable = false) {
  const row = await tx.learningPracticeSession.findUnique({ where: { id: sessionId } });
  if (!row || row.ownerId !== ownerId)
    fail('NOT_FOUND', '练习不存在', 404);
  if (writable) {
    if (row!.state === 'finished')
      fail('SESSION_FINISHED', '本轮已结束，请开始新一轮');
    await requireMap(tx, row!.mapId);
  }
  return row!;
}
export async function requireItem(tx: Db, itemId: string, ownerId: string, writable = false) {
  const item = await tx.learningPracticeItem.findUnique({ where: { id: itemId } });
  if (!item)
    fail('NOT_FOUND', '题目不存在', 404);
  const session = await requireSession(tx, item!.sessionId, ownerId, writable);
  const version = await tx.learningQuestionVersion.findUnique({ where: { id: item!.questionVersionId } });
  if (!version)
    fail('NOT_FOUND', '题目版本不存在', 404);
  if (writable) {
    await requireNode(tx, version!.nodeId, session.mapId);
    const question = await tx.learningQuestion.findUnique({ where: { id: version!.questionId } });
    if (!question || question.archived)
      fail('QUESTION_UNAVAILABLE', '此题已停用，历史答案仍保留');
  }
  const draft = await tx.learningAnswerDraft.findUniqueOrThrow({ where: { itemId } });
  return { item: item!, session, version: version!, question: json<FrozenQuestion>(version!.contentJson), draft };
}
export function assertDraft(draft: LearningAnswerDraft, activeAttemptId: string, revision: number) {
  if (draft.activeAttemptId !== activeAttemptId || draft.revision !== revision)
    fail('VERSION_CONFLICT', '答案草稿已在其他位置更新，请比较后继续');
  if (draft.submitted)
    fail('ATTEMPT_SUBMITTED', '该次答案已经提交；重做会建立新的尝试');
}
export function draftView(d: LearningAnswerDraft): PracticeDraftView {
  return { id: d.id, itemId: d.itemId, activeAttemptId: d.activeAttemptId, attemptNo: d.attemptNo, answer: json(d.answerJson), revision: d.revision, submitted: d.submitted, updatedAt: d.updatedAt };
}
export function gradeView(g: LearningGrade): PracticeGradeView {
  return { id: g.id, attemptId: g.attemptId, version: g.version, method: g.method as PracticeGradeView['method'], state: g.state as PracticeGradeView['state'], result: g.result as PracticeGradeView['result'], score: g.score, maxScore: g.maxScore, explanation: g.explanation, strengths: g.strengths, mistakes: json(g.mistakesJson), model: g.model, promptVersion: g.promptVersion, createdAt: g.createdAt };
}
/** Batch an already-authorized page without materializing its complete grade history. */
export async function attemptViews(tx: Db, attempts: readonly LearningAttempt[]): Promise<PracticeAttemptView[]> {
  const result: PracticeAttemptView[] = [];
  for (let offset = 0; offset < attempts.length; offset += 100) {
    const batch = attempts.slice(offset, offset + 100);
    const rows = await tx.$queryRaw<LearningGrade[]>(Prisma.sql`
      SELECT ranked.* FROM (
        SELECT g.*, ROW_NUMBER() OVER (PARTITION BY g.attemptId ORDER BY g.version DESC) AS ordinal
        FROM learning_grades g WHERE g.attemptId IN (${Prisma.join(batch.map(a => a.id))})
      ) ranked WHERE ordinal <= 6`);
    const byAttempt = new Map<string, LearningGrade[]>();
    const byId = new Map(rows.map(g => [g.id, g]));
    for (const grade of rows) {
      const group = byAttempt.get(grade.attemptId) ?? [];
      group.push(grade); byAttempt.set(grade.attemptId, group);
    }
    const missing = [...new Set(batch.flatMap(a => a.currentGradeId && !byId.has(a.currentGradeId) ? [a.currentGradeId] : []))];
    if (missing.length) {
      const currentRows = await tx.learningGrade.findMany({ where: { id: { in: missing }, attemptId: { in: batch.map(a => a.id) } } });
      for (const grade of currentRows) byId.set(grade.id, grade);
    }
    for (const a of batch) {
      const gradesForAttempt = (byAttempt.get(a.id) ?? []).sort((left, right) => right.version - left.version);
      const grades = gradesForAttempt.slice(0, 5).reverse();
      const pointed = a.currentGradeId ? byId.get(a.currentGradeId) : null;
      // A corrupt cross-attempt pointer must not disclose another answer's grade.
      const current = pointed?.attemptId === a.id ? pointed : null;
      result.push({ id: a.id, itemId: a.itemId, attemptNo: a.attemptNo, answer: json(a.answerJson), submittedAt: a.submittedAt, assisted: a.assisted, solutionViewed: a.solutionViewed, assistanceUncertain: a.assistanceUncertain, gradingVersion: a.gradingVersion, gradingState: a.gradingState as PracticeAttemptView['gradingState'], grade: current ? gradeView(current) : null, grades: grades.map(gradeView), gradesNextCursor: gradesForAttempt.length > 5 ? String(grades[0].version) : null, error: a.error });
    }
  }
  return result;
}
export async function attemptView(tx: Db, a: LearningAttempt): Promise<PracticeAttemptView> {
  return (await attemptViews(tx, [a]))[0];
}
/** Read exposure facts without loading a potentially long event log. */
export async function itemExposure(tx: Db, itemId: string) {
  const [facts] = await tx.$queryRaw<Array<{ hintCount: number; assisted: number; solutionViewed: number }>>(Prisma.sql`
    SELECT COALESCE(MAX(CASE WHEN type = 'hint' THEN CAST(json_extract("payloadJson", '$.level') AS INTEGER) ELSE 0 END), 0) AS "hintCount",
      COALESCE(MAX(type IN ('hint', 'assistance_delivered', 'assistance_solution', 'prior_feedback')), 0) AS assisted,
      COALESCE(MAX(type IN ('solution', 'assistance_solution')), 0) AS "solutionViewed"
    FROM learning_practice_events WHERE "itemId" = ${itemId}`);
  return { hintCount: Number(facts.hintCount), assistance: Boolean(facts.assisted), solutionViewed: Boolean(facts.solutionViewed) };
}
export function questionView(q: FrozenQuestion, versionId: string, questionId: string, archived = false, retired = false): PracticeQuestionView {
  return { id: questionId, versionId, nodeId: q.nodeId, type: q.type, prompt: q.prompt, options: q.options, difficulty: q.difficulty, objective: q.objective, source: q.source, ...(q.variantOfQuestionVersionId ? { variantOfQuestionVersionId: q.variantOfQuestionVersionId } : {}), archived, retired };
}
/** A fixed practice session shares bounded source/grade/exposure reads across its items. */
export async function itemViews(tx: Db, items: readonly LearningPracticeItem[]): Promise<PracticeItemView[]> {
  const result: PracticeItemView[] = [];
  for (let offset = 0; offset < items.length; offset += 20) {
    const batch = items.slice(offset, offset + 20);
    const itemIds = batch.map(item => item.id);
    const [versions, drafts, selected, facts] = await Promise.all([
      tx.learningQuestionVersion.findMany({ where: { id: { in: batch.map(item => item.questionVersionId) } } }),
      tx.learningAnswerDraft.findMany({ where: { itemId: { in: itemIds } } }),
      tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM (SELECT a.id, ROW_NUMBER() OVER (PARTITION BY a.itemId ORDER BY a.attemptNo DESC) AS ordinal
          FROM learning_attempts a WHERE a.itemId IN (${Prisma.join(itemIds)})) WHERE ordinal <= 6`),
      tx.$queryRaw<Array<{ itemId: string; hintCount: number; assisted: number; solutionViewed: number }>>(Prisma.sql`
        SELECT itemId, MAX(CASE WHEN type = 'hint' THEN CAST(json_extract(payloadJson, '$.level') AS INTEGER) ELSE 0 END) AS hintCount,
          MAX(type IN ('hint', 'assistance_delivered', 'assistance_solution', 'prior_feedback')) AS assisted,
          MAX(type IN ('solution', 'assistance_solution')) AS solutionViewed
        FROM learning_practice_events WHERE itemId IN (${Prisma.join(itemIds)}) GROUP BY itemId`),
    ]);
    const [questions, nodes, attempts] = await Promise.all([
      tx.learningQuestion.findMany({ where: { id: { in: versions.map(v => v.questionId) } } }),
      tx.learningNode.findMany({ where: { id: { in: versions.map(v => v.nodeId) } } }),
      selected.length ? tx.learningAttempt.findMany({ where: { id: { in: selected.map(a => a.id) } } }) : Promise.resolve([]),
    ]);
    const byItem = new Map<string, LearningAttempt[]>();
    for (const attempt of attempts) {
      const group = byItem.get(attempt.itemId) ?? [];
      group.push(attempt); byItem.set(attempt.itemId, group);
    }
    for (const group of byItem.values()) group.sort((a, b) => b.attemptNo - a.attemptNo);
    const views = new Map((await attemptViews(tx, [...byItem.values()].flatMap(group => group.slice(0, 5)))).map(view => [view.id, view]));
    const versionById = new Map(versions.map(v => [v.id, v]));
    const questionById = new Map(questions.map(q => [q.id, q]));
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const draftByItem = new Map(drafts.map(d => [d.itemId, d]));
    const factsByItem = new Map(facts.map(f => [f.itemId, f]));
    for (const item of batch) {
      const version = versionById.get(item.questionVersionId);
      if (!version) fail('NOT_FOUND', '题目版本不存在', 404);
      const draft = draftByItem.get(item.id);
      if (!draft) fail('NOT_FOUND', '题目不存在', 404);
      const q = json<FrozenQuestion>(version!.contentJson), question = questionById.get(version!.questionId), node = nodeById.get(version!.nodeId);
      const exposure = factsByItem.get(item.id), hintCount = Number(exposure?.hintCount ?? 0), solutionViewed = Boolean(exposure?.solutionViewed);
      const attemptRows = byItem.get(item.id) ?? [];
      result.push({ id: item.id, sessionId: item.sessionId, position: item.position,
        question: questionView(q, version!.id, version!.questionId, !question || question.archived || !node || Boolean(node.deletedAt), Boolean(question?.archived)),
        draft: draftView(draft!), attempts: attemptRows.slice(0, 5).reverse().map(a => views.get(a.id)!), attemptsNextCursor: attemptRows.length > 5 ? '5' : null,
        skipped: item.skipped, hintCount, assistance: Boolean(exposure?.assisted), solutionViewed, selectionReason: item.selectionReason, hints: q.hints.slice(0, hintCount),
        ...(solutionViewed ? { solution: { answer: q.answer, explanation: q.explanation, rubric: q.rubric } } : {}) });
    }
  }
  return result;
}
export async function itemView(tx: Db, item: LearningPracticeItem): Promise<PracticeItemView> {
  return (await itemViews(tx, [item]))[0];
}
export function summarize(items: PracticeItemView[]): PracticeSummary {
  const summary: PracticeSummary = { total: items.length, invalid: 0, answered: 0, skipped: 0, pending: 0, correct: 0, independentCorrect: 0, assistedCorrect: 0, partial: 0, incorrect: 0, unresolved: 0 };
  for (const item of items) {
    const a = item.attempts.at(-1);
    if (item.question.retired) {
      summary.invalid!++;
      if (a) summary.answered++;
      continue;
    }
    if (!a) {
      if (item.skipped)
        summary.skipped++;
      continue;
    }
    summary.answered++;
    if (['queued', 'running', 'failed'].includes(a.gradingState)) {
      summary.pending++;
      continue;
    }
    if (a.gradingState === 'needs_review' || !a.grade || a.grade.result === 'unresolved') {
      summary.unresolved++;
      continue;
    }
    if (a.grade.result === 'correct') {
      summary.correct++;
      if (a.assisted || a.solutionViewed || a.assistanceUncertain)
        summary.assistedCorrect++;
      else
        summary.independentCorrect++;
    }
    else if (a.grade.result === 'partial')
      summary.partial++;
    else
      summary.incorrect++;
  }
  return summary;
}
export async function sessionView(tx: Db, s: LearningPracticeSession): Promise<PracticeSessionView> {
  const rows = await tx.learningPracticeItem.findMany({ where: { sessionId: s.id }, orderBy: { position: 'asc' } });
  const items = await itemViews(tx, rows);
  const map = await tx.learningMap.findUnique({ where: { id: s.mapId } });
  return { id: s.id, mapId: s.mapId, mapTitle: s.mapTitle, ownerId: s.ownerId, mode: s.mode as PracticeSessionView['mode'], state: s.state as PracticeSessionView['state'], currentPosition: s.currentPosition, revision: s.revision, config: json(s.configJson), items, summary: summarize(items), createdAt: s.createdAt, updatedAt: s.updatedAt, finishedAt: s.finishedAt, archived: !map || Boolean(map.deletedAt) };
}
export function jobView(j: LearningJob): PracticeJobView {
  const output = j.kind === 'generate' && j.state === 'succeeded' && j.outputJson ? json<Candidate>(j.outputJson) : null;
  const input = json<{
    config: PracticeConfig;
  }>(j.inputJson);
  return { id: j.id, kind: j.kind as PracticeJobView['kind'], state: j.state as PracticeJobView['state'], mapId: j.mapId, sessionId: j.sessionId, attemptId: j.attemptId, retries: j.retries, error: j.error, createdAt: j.createdAt, updatedAt: j.updatedAt, candidateRevision: j.candidateRevision, candidate: output ? { title: output.title, config: input.config, questions: output.questions.map((q, index) => questionView(q, `candidate:${j.id}:${index}`, `candidate:${index}`)) } : null, adoptedSessionId: j.adoptedSessionId };
}
export function reviewView(r: LearningReviewItem): PracticeReviewView {
  return { id: r.id, mapId: r.mapId, nodeId: r.nodeId, questionId: r.questionId, title: r.title, reasons: json(r.reasonsJson), dueAt: r.dueAt, paused: r.paused, revision: r.revision, policy: r.policy as PracticeReviewView['policy'], policyVersion: r.policyVersion, manualSchedule: r.manualSchedule, lastAttemptId: r.lastAttemptId, lastGradeId: r.lastGradeId, streak: r.streak, updatedAt: r.updatedAt };
}
export { prisma, ownerActor, commandDigest, runSerializedCommand };
