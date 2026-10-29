import type { ModelMessage } from '../../agent.js';
import { activeSyncBinding } from '../sync-replica.js';
import { coordinatorWork } from '../coordinator-work.js';
import { prisma, id, now, json, commandDigest, runSerializedCommand } from './store.js';
import { candidateSchema, gradeSchema, parseJson, type GradeResult, type FrozenQuestion } from './input.js';
import type { GenerationInput } from './service.js';
import { refreshReviewForQuestion } from './reviews.js';
import type { LearningJob } from '@prisma/client';
import { ZodError } from 'zod';
import { generatePrompt, gradePrompt } from './prompts.js';
export interface PracticeModel {
  complete(messages: ModelMessage[], signal?: AbortSignal): Promise<{
    text: string;
    usage?: {
      model?: string;
    };
    model?: string;
  }>;
}
let injected: PracticeModel | null = null;
export function setPracticeModel(model: PracticeModel | null) {
  injected = model;
}
async function complete(messages: ModelMessage[], signal: AbortSignal) {
  if (injected)
    return injected.complete(messages, signal);
  const { ModelAdapter } = await import('../../agent.js');
  const adapter = new ModelAdapter();
  let text = '';
  let model: string | undefined;
  for await (const delta of adapter.stream(messages, signal, false, [], 'study')) {
    text += delta.text ?? '';
    if (text.length > 200000)
      throw new Error('模型输出超过限制');
    if (delta.toolCalls?.length)
      throw new Error('练习生成或判题不允许调用工具');
    if (delta.usage?.model)
      model = delta.usage.model;
  }
  return { text, model };
}
async function claimJob() {
  return runSerializedCommand(async (tx) => {
    const stamp = now();
    const job = await tx.learningJob.findFirst({ where: { OR: [{ state: 'queued' }, { state: 'running', leaseExpiresAt: { lt: stamp } }] }, orderBy: { createdAt: 'asc' } });
    if (!job)
      return null;
    if (job.retries >= 3) {
      await tx.learningJob.update({ where: { id: job.id }, data: { state: 'failed', leaseToken: null, leaseExpiresAt: null, error: '任务多次中断，请手动重试', updatedAt: stamp } });
      if (job.attemptId)
        await tx.learningAttempt.updateMany({ where: { id: job.attemptId, gradingVersion: job.gradingVersion! }, data: { gradingState: 'failed', error: '判题中断；答案已保存' } });
      return null;
    }
    const token = id();
    const updated = await tx.learningJob.updateMany({ where: { id: job.id, state: job.state, leaseToken: job.leaseToken }, data: { state: 'running', leaseToken: token, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), retries: { increment: 1 }, updatedAt: stamp } });
    if (!updated.count)
      return null;
    if (job.attemptId)
      await tx.learningAttempt.updateMany({ where: { id: job.attemptId, gradingVersion: job.gradingVersion! }, data: { gradingState: 'running', error: null } });
    return { ...job, state: 'running', leaseToken: token };
  });
}
const sameLease = (job: LearningJob | null, claim: LearningJob) => job?.state === 'running' && job.leaseToken === claim.leaseToken;
function ruleGrade(q: FrozenQuestion, answer: unknown): GradeResult {
  const sorted = (x: unknown) => Array.isArray(x) ? [...x].sort() : x;
  const correct = commandDigest(sorted(q.answer)) === commandDigest(sorted(answer));
  return { result: correct ? 'correct' : 'incorrect', score: correct ? 1 : 0, maxScore: 1, explanation: q.explanation, strengths: correct ? '所选答案与本题规则一致。' : '', mistakes: correct ? [] : [q.objective], needsReview: false };
}
async function performJob(claim: LearningJob) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('模型任务超时')), 90000);
  timeout.unref();
  try {
    if (claim.kind === 'generate') {
      const input = json<GenerationInput>(claim.inputJson);
      const response = await complete([{ role: 'system', content: generatePrompt }, { role: 'user', content: JSON.stringify(input) }], controller.signal);
      const candidate = candidateSchema.parse(parseJson(response.text));
      if (candidate.questions.length !== input.config.count)
        throw new Error('生成题量与配置不一致');
      const seen = new Set<string>();
      for (const q of candidate.questions) {
        const node = input.nodes.find(n => n.id === q.nodeId);
        if (!node || !input.config.types.includes(q.type) || q.difficulty !== input.config.difficulty)
          throw new Error('生成题目超出选定知识点、题型或难度');
        const key = q.prompt.trim().toLowerCase();
        if (seen.has(key))
          throw new Error('生成题目存在重复题干');
        seen.add(key);
        if (q.variantOfQuestionVersionId) {
          const original = input.recentVersions?.find(v => v.id === q.variantOfQuestionVersionId && v.nodeId === q.nodeId);
          if (!original)
            throw new Error('变式的原题不在本次范围');
          const previous = input.recentAttempts.find(a => a.questionVersionId === original.id);
          if (previous?.prompt.trim().toLowerCase() === key)
            throw new Error('变式不能重复原题');
        }
        if (q.source.kind === 'note') {
          q.source = { kind: 'note', label: node.title, nodeRevision: node.revision };
        }
        else
          q.source = { kind: 'model_example', label: q.source.label || '模型自拟示例' };
      }
      await runSerializedCommand(async (tx) => {
        const current = await tx.learningJob.findUnique({ where: { id: claim.id } });
        if (!sameLease(current, claim))
          return;
        await tx.learningJob.update({ where: { id: claim.id }, data: { state: 'succeeded', outputJson: JSON.stringify(candidate), candidateRevision: commandDigest(candidate), model: response.model ?? response.usage?.model ?? null, leaseToken: null, leaseExpiresAt: null, error: null, updatedAt: now() } });
      });
    }
    else {
      const input = json<{
        question: FrozenQuestion;
        answer: unknown;
        assistance: unknown;
        reason: string;
      }>(claim.inputJson);
      let result: GradeResult, method = 'rule', model: string | null = null;
      if (input.question.type === 'short' || input.reason) {
        method = 'model';
        const response = await complete([{ role: 'system', content: gradePrompt }, { role: 'user', content: JSON.stringify(input) }], controller.signal);
        result = gradeSchema.parse(parseJson(response.text));
        model = response.model ?? response.usage?.model ?? null;
      }
      else
        result = ruleGrade(input.question, input.answer);
      if (result.needsReview || result.result === 'unresolved') {
        result.result = 'unresolved';
        result.score = null;
        result.needsReview = true;
      }
      await runSerializedCommand(async (tx) => {
        const current = await tx.learningJob.findUnique({ where: { id: claim.id } });
        const a = await tx.learningAttempt.findUnique({ where: { id: claim.attemptId! } });
        const supersededByVersion = current?.outputJson ? json<{
          supersededByVersion?: number;
        }>(current.outputJson).supersededByVersion : undefined;
        const auditOnly = current?.state === 'cancelled' && current.leaseToken === claim.leaseToken && Boolean(supersededByVersion) && a?.ownerId === claim.ownerId && a.gradingVersion > claim.gradingVersion!;
        if (!sameLease(current, claim) && !auditOnly)
          return;
        if (!a || a.ownerId !== claim.ownerId || a.gradingVersion !== claim.gradingVersion && !auditOnly) {
          await tx.learningJob.update({ where: { id: claim.id }, data: { state: 'cancelled', leaseToken: null, leaseExpiresAt: null, updatedAt: now() } });
          return;
        }
        const grade = await tx.learningGrade.upsert({ where: { attemptId_version: { attemptId: a.id, version: claim.gradingVersion! } }, create: { id: id(), attemptId: a.id, version: claim.gradingVersion!, method, state: result.needsReview ? 'needs_review' : 'succeeded', result: result.result, score: result.score, maxScore: result.maxScore, explanation: result.explanation, strengths: result.strengths, mistakesJson: JSON.stringify(result.mistakes), model, promptVersion: 'practice-grade-v1', createdAt: now() }, update: {} });
        if (auditOnly) {
          await tx.learningJob.update({ where: { id: claim.id }, data: { outputJson: JSON.stringify({ gradeId: grade.id, obsolete: true, supersededByVersion }), model, leaseToken: null, leaseExpiresAt: null, updatedAt: now() } });
          return;
        }
        await tx.learningAttempt.update({ where: { id: a.id, gradingVersion: claim.gradingVersion! }, data: { currentGradeId: grade.id, gradingState: grade.state, error: null } });
        await tx.learningJob.update({ where: { id: claim.id }, data: { state: 'succeeded', outputJson: JSON.stringify({ gradeId: grade.id }), model, leaseToken: null, leaseExpiresAt: null, error: null, updatedAt: now() } });
        const version = await tx.learningQuestionVersion.findUniqueOrThrow({ where: { id: a.questionVersionId } });
        await refreshReviewForQuestion(tx, a.ownerId, version.questionId, `grade:${grade.id}`);
      });
    }
  }
  catch (error) {
    // Provider messages and schema errors can embed hidden answers, model output
    // or transport credentials. Only publish controlled messages.
    const message = controller.signal.aborted ? '模型任务超时，请重试' : error instanceof ZodError || error instanceof SyntaxError ? '模型返回内容未通过校验，请重试' : '模型任务未能完成，请检查模型配置后重试';
    await runSerializedCommand(async (tx) => {
      const current = await tx.learningJob.findUnique({ where: { id: claim.id } });
      if (!sameLease(current, claim))
        return;
      await tx.learningJob.update({ where: { id: claim.id }, data: { state: 'failed', error: message, leaseToken: null, leaseExpiresAt: null, updatedAt: now() } });
      if (claim.attemptId)
        await tx.learningAttempt.updateMany({ where: { id: claim.attemptId, gradingVersion: claim.gradingVersion! }, data: { gradingState: 'failed', error: '答案已保存；' + message } });
    });
  }
  finally {
    clearTimeout(timeout);
  }
}
let running = false;
export async function runPracticeJobs(limit = 3) {
  if (running || activeSyncBinding())
    return 0;
  running = true;
  let count = 0;
  try {
    while (count < limit) {
      const claim = await claimJob();
      if (!claim)
        break;
      await performJob(claim);
      count++;
    }
    return count;
  }
  finally {
    running = false;
  }
}
export function startPracticeWorker() {
  const tick = () => void coordinatorWork(() => runPracticeJobs()).catch(() => { });
  const timer = setInterval(tick, 1500);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
