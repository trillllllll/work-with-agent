import { Prisma, type LearningReviewItem } from '@prisma/client';
import { now, id, json, reviewView, type Db } from './store.js';

type Evidence = {
  attemptId: string; submittedAt: string; gradingState: string; gradingVersion: number;
  gradeId: string | null; gradeState: string | null; result: string | null; streak: bigint | number;
};

/** Aggregate the complete history in SQLite; no unbounded attempt/grade arrays in memory. */
async function evidence(tx: Db, ownerId: string, scope: Prisma.Sql): Promise<Evidence | null> {
  const rows = await tx.$queryRaw<Evidence[]>(Prisma.sql`
    WITH ordered AS (
      SELECT a.id AS attemptId, a.submittedAt, a.gradingState, a.gradingVersion,
        g.id AS gradeId, g.state AS gradeState, g.result,
        ROW_NUMBER() OVER (ORDER BY a.submittedAt DESC, a.id DESC) AS ordinal,
        CASE WHEN a.gradingState = 'succeeded' AND g.state = 'succeeded' AND g.result = 'correct'
          AND a.assisted = 0 AND a.solutionViewed = 0 AND a.assistanceUncertain = 0 THEN 1 ELSE 0 END AS independent
      FROM learning_attempts a
      JOIN learning_question_versions v ON v.id = a.questionVersionId
      JOIN learning_questions q ON q.id = v.questionId AND q.archived = 0
      LEFT JOIN learning_grades g ON g.id = a.currentGradeId
      WHERE a.ownerId = ${ownerId} AND ${scope}
    )
    SELECT attemptId, submittedAt, gradingState, gradingVersion, gradeId, gradeState, result,
      COALESCE((SELECT MIN(ordinal) - 1 FROM ordered WHERE independent = 0),
        (SELECT COUNT(*) FROM ordered)) AS streak
    FROM ordered WHERE ordinal = 1
  `);
  return rows[0] ?? null;
}

async function project(tx: Db, row: LearningReviewItem, latest: Evidence | null, eventKey: string) {
  if (await tx.learningReviewEvent.findUnique({ where: { eventKey } })) return;
  const effective = latest?.gradeState === 'succeeded' && latest.gradingState === 'succeeded';
  const wrong = effective && ['incorrect', 'partial'].includes(latest!.result!);
  const before = reviewView(row);
  const reasons = json<string[]>(row.reasonsJson).filter(reason => !['incorrect', 'partial', 'needs_review'].includes(reason));
  if (wrong) reasons.push(latest!.result!);
  else if (latest && (latest.gradingState === 'needs_review' || latest.gradeState === 'needs_review'
    || latest.gradingVersion > 1 && ['queued', 'running', 'failed'].includes(latest.gradingState))) reasons.push('needs_review');
  const streak = Number(latest?.streak ?? 0);
  let dueAt = !latest && !row.manualSchedule ? null : row.dueAt;
  if (!latest) {
    const scheduled = reasons.indexOf('scheduled');
    if (scheduled >= 0) reasons.splice(scheduled, 1);
  }
  if (!row.paused && !row.manualSchedule && row.policy === 'spaced-v1' && effective) {
    const days = wrong ? 1 : Math.min(30, 2 ** Math.min(streak, 5));
    dueAt = new Date(Date.parse(latest!.submittedAt) + days * 86400000).toISOString();
    if (!reasons.includes('scheduled')) reasons.push('scheduled');
  }
  const updated = await tx.learningReviewItem.update({
    where: { id: row.id, revision: row.revision },
    data: { reasonsJson: JSON.stringify([...new Set(reasons)]), dueAt, streak,
      lastAttemptId: latest?.attemptId ?? null, lastGradeId: effective ? latest!.gradeId : null,
      revision: { increment: 1 }, updatedAt: now() },
  });
  await tx.learningReviewEvent.create({ data: { id: id(), reviewId: row.id, eventKey, kind: 'evidence',
    beforeJson: JSON.stringify(before), afterJson: JSON.stringify(reviewView(updated)),
    attemptId: latest?.attemptId ?? null, gradeId: effective ? latest!.gradeId : null, createdAt: now() } });
}

/** Corrected grades recompute both original-question evidence and an explicitly enabled node arrangement. */
export async function refreshReviewForQuestion(tx: Db, ownerId: string, questionId: string, eventKey: string) {
  const question = await tx.learningQuestion.findUnique({ where: { id: questionId } });
  if (!question) return;
  const latest = await evidence(tx, ownerId, Prisma.sql`v.questionId = ${questionId}`);
  const scopeKey = `question:${questionId}`;
  let row = await tx.learningReviewItem.findUnique({ where: { ownerId_scopeKey: { ownerId, scopeKey } } });
  const wrong = latest?.gradingState === 'succeeded' && latest.gradeState === 'succeeded' && ['incorrect', 'partial'].includes(latest.result!);
  if (!row && wrong) {
    const node = await tx.learningNode.findUnique({ where: { id: question.nodeId } });
    row = await tx.learningReviewItem.create({ data: { id: id(), ownerId, scopeKey, mapId: question.mapId,
      nodeId: question.nodeId, questionId, title: node?.title ?? '知识点', updatedAt: now() } });
  }
  if (row && latest) await project(tx, row, latest, eventKey);
  const nodeReview = await tx.learningReviewItem.findUnique({ where: { ownerId_scopeKey: { ownerId, scopeKey: `node:${question.nodeId}` } } });
  if (!nodeReview) return;
  const nodeEvidence = await evidence(tx, ownerId, Prisma.sql`v.nodeId = ${question.nodeId}`);
  await project(tx, nodeReview, nodeEvidence, `node:${question.nodeId}:${eventKey}`);
}
