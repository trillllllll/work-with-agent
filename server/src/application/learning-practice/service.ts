import { z } from 'zod';
import { Prisma, type LearningReviewItem, type LearningQuestionVersion } from '@prisma/client';
import type { Actor } from '../security.js';
import { configSchema, draftSchema, submitSchema, sessionUpdateSchema, reviewUpdateSchema, requestIdSchema, validAnswer, type Candidate, type FrozenQuestion } from './input.js';
import { ownerActor, owner, mutation, now, id, json, fail, requireMap, requireNode, requireItem, requireSession, assertDraft, draftView, itemView, itemExposure, sessionView, attemptView, jobView, reviewView, commandDigest, runSerializedCommand, type Db } from './store.js';
import { refreshReviewForQuestion } from './reviews.js';
import { assistanceForItem, resolveSubmittedAssistance } from './assistance.js';
export { assistanceForItem } from './assistance.js';
export type GenerationInput = {
  config: ReturnType<typeof configSchema.parse>;
  nodes: Array<{
    id: string;
    title: string;
    detail: string;
    revision: number;
  }>;
  recentAttempts: Array<{
    nodeId: string;
    questionId: string;
    questionVersionId: string;
    prompt: string;
    result: string;
    mistakes: string[];
  }>;
  recentVersions?: Array<{
    id: string;
    questionId: string;
    nodeId: string;
  }>;
  reuseVersions?: string[];
};
export async function generatePractice(value: unknown, actor: Actor = ownerActor) {
  const parsed = z.object({ requestId: requestIdSchema }).passthrough().parse(value);
  const { requestId, ...raw } = parsed;
  const config = configSchema.parse(raw);
  return mutation(actor, requestId, 'practice.generate', config, tx => generatePracticeInTransaction(tx, config, actor.id));
}
export async function generatePracticeInTransaction(tx: Db, config: ReturnType<typeof configSchema.parse>, ownerId: string) {
  await requireMap(tx, config.mapId);
  if (await tx.learningJob.count({ where: { ownerId: ownerId, kind: 'generate', state: { in: ['queued', 'running'] } } }) >= 3)
    fail('PRACTICE_BUSY', '已有出题任务进行中，请等待完成');
  const all = await tx.learningNode.findMany({ where: { mapId: config.mapId, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  if (config.nodeIds?.some(nodeId => !all.some(n => n.id === nodeId)))
    fail('NOT_FOUND', '练习范围中有不可用知识点', 404);
  let nodes = all.filter(n => n.kind === 'item');
  if (config.nodeIds) {
    const selected = new Set(config.nodeIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of all)
        if (n.parentId && selected.has(n.parentId) && !selected.has(n.id)) {
          selected.add(n.id);
          changed = true;
        }
    }
    nodes = nodes.filter(n => selected.has(n.id));
  }
  if (!nodes.length)
    fail('NO_KNOWLEDGE_POINTS', '请先选择有知识点的学习主题', 400);
  if (nodes.length > 100)
    fail('SCOPE_TOO_LARGE', '请缩小到最多 100 个知识点', 400);
  const input: GenerationInput = { config: { ...config, nodeIds: nodes.map(n => n.id) }, nodes: nodes.map(n => ({ id: n.id, title: n.title, detail: n.detail.slice(0, Math.min(6000, Math.floor(30000 / nodes.length))), revision: n.revision })), recentAttempts: [] };
  const versions = await tx.$queryRaw<LearningQuestionVersion[]>(Prisma.sql`
    SELECT v.* FROM learning_question_versions v JOIN learning_questions q ON q.id = v.questionId
    WHERE q.archived = 0 AND v.nodeId IN (${Prisma.join(nodes.map(n => n.id))})
    ORDER BY v.createdAt DESC, v.id DESC LIMIT 300`);
  const recent = await tx.learningAttempt.findMany({ where: { ownerId: ownerId, questionVersionId: { in: versions.map(v => v.id) } }, orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }], take: 100 });
  const seen = new Set<string>();
  const wrong: string[] = [];
  for (const a of recent) {
    const v = versions.find(v => v.id === a.questionVersionId);
    if (!v || seen.has(v.questionId))
      continue;
    seen.add(v.questionId);
    if (!a.currentGradeId || a.gradingState !== 'succeeded')
      continue;
    const g = await tx.learningGrade.findUnique({ where: { id: a.currentGradeId } });
    if (!g || g.state !== 'succeeded')
      continue;
    const q = json<FrozenQuestion>(v.contentJson);
    input.recentAttempts.push({ nodeId: q.nodeId, questionId: v.questionId, questionVersionId: v.id, prompt: q.prompt.slice(0, 600), result: g.result, mistakes: json(g.mistakesJson) });
    if (['incorrect', 'partial'].includes(g.result))
      wrong.push(v.id);
  }
  input.recentVersions = input.recentAttempts.map(a => ({ id: a.questionVersionId, questionId: a.questionId, nodeId: a.nodeId }));
  if (config.mode === 'wrong' || config.mode === 'review') {
    let chosen = wrong;
    if (config.mode === 'review') {
      const reviews = await tx.$queryRaw<LearningReviewItem[]>(Prisma.sql`
        SELECT r.* FROM learning_review_items r
        WHERE r.ownerId = ${ownerId} AND r.mapId = ${config.mapId}
          AND r.nodeId IN (${Prisma.join(nodes.map(n => n.id))}) AND r.paused = 0
          AND EXISTS (SELECT 1 FROM json_each(r.reasonsJson) reason WHERE reason.value <> 'needs_review')
          AND (r.questionId IS NULL OR EXISTS (SELECT 1 FROM learning_questions q WHERE q.id = r.questionId AND q.archived = 0))
        ORDER BY r.dueAt, r.id LIMIT 100
      `);
      const nodeArrangements = await tx.learningReviewItem.findMany({where:{ownerId,mapId:config.mapId,nodeId:{in:nodes.map(n=>n.id)},questionId:null},select:{nodeId:true}});
      const targets = new Set(reviews.map(r => r.questionId).filter(Boolean));
      const targetNodes = new Set(reviews.filter(r => !r.questionId).map(r => r.nodeId));
      const explicitlyScheduledNodes = new Set(nodeArrangements.map(r => r.nodeId));
      for (const n of nodes)
        if (n.status === 'review' && !explicitlyScheduledNodes.has(n.id))
          targetNodes.add(n.id);
      const scopeNodes = new Set([...targetNodes, ...reviews.map(r => r.nodeId)]);
      if (!scopeNodes.size)
        fail('NO_REVIEW_ITEMS', '当前范围没有可复习内容；可先加入复习或选择知识点练习', 400);
      input.nodes = input.nodes.filter(n => scopeNodes.has(n.id));
      input.config.nodeIds = input.nodes.map(n => n.id);
      input.recentAttempts = input.recentAttempts.filter(a => scopeNodes.has(a.nodeId));
      input.recentVersions = input.recentVersions?.filter(v => scopeNodes.has(v.nodeId));
      chosen = versions.filter(v => targets.has(v.questionId) || targetNodes.has(v.nodeId)).map(v => v.id);
    }
    const used = new Set<string>();
    const eligible = [];
    const sourceNodes = new Set<string>();
    for (const versionId of chosen) {
      const v = versions.find(v => v.id === versionId);
      if (!v || used.has(v.questionId))
        continue;
      const q = await tx.learningQuestion.findUnique({ where: { id: v.questionId } });
      if (!q || q.archived)
        continue;
      used.add(v.questionId);
      sourceNodes.add(v.nodeId);
      const frozen = json<FrozenQuestion>(v.contentJson);
      if (!config.types.includes(frozen.type) || frozen.difficulty !== config.difficulty)
        continue;
      eligible.push(v);
      if (eligible.length >= config.count)
        break;
    }
    if (eligible.length) {
      input.reuseVersions = eligible.map(v => v.id);
      input.config.count = eligible.length;
    }
    else if (config.mode === 'wrong') {
      if (!sourceNodes.size) fail('NO_WRONG_QUESTIONS', '当前范围还没有已确认错题；可选择知识点练习', 400);
      // Incompatible originals become freshly generated candidates with the
      // requested format; they must remain scoped to the actual wrong evidence.
      input.nodes = input.nodes.filter(n => sourceNodes.has(n.id));
      input.config.nodeIds = input.nodes.map(n => n.id);
      input.recentAttempts = input.recentAttempts.filter(a => sourceNodes.has(a.nodeId));
      input.recentVersions = input.recentVersions?.filter(v => sourceNodes.has(v.nodeId));
    }
  }
  const stamp = now();
  let output: Candidate | null = null;
  if (input.reuseVersions)
    output = { title: config.mode === 'wrong' ? '错题重练' : '复习练习', questions: input.reuseVersions.map(vid => json<FrozenQuestion>(versions.find(v => v.id === vid)!.contentJson)) };
  const job = await tx.learningJob.create({ data: { id: id(), ownerId: ownerId, kind: 'generate', mapId: config.mapId, inputJson: JSON.stringify(input), state: output ? 'succeeded' : 'queued', outputJson: output ? JSON.stringify(output) : null, candidateRevision: output ? commandDigest(output) : null, createdAt: stamp, updatedAt: stamp } });
  return { job: jobView(job) };
}
/** Also used by approved chat proposals; candidate secrets never enter command payloads. */
export async function inspectPracticeCandidate(tx: Db, jobId: string, candidateRevision: string, ownerId: string = ownerActor.id) {
  const job = await tx.learningJob.findUnique({ where: { id: jobId } });
  if (!job || job.ownerId !== ownerId || job.kind !== 'generate')
    fail('NOT_FOUND', '候选练习不存在', 404);
  if (job!.state !== 'succeeded' || !job!.outputJson || job!.candidateRevision !== candidateRevision)
    fail('VERSION_CONFLICT', '候选练习已变化或尚未完成，请重新查看');
  await requireMap(tx, job!.mapId);
  const candidate = json<Candidate>(job!.outputJson!);
  for (const nodeId of new Set(candidate.questions.map(q => q.nodeId)))
    await requireNode(tx, nodeId, job!.mapId);
  for (const q of candidate.questions) {
    if (!q.variantOfQuestionVersionId) continue;
    const source = await tx.learningQuestionVersion.findUnique({ where: { id: q.variantOfQuestionVersionId } });
    const original = source && await tx.learningQuestion.findUnique({ where: { id: source.questionId } });
    if (!original || original.archived) fail('QUESTION_UNAVAILABLE', '原题版本已不可用，请重新组题');
  }
  return { job: job!, candidate, input: json<GenerationInput>(job!.inputJson), preview: jobView(job!) };
}
export async function startPracticeCandidate(tx: Db, ownerId: string, input: {
  jobId: string;
  candidateRevision: string;
}) {
  const { job, candidate, input: generation } = await inspectPracticeCandidate(tx, input.jobId, input.candidateRevision, ownerId);
  if (job.adoptedSessionId) {
    const existing = await requireSession(tx, job.adoptedSessionId, ownerId);
    return sessionView(tx, existing);
  }
  const map = await requireMap(tx, job.mapId);
  const stamp = now();
  const session = await tx.learningPracticeSession.create({ data: { id: id(), ownerId, mapId: map.id, mapTitle: map.title, generationJobId: job.id, mode: generation.config.mode, configJson: JSON.stringify(generation.config), createdAt: stamp, updatedAt: stamp } });
  for (const [position, q] of candidate.questions.entries()) {
    let versionId = generation.reuseVersions?.[position];
    if (versionId) {
      const v = await tx.learningQuestionVersion.findUnique({ where: { id: versionId } });
      const base = v ? await tx.learningQuestion.findUnique({ where: { id: v.questionId } }) : null;
      if (!v || !base || base.archived || commandDigest(json(v.contentJson)) !== commandDigest(q))
        fail('QUESTION_UNAVAILABLE', '原题版本已不可用，请重新组题');
    }
    else {
      const questionId = id();
      versionId = id();
      await tx.learningQuestion.create({ data: { id: questionId, mapId: map.id, nodeId: q.nodeId, currentVersionId: versionId, createdAt: stamp } });
      await tx.learningQuestionVersion.create({ data: { id: versionId, questionId, nodeId: q.nodeId, nodeTitle: generation.nodes.find(n => n.id === q.nodeId)?.title ?? '', contentJson: JSON.stringify(q), model: job.model, promptVersion: 'practice-generate-v1', createdAt: stamp } });
    }
    const item = await tx.learningPracticeItem.create({ data: { id: id(), sessionId: session.id, questionVersionId: versionId, position, selectionReason: q.variantOfQuestionVersionId ? 'recent_mistake_variant' : generation.config.mode === 'wrong' ? 'recent_incorrect' : generation.config.mode === 'review' ? 'review_queue' : generation.config.mode === 'mixed' ? 'mixed_practice' : 'selected_knowledge' } });
    const draft = await tx.learningAnswerDraft.create({ data: { id: id(), itemId: item.id, activeAttemptId: id(), answerJson: q.type === 'multiple' ? '[]' : '""', updatedAt: stamp } });
    if (generation.reuseVersions) {
      const previous = await tx.learningAttempt.findFirst({ where: { ownerId, questionVersionId: versionId, currentGradeId: { not: null } } });
      if (previous)
        await tx.learningPracticeEvent.create({ data: { id: id(), ownerId, itemId: item.id, activeAttemptId: draft.activeAttemptId, type: 'prior_feedback', eventKey: `adopt-feedback:${item.id}`, createdAt: stamp } });
    }
  }
  await tx.learningJob.update({ where: { id: job.id }, data: { adoptedSessionId: session.id, updatedAt: stamp } });
  await saveResumeNode(tx, ownerId, candidate.questions[0].nodeId);
  return sessionView(tx, session);
}
export async function startPractice(value: unknown, actor: Actor = ownerActor) {
  const input = z.object({ requestId: requestIdSchema, jobId: z.string().min(1), candidateRevision: z.string().min(1) }).strict().parse(value);
  return mutation(actor, input.requestId, 'practice.start', input, async (tx) => ({ session: await startPracticeCandidate(tx, actor.id, input) }));
}
export async function savePracticeDraft(itemId: string, value: unknown, actor: Actor = ownerActor) {
  const input = draftSchema.parse(value);
  return mutation(actor, input.requestId, 'practice.draft', { itemId, ...input }, async (tx) => {
    const { draft } = await requireItem(tx, itemId, actor.id, true);
    assertDraft(draft, input.activeAttemptId, input.expectedDraftRevision);
    const updated = await tx.learningAnswerDraft.update({ where: { id: draft.id, revision: input.expectedDraftRevision }, data: { answerJson: JSON.stringify(input.answer), revision: { increment: 1 }, updatedAt: now() } });
    return { draft: draftView(updated) };
  });
}
export async function submitPracticeAttempt(itemId: string, value: unknown, actor: Actor = ownerActor) {
  const input = submitSchema.parse(value);
  return mutation(actor, input.requestId, 'practice.submit', { itemId, ...input }, async (tx) => {
    const { item, session, version, question, draft } = await requireItem(tx, itemId, actor.id, true);
    const existing = await tx.learningAttempt.findUnique({ where: { id: input.activeAttemptId } });
    if (existing) {
      if (existing.ownerId !== actor.id || existing.itemId !== itemId || existing.clientAttemptId !== input.clientAttemptId || commandDigest(json(existing.answerJson)) !== commandDigest(input.answer))
        fail('ATTEMPT_SUBMITTED', '该尝试已提交其他答案，请开始重做');
      return { attempt: await attemptView(tx, existing), sessionId: session.id, itemId };
    }
    assertDraft(draft, input.activeAttemptId, input.expectedDraftRevision);
    if (input.questionVersionId !== version.id)
      fail('VERSION_CONFLICT', '题目版本不一致');
    if (!validAnswer(question, input.answer))
      fail('INVALID_ANSWER', '请填写与题型相符的有效答案', 400);
    if (await tx.learningAttempt.findUnique({ where: { ownerId_clientAttemptId: { ownerId: actor.id, clientAttemptId: input.clientAttemptId } } }))
      fail('IDEMPOTENCY_CONFLICT', '该客户端作答标识已被使用');
    const support = await assistanceForItem(tx, itemId);
    const stamp = now();
    const attempt = await tx.learningAttempt.create({ data: { id: draft.activeAttemptId, ownerId: actor.id, itemId, questionVersionId: version.id, attemptNo: draft.attemptNo, clientAttemptId: input.clientAttemptId, answerJson: JSON.stringify(input.answer), submittedAt: stamp, assisted: support.assisted, solutionViewed: support.solutionViewed, assistanceUncertain: support.uncertain } });
    await tx.learningPracticeEvent.create({ data: { id: id(), ownerId: actor.id, itemId, activeAttemptId: attempt.id, type: 'submission_snapshot', eventKey: `submission:${attempt.id}`, payloadJson: JSON.stringify(support), createdAt: stamp } });
    await tx.learningAnswerDraft.update({ where: { id: draft.id, revision: input.expectedDraftRevision }, data: { answerJson: attempt.answerJson, submitted: true, revision: { increment: 1 }, updatedAt: stamp } });
    await tx.learningPracticeItem.update({ where: { id: itemId }, data: { skipped: false } });
    await tx.learningJob.create({ data: { id: id(), ownerId: actor.id, kind: 'grade', mapId: session.mapId, sessionId: session.id, attemptId: attempt.id, gradingVersion: 1, inputJson: JSON.stringify({ question, answer: input.answer, assistance: support, reason: '' }), createdAt: stamp, updatedAt: stamp } });
    await tx.learningPracticeSession.update({ where: { id: session.id }, data: { currentPosition: item.position, updatedAt: stamp, revision: { increment: 1 } } });
    await saveResumeNode(tx, actor.id, version.nodeId);
    return { attempt: await attemptView(tx, attempt), sessionId: session.id, itemId };
  });
}
export async function retryPracticeItem(itemId: string, value: unknown, actor: Actor = ownerActor) {
  const input = z.object({ requestId: requestIdSchema, expectedDraftRevision: z.number().int().positive() }).strict().parse(value);
  return mutation(actor, input.requestId, 'practice.retry_item', { itemId, ...input }, async (tx) => {
    const { draft, question } = await requireItem(tx, itemId, actor.id, true);
    if (draft.revision !== input.expectedDraftRevision)
      fail('VERSION_CONFLICT', '草稿已经变化');
    if (!draft.submitted)
      fail('ATTEMPT_NOT_SUBMITTED', '当前尝试尚未提交');
    const previous = await tx.learningAttempt.findUnique({ where: { id: draft.activeAttemptId } });
    if (previous?.currentGradeId)
      await tx.learningPracticeEvent.create({ data: { id: id(), ownerId: actor.id, itemId, activeAttemptId: draft.activeAttemptId, type: 'prior_feedback', eventKey: `redo-feedback:${actor.id}:${input.requestId}`, createdAt: now() } });
    const updated = await tx.learningAnswerDraft.update({ where: { id: draft.id, revision: draft.revision }, data: { activeAttemptId: id(), attemptNo: { increment: 1 }, answerJson: question.type === 'multiple' ? '[]' : '""', submitted: false, revision: { increment: 1 }, updatedAt: now() } });
    return { draft: draftView(updated) };
  });
}
/** User invalidation preserves every historical answer, grade and frozen version. */
export async function archivePracticeQuestion(itemId: string, value: unknown, actor: Actor = ownerActor) {
  const input = z.object({ requestId: requestIdSchema, questionVersionId: z.string().min(1) }).strict().parse(value);
  return mutation(actor, input.requestId, 'practice.question.archive', { itemId, ...input }, async tx => {
    // Finished/archived sessions remain valid ownership evidence for correcting a bad question.
    const { item, version, draft } = await requireItem(tx, itemId, actor.id);
    const question = await tx.learningQuestion.findUnique({ where: { id: version.questionId } });
    if (!question) fail('NOT_FOUND', '题目不存在', 404);
    if (version.id !== input.questionVersionId || question!.currentVersionId !== input.questionVersionId)
      fail('VERSION_CONFLICT', '题目版本不一致');
    if (!question!.archived) {
      await tx.learningQuestion.update({ where: { id: question!.id }, data: { archived: true } });
      const eventKey = `question-archive:${question!.id}`;
      await tx.learningPracticeEvent.create({ data: { id: id(), ownerId: actor.id, itemId, activeAttemptId: draft.activeAttemptId,
        type: 'question_archived', eventKey, payloadJson: JSON.stringify({ questionId: question!.id, questionVersionId: version.id }), createdAt: now() } });
      await refreshReviewForQuestion(tx, actor.id, question!.id, eventKey);
    }
    return { item: await itemView(tx, item) };
  });
}
export async function practiceEvent(itemId: string, value: unknown, actor: Actor = ownerActor) {
  const input = z.object({ requestId: requestIdSchema, activeAttemptId: z.string().min(1), type: z.enum(['hint', 'solution', 'skip']) }).strict().parse(value);
  return mutation(actor, input.requestId, 'practice.event', { itemId, ...input }, async (tx) => {
    const { item, question, draft } = await requireItem(tx, itemId, actor.id, true);
    if (draft.activeAttemptId !== input.activeAttemptId)
      fail('VERSION_CONFLICT', '当前尝试已变化');
    const { hintCount: current } = await itemExposure(tx, itemId);
    const level = Math.min(question.hints.length, current + 1);
    if (input.type === 'hint' && !question.hints.length)
      fail('NO_HINT', '此题没有额外提示', 400);
    await tx.learningPracticeEvent.create({ data: { id: id(), ownerId: actor.id, itemId, activeAttemptId: draft.activeAttemptId, type: input.type, eventKey: `user:${actor.id}:${input.requestId}`, payloadJson: JSON.stringify(input.type === 'hint' ? { level } : {}), createdAt: now() } });
    if (input.type === 'skip')
      await tx.learningPracticeItem.update({ where: { id: itemId }, data: { skipped: true } });
    // Exposure after submitting applies to future retries, not retroactively to the completed answer.
    return { item: await itemView(tx, item), ...(input.type === 'hint' ? { hint: question.hints[level - 1] } : {}), ...(input.type === 'solution' ? { solution: { answer: question.answer, explanation: question.explanation, rubric: question.rubric } } : {}) };
  });
}
export async function updatePracticeSession(sessionId: string, value: unknown, actor: Actor = ownerActor) {
  const input = sessionUpdateSchema.parse(value);
  return mutation(actor, input.requestId, 'practice.session.update', { sessionId, ...input }, async (tx) => {
    const s = await requireSession(tx, sessionId, actor.id, true);
    if (s.revision !== input.expectedRevision)
      fail('VERSION_CONFLICT', '练习进度已在其他位置更新');
    if (input.currentPosition !== undefined && input.currentPosition >= await tx.learningPracticeItem.count({ where: { sessionId } }))
      fail('INVALID_POSITION', '题号不存在', 400);
    const updated = await tx.learningPracticeSession.update({ where: { id: sessionId, revision: s.revision }, data: { ...(input.state ? { state: input.state } : {}), ...(input.currentPosition !== undefined ? { currentPosition: input.currentPosition } : {}), ...(input.state === 'finished' ? { finishedAt: now() } : {}), updatedAt: now(), revision: { increment: 1 } } });
    if (input.state) {
      const item = await tx.learningPracticeItem.findUnique({ where: { sessionId_position: { sessionId, position: updated.currentPosition } } });
      const version = item && await tx.learningQuestionVersion.findUnique({ where: { id: item.questionVersionId } });
      const node = version && await tx.learningNode.findUnique({ where: { id: version.nodeId } });
      // An archived source remains readable, but must not become a new resume target.
      if (node && !node.deletedAt && node.kind === 'item') await saveResumeNode(tx, actor.id, node.id);
    }
    return { session: await sessionView(tx, updated) };
  });
}
export async function regradePractice(attemptId: string, value: unknown, actor: Actor = ownerActor) {
  const input = z.object({ requestId: requestIdSchema, reason: z.string().trim().min(1).max(2000) }).strict().parse(value);
  return mutation(actor, input.requestId, 'practice.regrade', { attemptId, ...input }, async (tx) => {
    const a = await tx.learningAttempt.findUnique({ where: { id: attemptId } });
    if (!a || a.ownerId !== actor.id)
      fail('NOT_FOUND', '作答不存在', 404);
    const { session, question, version: sourceVersion } = await requireItem(tx, a!.itemId, actor.id);
    const sourceQuestion = await tx.learningQuestion.findUnique({ where: { id: sourceVersion.questionId } });
    if (!sourceQuestion || sourceQuestion.archived) fail('QUESTION_UNAVAILABLE', '此题已停用，历史答案仍保留');
    const version = a!.gradingVersion + 1;
    await tx.learningAttempt.update({ where: { id: attemptId, gradingVersion: a!.gradingVersion }, data: { gradingVersion: version, gradingState: 'queued', error: null } });
    await tx.learningJob.updateMany({ where: { attemptId, state: { in: ['queued', 'running'] } }, data: { state: 'cancelled', leaseExpiresAt: null, outputJson: JSON.stringify({ supersededByVersion: version }), updatedAt: now() } });
    const job = await tx.learningJob.create({ data: { id: id(), ownerId: actor.id, kind: 'grade', mapId: session.mapId, sessionId: session.id, attemptId, gradingVersion: version, inputJson: JSON.stringify({ question, answer: json(a!.answerJson), assistance: { assisted: a!.assisted, solutionViewed: a!.solutionViewed, uncertain: a!.assistanceUncertain }, reason: input.reason }), createdAt: now(), updatedAt: now() } });
    const v = await tx.learningQuestionVersion.findUniqueOrThrow({ where: { id: a!.questionVersionId } });
    await refreshReviewForQuestion(tx, actor.id, v.questionId, `dispute:${job.id}`);
    return { job: jobView(job) };
  });
}
export async function updatePracticeJob(jobId: string, operation: 'retry' | 'cancel', value: unknown, actor: Actor = ownerActor) {
  const input = z.object({ requestId: requestIdSchema }).strict().parse(value);
  return mutation(actor, input.requestId, `practice.job.${operation}`, { jobId, ...input }, async (tx) => {
    const j = await tx.learningJob.findUnique({ where: { id: jobId } });
    if (!j || j.ownerId !== actor.id)
      fail('NOT_FOUND', '任务不存在', 404);
    if (j!.adoptedSessionId)
      fail('CANDIDATE_ADOPTED', '题集已经采用，不能重新生成');
    if (operation === 'retry' && !['failed', 'cancelled'].includes(j!.state))
      fail('JOB_NOT_RETRYABLE', '任务尚未失败或取消');
    if (operation === 'cancel' && j!.state === 'succeeded')
      fail('JOB_FINISHED', '任务已经完成');
    if (j!.attemptId) {
      const a = await tx.learningAttempt.findUniqueOrThrow({ where: { id: j!.attemptId } });
      if (operation === 'retry') {
        const version = await tx.learningQuestionVersion.findUniqueOrThrow({ where: { id: a.questionVersionId } });
        const question = await tx.learningQuestion.findUnique({ where: { id: version.questionId } });
        if (!question || question.archived) fail('QUESTION_UNAVAILABLE', '此题已停用，历史答案仍保留');
      }
      if (a.gradingVersion !== j!.gradingVersion)
        fail('STALE_GRADING', '已有更新的复核任务');
      await tx.learningAttempt.update({ where: { id: a.id }, data: { gradingState: operation === 'retry' ? 'queued' : 'failed', error: operation === 'cancel' ? '判题已取消；原答案已保存' : null } });
    }
    const job = await tx.learningJob.update({ where: { id: jobId }, data: { state: operation === 'retry' ? 'queued' : 'cancelled', retries: operation === 'retry' ? 0 : j!.retries, leaseToken: null, leaseExpiresAt: null, error: null, updatedAt: now() } });
    return { job: jobView(job) };
  });
}
export async function updatePracticeReview(value: unknown, actor: Actor = ownerActor) {
  const input = reviewUpdateSchema.parse(value);
  return mutation(actor, input.requestId, 'practice.review.update', input, async (tx) => {
    let virtualNode: Awaited<ReturnType<typeof requireNode>> | null = null;
    if (input.id?.startsWith('node:')) {
      virtualNode = await requireNode(tx, input.id.slice(5));
      if (virtualNode.revision !== input.expectedRevision || virtualNode.status !== 'review')
        fail('VERSION_CONFLICT', '知识点状态已变化，请刷新复习列表');
    }
    let existing = input.id && !virtualNode ? await tx.learningReviewItem.findUnique({ where: { id: input.id } }) : null;
    if (input.id && !virtualNode && (!existing || existing.ownerId !== actor.id))
      fail('NOT_FOUND', '复习安排不存在', 404);
    if (existing) {
      if (input.expectedRevision !== existing.revision)
        fail('VERSION_CONFLICT', '复习安排已更新');
      await requireNode(tx, existing.nodeId, existing.mapId);
      if (existing.questionId) {
        const question = await tx.learningQuestion.findUnique({ where: { id: existing.questionId } });
        if (!question || question.archived) fail('QUESTION_UNAVAILABLE', '此题已停用，历史答案仍保留');
      }
    }
    else {
      if (!virtualNode && (!input.mapId || !input.nodeId))
        fail('INVALID_INPUT', '新增复习需要主题和知识点', 400);
      const node = virtualNode ?? await requireNode(tx, input.nodeId!, input.mapId);
      if (input.questionId) {
        const q = await tx.learningQuestion.findUnique({ where: { id: input.questionId } });
        if (!q || q.archived || q.nodeId !== node.id)
          fail('INVALID_INPUT', '题目不属于当前知识点', 400);
      }
      const scopeKey = input.questionId ? `question:${input.questionId}` : `node:${node.id}`;
      existing = await tx.learningReviewItem.findUnique({ where: { ownerId_scopeKey: { ownerId: actor.id, scopeKey } } });
      if (existing)
        fail('REVIEW_EXISTS', '该内容已有复习安排，请读取后更新');
      existing = await tx.learningReviewItem.create({ data: { id: id(), ownerId: actor.id, scopeKey, mapId: node.mapId, nodeId: node.id, questionId: input.questionId ?? null, title: node.title, reasonsJson: '["manual"]', updatedAt: now() } });
    }
    const before = reviewView(existing!);
    const data = { ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt).toISOString() : null } : {}), ...(input.paused !== undefined ? { paused: input.paused } : {}), ...(input.policy ? { policy: input.policy, policyVersion: input.policy === 'manual' ? 'manual-v1' : 'spaced-v1', manualSchedule: input.policy === 'manual' } : {}), ...(input.dueAt !== undefined ? { manualSchedule: true } : {}), reasonsJson: JSON.stringify([...new Set([...json<string[]>(existing!.reasonsJson), 'manual'])]), revision: { increment: 1 }, updatedAt: now() };
    const row = await tx.learningReviewItem.update({ where: { id: existing!.id, revision: existing!.revision }, data });
    await tx.learningReviewEvent.create({ data: { id: id(), reviewId: row.id, eventKey: `manual:${actor.id}:${input.requestId}`, kind: 'manual', beforeJson: JSON.stringify(before), afterJson: JSON.stringify(reviewView(row)), createdAt: now() } });
    return { review: reviewView(row) };
  });
}
async function saveResumeNode(db: Db, ownerId: string, nodeId: string) {
  const node = await requireNode(db, nodeId);
  const row = await db.learningResumeState.upsert({ where: { ownerId }, create: { ownerId, nodeId: node.id, mapId: node.mapId, nodeTitle: node.title, updatedAt: now() }, update: { nodeId: node.id, mapId: node.mapId, nodeTitle: node.title, updatedAt: now() } });
  return { nodeId: row.nodeId, mapId: row.mapId, nodeTitle: row.nodeTitle, updatedAt: row.updatedAt };
}
export async function recordLearningResume(input: {
  nodeId: string;
  reason: string;
}, actor: Actor = ownerActor, tx?: Db) {
  owner(actor);
  const save = (db: Db) => saveResumeNode(db, actor.id, input.nodeId);
  return tx ? save(tx) : runSerializedCommand(save);
}
export async function saveLearningResume(value: unknown, actor: Actor = ownerActor) {
  const input = z.object({ requestId: requestIdSchema, nodeId: z.string().min(1), reason: z.enum(['start', 'note_saved', 'message_sent']) }).strict().parse(value);
  return mutation(actor, input.requestId, 'learning.resume', input, async (tx) => ({ resume: await recordLearningResume(input, actor, tx) }));
}
/** Trusted chat integration only. No route/tool accepts arbitrary assistance claims. */
export async function recordPracticeAssistance(input: {
  sessionId?: string;
  sessionItemId: string;
  activeAttemptId: string;
  sourceMessageId: string;
  stage: 'requested' | 'delivered' | 'failed';
  solutionExposed?: boolean;
}, actor: Actor = ownerActor, transaction?: Db) {
  owner(actor);
  const execute = async (tx: Db) => {
    const { item, session, draft } = await requireItem(tx, input.sessionItemId, actor.id);
    if (input.sessionId && input.sessionId !== session.id)
      fail('INVALID_REFERENCE', '题目与练习会话不一致', 400);
    const attempt = await tx.learningAttempt.findUnique({ where: { id: input.activeAttemptId } });
    if (draft.activeAttemptId !== input.activeAttemptId && (!attempt || attempt.itemId !== item.id || attempt.ownerId !== actor.id))
      fail('INVALID_REFERENCE', '辅导引用的作答不存在', 400);
    const message = await tx.message.findUnique({ where: { id: input.sourceMessageId }, include: { conversation: { select: { identityId: true } } } });
    if (!message || message.role !== 'user' || message.conversation.identityId !== 'study')
      fail('INVALID_REFERENCE', '辅导必须引用学习会话的真实用户消息', 400);
    const type = input.solutionExposed && input.stage === 'delivered' ? 'assistance_solution' : `assistance_${input.stage}`;
    const eventKey = `chat:${item.id}:${input.activeAttemptId}:${input.sourceMessageId}:${type}`;
    const duplicate = await tx.learningPracticeEvent.findUnique({ where: { eventKey } });
    if (duplicate)
      return { eventId: duplicate.id, sessionId: session.id, itemId: item.id, activeAttemptId: input.activeAttemptId, stage: input.stage };
    const event = await tx.learningPracticeEvent.upsert({ where: { eventKey }, create: { id: id(), ownerId: actor.id, itemId: item.id, activeAttemptId: input.activeAttemptId, type, sourceMessageId: input.sourceMessageId, eventKey, payloadJson: JSON.stringify({ attemptSubmitted: Boolean(attempt) }), createdAt: now() }, update: {} });
    // Submission freezes its own evidence set. Later help must never be pulled
    // into an earlier answer merely because both belong to the same question.
    if (input.stage !== 'requested')
      await resolveSubmittedAssistance(tx, item.id, input.sourceMessageId, event.id);
    return { eventId: event.id, sessionId: session.id, itemId: item.id, activeAttemptId: input.activeAttemptId, stage: input.stage };
  };
  return transaction ? execute(transaction) : runSerializedCommand(execute);
}
