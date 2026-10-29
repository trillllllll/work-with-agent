import { Prisma } from '@prisma/client';
import { json, type Db } from './store.js';
import { refreshReviewForQuestion } from './reviews.js';

async function questionScope(tx: Db, itemId: string) {
  const [scope] = await tx.$queryRaw<Array<{ ownerId: string; questionId: string }>>(Prisma.sql`
    SELECT s."ownerId", v."questionId" FROM learning_practice_items i
    JOIN learning_practice_sessions s ON s.id = i."sessionId"
    JOIN learning_question_versions v ON v.id = i."questionVersionId"
    WHERE i.id = ${itemId}`);
  if (!scope) throw new Error('Practice item scope is missing');
  return scope;
}

function scopedEvents(scope: { ownerId: string; questionId: string }) {
  return Prisma.sql`WITH evidence AS (
    SELECT e.* FROM learning_practice_events e
    JOIN learning_practice_items i ON i.id = e."itemId"
    JOIN learning_practice_sessions s ON s.id = i."sessionId"
    JOIN learning_question_versions v ON v.id = i."questionVersionId"
    WHERE e."ownerId" = ${scope.ownerId} AND s."ownerId" = ${scope.ownerId}
      AND v."questionId" = ${scope.questionId}
  )`;
}

/** Old exposure remains relevant to an identical question; return facts, not its full log. */
export async function assistanceForItem(tx: Db, itemId: string) {
  const scope = await questionScope(tx, itemId);
  const [facts] = await tx.$queryRaw<Array<{ assisted: number; solutionViewed: number }>>(Prisma.sql`
    ${scopedEvents(scope)} SELECT
      COALESCE(MAX(type IN ('hint', 'assistance_delivered', 'assistance_solution', 'prior_feedback')), 0) AS assisted,
      COALESCE(MAX(type IN ('solution', 'assistance_solution')), 0) AS "solutionViewed"
    FROM evidence`);
  // Only unresolved source IDs belong in the immutable submission snapshot.
  const pending = await tx.$queryRaw<Array<{ sourceMessageId: string }>>(Prisma.sql`
    ${scopedEvents(scope)} SELECT DISTINCT r."sourceMessageId" FROM evidence r
    WHERE r.type = 'assistance_requested' AND r."sourceMessageId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM evidence done WHERE done."sourceMessageId" = r."sourceMessageId"
        AND done.type IN ('assistance_delivered', 'assistance_solution', 'assistance_failed'))`);
  const pendingSources = pending.map(row => row.sourceMessageId);
  return { assisted: Boolean(facts.assisted), solutionViewed: Boolean(facts.solutionViewed), uncertain: pendingSources.length > 0, pendingSources };
}

/** Resolve only snapshots that already named this message when the answer was submitted. */
export async function resolveSubmittedAssistance(tx: Db, itemId: string, sourceMessageId: string, eventId: string) {
  const scope = await questionScope(tx, itemId);
  let afterId = '';
  let changed = false;
  for (;;) {
    const targets = await tx.$queryRaw<Array<{ id: string; payloadJson: string }>>(Prisma.sql`
      SELECT a.id, snapshot."payloadJson" FROM learning_attempts a
      JOIN learning_question_versions v ON v.id = a."questionVersionId"
      JOIN learning_practice_events snapshot ON snapshot."eventKey" = 'submission:' || a.id
      WHERE a."ownerId" = ${scope.ownerId} AND v."questionId" = ${scope.questionId} AND a.id > ${afterId}
        AND EXISTS (SELECT 1 FROM json_each(snapshot."payloadJson", '$.pendingSources') source
          WHERE source.value = ${sourceMessageId})
      ORDER BY a.id ASC LIMIT 100`);
    if (!targets.length) break;
    for (const target of targets) {
      const snapshot = json<{ assisted: boolean; solutionViewed: boolean; pendingSources: string[] }>(target.payloadJson);
      const [resolved] = await tx.$queryRaw<Array<{ ended: number; assisted: number; solutionViewed: number }>>(Prisma.sql`
        ${scopedEvents(scope)} SELECT COUNT(DISTINCT "sourceMessageId") AS ended,
          COALESCE(MAX(type IN ('assistance_delivered', 'assistance_solution')), 0) AS assisted,
          COALESCE(MAX(type = 'assistance_solution'), 0) AS "solutionViewed"
        FROM evidence WHERE type IN ('assistance_delivered', 'assistance_solution', 'assistance_failed')
          AND "sourceMessageId" IN (SELECT value FROM json_each(${JSON.stringify(snapshot.pendingSources)}))`);
      await tx.learningAttempt.update({ where: { id: target.id }, data: {
        assisted: snapshot.assisted || Boolean(resolved.assisted),
        solutionViewed: snapshot.solutionViewed || Boolean(resolved.solutionViewed),
        assistanceUncertain: Number(resolved.ended) < snapshot.pendingSources.length,
      } });
      changed = true;
    }
    afterId = targets.at(-1)!.id;
  }
  // The projection reads current evidence once, after all affected snapshots are corrected.
  if (changed) await refreshReviewForQuestion(tx, scope.ownerId, scope.questionId, `assistance:${eventId}`);
}
