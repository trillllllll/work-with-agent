import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Actor } from '../security.js';
import type { LearningOverviewView, LearningSearchView, PracticeHistoryView, PracticeReviewEventView } from '../../domain/learning-practice.js';
import { prisma, ownerActor, owner, json, now, fail, requireItem, requireSession, sessionView, itemView, attemptViews, gradeView, jobView, questionView, reviewView } from './store.js';
import type { FrozenQuestion } from './input.js';
const pageSchema = z.object({ cursor: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
const page = (value: unknown) => pageSchema.parse(value);
const offset = (cursor?: string) => {
  if (!cursor)
    return 0;
  const n = Number(cursor);
  if (!Number.isSafeInteger(n) || n < 0 || n > 100000)
    fail('INVALID_CURSOR', '分页游标无效', 400);
  return n;
};
export async function practiceOverview(actor: Actor = ownerActor): Promise<LearningOverviewView> {
  owner(actor);
  const stamp=now();
  const [resumes, sessions, totals, jobIds, checkpoints] = await Promise.all([
    prisma.$queryRaw<Array<{nodeId:string;mapId:string;nodeTitle:string;updatedAt:string}>>(Prisma.sql`
      SELECT n.id AS nodeId, n.map_id AS mapId, n.title AS nodeTitle, r.updatedAt
      FROM learning_resume_state r
      JOIN learning_nodes n ON n.id = r.nodeId AND n.deleted_at IS NULL AND n.kind = 'item'
      JOIN learning_maps m ON m.id = n.map_id AND m.deleted_at IS NULL
      WHERE r.ownerId = ${actor.id} LIMIT 1
    `),
    prisma.$queryRaw<Array<{id:string;mapId:string;mapTitle:string;state:string;currentPosition:number;total:number|bigint;updatedAt:string}>>(Prisma.sql`
      SELECT s.id, s.mapId, s.mapTitle, s.state, s.currentPosition, s.updatedAt,
        (SELECT COUNT(*) FROM learning_practice_items item WHERE item.sessionId = s.id) AS total
      FROM learning_practice_sessions s JOIN learning_maps m ON m.id = s.mapId AND m.deleted_at IS NULL
      WHERE s.ownerId = ${actor.id} AND s.state IN ('active', 'paused')
        AND EXISTS (SELECT 1 FROM learning_practice_items item
          JOIN learning_question_versions v ON v.id = item.questionVersionId
          JOIN learning_questions q ON q.id = v.questionId AND q.archived = 0
          JOIN learning_nodes n ON n.id = v.nodeId AND n.map_id = s.mapId AND n.deleted_at IS NULL AND n.kind = 'item'
          WHERE item.sessionId = s.id)
      ORDER BY s.updatedAt DESC, s.id DESC LIMIT 10
    `),
    prisma.$queryRaw<Array<{todo:number|bigint;learning:number|bigint;review:number|bigint;done:number|bigint;due:number|bigint}>>(Prisma.sql`
      WITH live_nodes AS (
        SELECT n.id, n.map_id, n.status FROM learning_nodes n
        JOIN learning_maps m ON m.id = n.map_id AND m.deleted_at IS NULL
        WHERE n.deleted_at IS NULL AND n.kind = 'item'
      )
      SELECT
        COALESCE(SUM(status = 'todo'), 0) AS todo,
        COALESCE(SUM(status = 'learning'), 0) AS learning,
        COALESCE(SUM(status = 'review'), 0) AS review,
        COALESCE(SUM(status = 'done'), 0) AS done,
        (SELECT COUNT(*) FROM learning_review_items r JOIN live_nodes n ON n.id = r.nodeId AND n.map_id = r.mapId
          WHERE r.ownerId = ${actor.id} AND r.paused = 0 AND (r.dueAt IS NULL OR r.dueAt <= ${stamp})
            AND EXISTS (SELECT 1 FROM json_each(r.reasonsJson) reason WHERE reason.value <> 'needs_review')
            AND (r.questionId IS NULL OR EXISTS (SELECT 1 FROM learning_questions q WHERE q.id = r.questionId AND q.archived = 0)))
        + (SELECT COUNT(*) FROM live_nodes n WHERE n.status = 'review'
          AND n.id NOT IN (SELECT r.nodeId FROM learning_review_items r WHERE r.ownerId = ${actor.id} AND r.questionId IS NULL)) AS due
      FROM live_nodes
    `),
    prisma.$queryRaw<Array<{id:string}>>(Prisma.sql`
      SELECT j.id FROM learning_jobs j JOIN learning_maps m ON m.id = j.mapId AND m.deleted_at IS NULL
      WHERE j.ownerId = ${actor.id} AND j.kind = 'generate' AND j.adoptedSessionId IS NULL AND j.state <> 'cancelled'
        AND EXISTS (SELECT 1 FROM json_each(j.inputJson, '$.nodes'))
        AND NOT EXISTS (SELECT 1 FROM json_each(j.inputJson, '$.nodes') selected
          WHERE NOT EXISTS (SELECT 1 FROM learning_nodes n WHERE n.id = json_extract(selected.value, '$.id')
            AND n.map_id = j.mapId AND n.deleted_at IS NULL AND n.kind = 'item'))
        AND NOT EXISTS (SELECT 1 FROM json_each(j.inputJson, '$.reuseVersions') reused
          WHERE NOT EXISTS (SELECT 1 FROM learning_question_versions v JOIN learning_questions q ON q.id = v.questionId AND q.archived = 0 WHERE v.id = reused.value))
      ORDER BY j.updatedAt DESC, j.id DESC LIMIT 5
    `),
    prisma.$queryRaw<Array<{id:string;content:string;createdAt:string;nodeId:string|null}>>(Prisma.sql`
      SELECT a.id, a.content, a.created_at AS createdAt, a.node_id AS nodeId
      FROM learning_activity a JOIN learning_maps m ON m.id = a.map_id AND m.deleted_at IS NULL
      WHERE a.kind = 'session'
        AND json_extract(CASE WHEN json_valid(a.meta_json) THEN a.meta_json ELSE '{}' END, '$.schemaVersion') = 1
        AND json_extract(CASE WHEN json_valid(a.meta_json) THEN a.meta_json ELSE '{}' END, '$.type') = 'checkpoint'
        AND (a.node_id IS NULL OR EXISTS (SELECT 1 FROM learning_nodes n
          WHERE n.id = a.node_id AND n.map_id = a.map_id AND n.deleted_at IS NULL AND n.kind = 'item'))
      ORDER BY a.created_at DESC, a.id DESC LIMIT 1
    `),
  ]);
  const jobs=await prisma.learningJob.findMany({where:{id:{in:jobIds.map(j=>j.id)}}});
  const counts={todo:Number(totals[0].todo),learning:Number(totals[0].learning),review:Number(totals[0].review),done:Number(totals[0].done),due:Number(totals[0].due)};
  return {resume:resumes[0]??null,sessions:sessions.map(s=>({...s,currentPosition:Number(s.currentPosition),total:Number(s.total)})),counts,
    checkpoint:checkpoints[0]??null,pendingGenerationJobs:jobIds.map(({id})=>jobView(jobs.find(j=>j.id===id)!)),updatedAt:stamp};
}
export async function searchLearning(value: unknown, actor: Actor = ownerActor): Promise<LearningSearchView> {
  owner(actor);
  const input = pageSchema.extend({ mapId: z.string().optional(), q: z.string().max(500).default(''), status: z.enum(['todo', 'learning', 'review', 'done']).optional() }).parse(value);
  const skip = offset(input.cursor);
  const rows = await prisma.learningNode.findMany({ where: { deletedAt: null, kind: 'item', map: { deletedAt: null }, ...(input.mapId ? { mapId: input.mapId } : {}), ...(input.status ? { status: input.status } : {}), ...(input.q ? { OR: [{ title: { contains: input.q } }, { detail: { contains: input.q } }] } : {}) }, orderBy: [{ mapId: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }], skip, take: input.limit + 1 });
  const visible = rows.slice(0, input.limit);
  // Fetch shared paths once per ancestor level, rather than once per search hit.
  // Only metadata for this page's ancestors is loaded; never all note bodies.
  const [maps, ancestors] = await Promise.all([
    prisma.learningMap.findMany({ where: { id: { in: [...new Set(visible.map(n => n.mapId))] } }, select: { id: true, title: true } }),
    (async () => {
      const found = new Map<string, { id: string; title: string; parentId: string | null; mapId: string }>();
      const visited = new Set<string>();
      let pending = [...new Set(visible.flatMap(n => n.parentId ? [n.parentId] : []))];
      while (pending.length) {
        for (const parent of pending) visited.add(parent);
        const parents = await prisma.learningNode.findMany({ where: { id: { in: pending } }, select: { id: true, title: true, parentId: true, mapId: true } });
        for (const parent of parents) found.set(parent.id, parent);
        pending = [...new Set(parents.flatMap(n => n.parentId && !visited.has(n.parentId) ? [n.parentId] : []))];
      }
      return found;
    })(),
  ]);
  const mapById = new Map(maps.map(map => [map.id, map]));
  const items = [];
  for (const n of visible) {
    const map = mapById.get(n.mapId);
    if (!map) continue;
    const path = [map.title];
    let parent = n.parentId;
    const seen = new Set<string>();
    const groups = [];
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const p = ancestors.get(parent);
      if (!p || p.mapId !== n.mapId)
        break;
      groups.unshift(p.title);
      parent = p.parentId;
    }
    path.push(...groups);
    const found = input.q ? n.detail.toLowerCase().indexOf(input.q.toLowerCase()) : -1;
    const start = Math.max(0, found - 70);
    items.push({ id: n.id, mapId: n.mapId, title: n.title, status: n.status, revision: n.revision, path, excerpt: (start ? '…' : '') + n.detail.slice(start, start + 220) });
  }
  return { items, nextCursor: rows.length > input.limit ? String(skip + input.limit) : null };
}
export async function readPracticeSession(sessionId: string, actor: Actor = ownerActor) {
  owner(actor);
  const s = await requireSession(prisma, sessionId, actor.id);
  return sessionView(prisma, s);
}
export async function readPracticeItem(itemId: string, actor: Actor = ownerActor) {
  owner(actor);
  const { item } = await requireItem(prisma, itemId, actor.id);
  return itemView(prisma, item);
}
export async function readPracticeJob(jobId: string, actor: Actor = ownerActor) {
  owner(actor);
  const j = await prisma.learningJob.findUnique({ where: { id: jobId } });
  if (!j || j.ownerId !== actor.id)
    fail('NOT_FOUND', '任务不存在', 404);
  return jobView(j!);
}
export async function practiceGrades(attemptId: string, value: unknown, actor: Actor = ownerActor) {
  owner(actor);
  const input = pageSchema.parse(value);
  const attempt = await prisma.learningAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.ownerId !== actor.id)
    fail('NOT_FOUND', '作答不存在', 404);
  const beforeVersion = input.cursor ? offset(input.cursor) : undefined;
  const rows = await prisma.learningGrade.findMany({ where: { attemptId, ...(beforeVersion !== undefined ? { version: { lt: beforeVersion } } : {}) }, orderBy: { version: 'desc' }, take: input.limit + 1 });
  const visible = rows.slice(0, input.limit);
  return { items: visible.map(gradeView), nextCursor: rows.length > input.limit ? String(visible.at(-1)!.version) : null };
}
export async function practiceHistory(value: unknown, actor: Actor = ownerActor): Promise<PracticeHistoryView> {
  owner(actor);
  const input = pageSchema.extend({ mapId: z.string().optional(), nodeId: z.string().optional(), sessionId: z.string().optional(), itemId: z.string().optional(), questionId: z.string().optional() }).parse(value);
  const skip = offset(input.cursor);
  if (input.sessionId) await requireSession(prisma, input.sessionId, actor.id);
  if (input.itemId) await requireItem(prisma, input.itemId, actor.id);
  // Apply all ownership and scope filters before LIMIT. No whole-history ID lists.
  const selected = await prisma.$queryRaw<Array<{ id: string; sessionId: string }>>(Prisma.sql`
    SELECT a.id, i.sessionId FROM learning_attempts a
    JOIN learning_question_versions v ON v.id = a."questionVersionId"
    JOIN learning_practice_items i ON i.id = a."itemId"
    JOIN learning_practice_sessions s ON s.id = i."sessionId"
    WHERE a."ownerId" = ${actor.id} AND s."ownerId" = ${actor.id}
      ${input.mapId ? Prisma.sql`AND s."mapId" = ${input.mapId}` : Prisma.empty}
      ${input.nodeId ? Prisma.sql`AND v."nodeId" = ${input.nodeId}` : Prisma.empty}
      ${input.questionId ? Prisma.sql`AND v."questionId" = ${input.questionId}` : Prisma.empty}
      ${input.sessionId ? Prisma.sql`AND s.id = ${input.sessionId}` : Prisma.empty}
      ${input.itemId ? Prisma.sql`AND i.id = ${input.itemId}` : Prisma.empty}
    ORDER BY ${input.itemId ? Prisma.sql`a."attemptNo" DESC` : Prisma.sql`a."submittedAt" DESC, a.id DESC`}
    LIMIT ${input.limit + 1} OFFSET ${skip}`);
  const attempts = await prisma.learningAttempt.findMany({ where: { id: { in: selected.slice(0, input.limit).map(a => a.id) } } });
  const versions = await prisma.learningQuestionVersion.findMany({ where: { id: { in: attempts.map(a => a.questionVersionId) } } });
  const [sourceQuestions, sourceNodes, projected] = await Promise.all([
    prisma.learningQuestion.findMany({ where: { id: { in: versions.map(v => v.questionId) } }, select: { id: true, archived: true } }),
    prisma.learningNode.findMany({ where: { id: { in: versions.map(v => v.nodeId) } }, select: { id: true, deletedAt: true, map: { select: { deletedAt: true } } } }),
    attemptViews(prisma, attempts),
  ]);
  const attemptById = new Map(attempts.map(a => [a.id, a]));
  const viewById = new Map(projected.map(a => [a.id, a]));
  const versionById = new Map(versions.map(v => [v.id, v]));
  const questionById = new Map(sourceQuestions.map(q => [q.id, q]));
  const nodeById = new Map(sourceNodes.map(n => [n.id, n]));
  const items = selected.slice(0, input.limit).map(selectedRow => {
    const a = attemptById.get(selectedRow.id)!;
    const v = versionById.get(a.questionVersionId)!;
    const sourceQuestion = questionById.get(v.questionId), sourceNode = nodeById.get(v.nodeId);
    const archived = !sourceQuestion || sourceQuestion.archived || !sourceNode || Boolean(sourceNode.deletedAt || sourceNode.map.deletedAt);
    return { ...viewById.get(a.id)!, sessionId: selectedRow.sessionId, question: questionView(json<FrozenQuestion>(v.contentJson), v.id, v.questionId, archived, Boolean(sourceQuestion?.archived)), nodeTitle: v.nodeTitle };
  });
  return { items, nextCursor: selected.length > input.limit ? String(skip + input.limit) : null };
}
export async function practiceReviews(value: unknown, actor: Actor = ownerActor) {
  owner(actor);
  const input = pageSchema.extend({ mapId: z.string().optional(), nodeId: z.string().optional(), due: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(), paused: z.union([z.boolean(), z.enum(['true', 'false'])]).optional() }).parse(value);
  const skip = offset(input.cursor);
  const due = input.due === true || input.due === 'true';
  const paused = input.paused === true || input.paused === 'true';
  // Apply source availability and evidence predicates before the single merged page.
  // Offset cursors stay compatible with saved clients; the full ordering includes id.
  const selected = await prisma.$queryRaw<Array<{id: string; nodeId: string; title: string; kind: string}>>(Prisma.sql`
    WITH eligible AS (
      SELECT r.id, n.id AS nodeId, n.title, r.dueAt, 'stored' AS kind
      FROM learning_review_items r
      JOIN learning_nodes n ON n.id = r.nodeId AND n.deleted_at IS NULL AND n.kind = 'item'
      JOIN learning_maps m ON m.id = n.map_id AND m.deleted_at IS NULL
      WHERE r.ownerId = ${actor.id} AND r.mapId = m.id AND json_array_length(r.reasonsJson) > 0
        AND (r.questionId IS NULL OR EXISTS (SELECT 1 FROM learning_questions q WHERE q.id = r.questionId AND q.archived = 0))
        ${input.mapId ? Prisma.sql`AND m.id = ${input.mapId}` : Prisma.empty}
        ${input.nodeId ? Prisma.sql`AND n.id = ${input.nodeId}` : Prisma.empty}
        ${input.paused !== undefined ? Prisma.sql`AND r.paused = ${paused}` : Prisma.empty}
        ${due ? Prisma.sql`AND r.paused = 0 AND (r.dueAt IS NULL OR r.dueAt <= ${now()})
          AND EXISTS (SELECT 1 FROM json_each(r.reasonsJson) reason WHERE reason.value <> 'needs_review')` : Prisma.empty}
      UNION ALL
      SELECT 'node:' || n.id AS id, n.id AS nodeId, n.title, NULL AS dueAt, 'marked' AS kind
      FROM learning_nodes n JOIN learning_maps m ON m.id = n.map_id AND m.deleted_at IS NULL
      WHERE n.deleted_at IS NULL AND n.kind = 'item' AND n.status = 'review' AND ${paused ? 0 : 1} = 1
        ${input.mapId ? Prisma.sql`AND m.id = ${input.mapId}` : Prisma.empty}
        ${input.nodeId ? Prisma.sql`AND n.id = ${input.nodeId}` : Prisma.empty}
        AND NOT EXISTS (SELECT 1 FROM learning_review_items existing
          WHERE existing.ownerId = ${actor.id} AND existing.nodeId = n.id AND existing.questionId IS NULL)
    )
    SELECT id, nodeId, title, kind FROM eligible
    ORDER BY COALESCE(dueAt, ''), id LIMIT ${input.limit + 1} OFFSET ${skip}
  `);
  const visible = selected.slice(0, input.limit);
  const [rows, nodes] = await Promise.all([
    prisma.learningReviewItem.findMany({where:{id:{in:visible.filter(row=>row.kind==='stored').map(row=>row.id)}}}),
    prisma.learningNode.findMany({where:{id:{in:visible.filter(row=>row.kind==='marked').map(row=>row.nodeId)}}}),
  ]);
  const items = visible.map(selected => {
    if (selected.kind === 'stored') return {...reviewView(rows.find(row=>row.id===selected.id)!),title:selected.title};
    const n=nodes.find(node=>node.id===selected.nodeId)!;
    return {id:selected.id,mapId:n.mapId,nodeId:n.id,questionId:null,title:n.title,reasons:['marked_review'],dueAt:null,paused:false,revision:n.revision,policy:'manual' as const,policyVersion:'manual-v1',manualSchedule:false,lastAttemptId:null,lastGradeId:null,streak:0,updatedAt:n.updatedAt};
  });
  return {items,nextCursor:selected.length>input.limit?String(skip+input.limit):null};
}
export async function learningActivityPage(value: unknown, actor: Actor = ownerActor) {
  owner(actor);
  const input = pageSchema.extend({ mapId: z.string().optional(), nodeId: z.string().optional() }).parse(value);
  const skip = offset(input.cursor);
  const rows = await prisma.learningActivity.findMany({ where: { ...(input.mapId ? { mapId: input.mapId } : {}), ...(input.nodeId ? { nodeId: input.nodeId } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: input.limit + 1 });
  return { items: rows.slice(0, input.limit).map(r => ({ id: r.id, kind: r.kind, content: r.content, createdAt: r.createdAt, nodeId: r.nodeId, meta: json(r.metaJson) })), nextCursor: rows.length > input.limit ? String(skip + input.limit) : null };
}
export async function practiceReviewEvents(reviewId: string, value: unknown, actor: Actor = ownerActor): Promise<{
  items: PracticeReviewEventView[];
  nextCursor: string | null;
}> {
  owner(actor);
  const input = page(value);
  const skip = offset(input.cursor);
  if (reviewId.startsWith('node:')) {
    const node = await prisma.learningNode.findUnique({ where: { id: reviewId.slice(5) } });
    if (!node)
      fail('NOT_FOUND', '复习安排不存在', 404);
    return { items: [], nextCursor: null };
  }
  const review = await prisma.learningReviewItem.findUnique({ where: { id: reviewId } });
  if (!review || review.ownerId !== actor.id)
    fail('NOT_FOUND', '复习安排不存在', 404);
  const rows = await prisma.learningReviewEvent.findMany({ where: { reviewId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: input.limit + 1 });
  return { items: rows.slice(0, input.limit).map(row => ({ id: row.id, kind: row.kind, createdAt: row.createdAt, attemptId: row.attemptId, gradeId: row.gradeId, before: json(row.beforeJson), after: json(row.afterJson) })), nextCursor: rows.length > input.limit ? String(skip + input.limit) : null };
}
export async function validatePracticeReference(input: {
  sessionId: string;
  itemId: string;
  activeAttemptId: string;
}, actor: Actor = ownerActor) {
  owner(actor);
  const { item, session, draft, version, question } = await requireItem(prisma, input.itemId, actor.id);
  if (session.id !== input.sessionId)
    fail('INVALID_REFERENCE', '题目不属于所引用练习', 400);
  const source = await prisma.learningNode.findUnique({ where: { id: version.nodeId }, include: { map: true } });
  const sourceQuestion = await prisma.learningQuestion.findUnique({ where: { id: version.questionId } });
  if (!source || source.deletedAt || source.map.deletedAt || !sourceQuestion || sourceQuestion.archived)
    fail('QUESTION_UNAVAILABLE', '来源内容已归档；历史仍可查看', 409);
  const attempt = await prisma.learningAttempt.findUnique({ where: { id: input.activeAttemptId } });
  if (draft.activeAttemptId !== input.activeAttemptId && (!attempt || attempt.itemId !== item.id || attempt.ownerId !== actor.id))
    fail('INVALID_REFERENCE', '作答引用已失效', 400);
  return { sessionId: session.id, itemId: item.id, mapId: session.mapId, nodeId: version.nodeId, activeAttemptId: input.activeAttemptId, question: questionView(question, version.id, version.questionId), submitted: Boolean(attempt) };
}
/** Study identity dispatcher. Every result uses the same public projection as owner UI. */
export async function practiceRead(args: Record<string, unknown>, actor: Actor = ownerActor) {
  const input = z.object({ action: z.enum(['overview', 'practice_session', 'practice_item', 'practice_history', 'practice_grades', 'reviews', 'practice_job', 'search', 'activity']), sessionId: z.string().optional(), itemId: z.string().optional(), attemptId: z.string().optional(), jobId: z.string().optional() }).passthrough().parse(args);
  if (input.action === 'overview')
    return practiceOverview(actor);
  if (input.action === 'practice_session')
    return readPracticeSession(z.string().min(1).parse(input.sessionId), actor);
  if (input.action === 'practice_item')
    return readPracticeItem(z.string().min(1).parse(input.itemId), actor);
  if (input.action === 'practice_job')
    return readPracticeJob(z.string().min(1).parse(input.jobId), actor);
  if (input.action === 'practice_history')
    return practiceHistory(args, actor);
  if (input.action === 'practice_grades')
    return practiceGrades(z.string().min(1).parse(input.attemptId), args, actor);
  if (input.action === 'reviews')
    return practiceReviews(args, actor);
  if (input.action === 'search')
    return searchLearning(args, actor);
  return learningActivityPage(args, actor);
}
