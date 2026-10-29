import { z } from 'zod';
import type { PracticeAnswer, PracticeConfig } from '../../domain/learning-practice.js';
export const requestIdSchema = z.string().min(1).max(200);
export const answerSchema = z.union([z.string().max(20000), z.array(z.string().max(200)).max(20)]);
export const configSchema = z.object({
  mapId: z.string().min(1), nodeIds: z.array(z.string().min(1)).min(1).max(100).optional(),
  mode: z.enum(['knowledge', 'wrong', 'review', 'mixed']).default('knowledge'),
  goal: z.string().max(2000).default(''), count: z.number().int().min(1).max(20).default(5),
  types: z.array(z.enum(['single', 'multiple', 'boolean', 'short'])).min(1).max(4).default(['single', 'short']),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'), language: z.string().max(30).default('zh-CN'),
}).strict();
export type FrozenConfig = z.infer<typeof configSchema>;
export const questionSchema = z.object({
  nodeId: z.string().min(1), type: z.enum(['single', 'multiple', 'boolean', 'short']),
  prompt: z.string().trim().min(1).max(6000),
  options: z.array(z.object({ id: z.string().min(1).max(50), text: z.string().trim().min(1).max(2000) }).strict()).max(12),
  answer: answerSchema, explanation: z.string().trim().min(1).max(6000),
  rubric: z.string().trim().min(1).max(4000), hints: z.array(z.string().trim().min(1).max(2000)).max(3),
  difficulty: z.enum(['easy', 'medium', 'hard']), objective: z.string().trim().min(1).max(500),
  source: z.object({ kind: z.enum(['note', 'model_example']), label: z.string().max(500), nodeRevision: z.number().int().positive().optional() }).strict(),
  variantOfQuestionVersionId: z.string().min(1).max(200).optional(),
}).strict().superRefine((q, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(q.options.map(o => o.id)).size !== q.options.length || new Set(q.options.map(o => o.text.trim().toLowerCase())).size !== q.options.length)
    issue('题目选项不能重复');
  if (q.type === 'short') {
    if (typeof q.answer !== 'string' || !q.answer.trim() || q.options.length)
      issue('简答题必须提供参考答案且无选择项');
  }
  else {
    if (q.options.length < 2 || q.type === 'boolean' && q.options.length !== 2)
      issue('选择题选项数量无效');
    const answers = typeof q.answer === 'string' ? [q.answer] : q.answer;
    if (!answers.length || new Set(answers).size !== answers.length || answers.some(a => !q.options.some(o => o.id === a)))
      issue('正确答案必须对应唯一选项');
    if (q.type !== 'multiple' && (typeof q.answer !== 'string' || answers.length !== 1))
      issue('单选/判断题只能有一个正确选项');
    if (q.type === 'multiple' && !Array.isArray(q.answer))
      issue('多选题答案必须为数组');
  }
});
export type FrozenQuestion = z.infer<typeof questionSchema>;
export const candidateSchema = z.object({ title: z.string().trim().min(1).max(200), questions: z.array(questionSchema).min(1).max(20) }).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export const gradeSchema = z.object({
  result: z.enum(['correct', 'partial', 'incorrect', 'unresolved']), score: z.number().min(0).max(100).nullable(),
  maxScore: z.number().positive().max(100), explanation: z.string().min(1).max(6000),
  strengths: z.string().max(4000), mistakes: z.array(z.string().max(1000)).max(20), needsReview: z.boolean(),
}).strict().superRefine((g, ctx) => {
  if (g.score !== null && g.score > g.maxScore)
    ctx.addIssue({ code: 'custom', message: '得分不能高于满分' });
  if (g.result === 'correct' && g.score !== g.maxScore || g.result === 'incorrect' && g.score !== 0)
    ctx.addIssue({ code: 'custom', message: '得分和结果不一致' });
});
export type GradeResult = z.infer<typeof gradeSchema>;
export const draftSchema = z.object({ requestId: requestIdSchema, activeAttemptId: z.string().min(1), expectedDraftRevision: z.number().int().positive(), answer: answerSchema }).strict();
export const submitSchema = draftSchema.extend({ questionVersionId: z.string().min(1), clientAttemptId: z.string().min(1).max(200) }).strict();
export const sessionUpdateSchema = z.object({ requestId: requestIdSchema, expectedRevision: z.number().int().positive(), currentPosition: z.number().int().nonnegative().optional(), state: z.enum(['active', 'paused', 'finished']).optional() }).strict();
export const reviewUpdateSchema = z.object({ requestId: requestIdSchema, id: z.string().min(1).optional(), expectedRevision: z.number().int().positive().optional(), mapId: z.string().optional(), nodeId: z.string().optional(), questionId: z.string().nullable().optional(), dueAt: z.string().datetime({ offset: true }).nullable().optional(), paused: z.boolean().optional(), policy: z.enum(['manual', 'spaced-v1']).optional() }).strict();
export function validAnswer(q: FrozenQuestion, answer: PracticeAnswer) {
  if (q.type === 'short')
    return typeof answer === 'string' && answer.trim().length > 0;
  if (q.type === 'multiple')
    return Array.isArray(answer) && answer.length > 0 && new Set(answer).size === answer.length && answer.every(a => q.options.some(o => o.id === a));
  return typeof answer === 'string' && q.options.some(o => o.id === answer);
}
export function parseJson(text: string): unknown {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (raw.length > 200000)
    throw new Error('模型输出超过限制');
  return JSON.parse(raw);
}
