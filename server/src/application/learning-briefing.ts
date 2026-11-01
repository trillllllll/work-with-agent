import { Prisma } from '@prisma/client';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { ownerActor } from './security.js';
import { practiceHistory, practiceReviews } from './learning-practice/read.js';
import type { LearningBriefing } from '../domain/learning-briefing.js';

/** A bounded summary of saved facts for one topic, shared by the native brief and model context. */
export async function learningBriefing(mapId: string): Promise<LearningBriefing> {
  const map = await prisma.learningMap.findFirst({ where: { id: mapId, deletedAt: null }, select: { id: true, title: true } });
  if (!map) throw new DomainError('NOT_FOUND', '学习主题不存在', 404);
  const [checkpoints, history, reviews, sessions] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; content: string; createdAt: string }>>(Prisma.sql`
      SELECT a.id, substr(a.content, 1, 800) AS content, a.created_at AS createdAt FROM learning_activity a
      WHERE a.map_id = ${mapId} AND a.kind = 'session'
        AND json_extract(CASE WHEN json_valid(a.meta_json) THEN a.meta_json ELSE '{}' END, '$.schemaVersion') = 1
        AND json_extract(CASE WHEN json_valid(a.meta_json) THEN a.meta_json ELSE '{}' END, '$.type') = 'checkpoint'
        AND (a.node_id IS NULL OR EXISTS (SELECT 1 FROM learning_nodes n WHERE n.id = a.node_id AND n.deleted_at IS NULL))
      ORDER BY a.created_at DESC, a.id DESC LIMIT 1`),
    practiceHistory({ mapId, limit: 5 }), practiceReviews({ mapId, due: true, limit: 5 }),
    prisma.learningPracticeSession.findMany({ where: { mapId, ownerId: ownerActor.id, state: { in: ['active', 'paused'] } }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 3,
      select: { id: true, state: true, updatedAt: true } }),
  ]);
  return { map, checkpoint: checkpoints[0] ?? null,
    attempts: history.items.map(item => ({ id: item.id, nodeTitle: item.nodeTitle.slice(0, 150), submittedAt: item.submittedAt, gradingState: item.gradingState, result: item.grade?.result ?? null, assisted: item.assisted, solutionViewed: item.solutionViewed })),
    moreAttempts: Boolean(history.nextCursor), reviews: reviews.items.map(item => ({ id: item.id, nodeId: item.nodeId, nodeTitle: item.title.slice(0, 150), dueAt: item.dueAt })),
    moreReviews: Boolean(reviews.nextCursor), sessions };
}
