import { z } from 'zod';
import { DomainError } from '../domain/task.js';
import { canonicalRecurrenceRuleText, isRecurrenceRuleText } from '../domain/recurrence.js';

export function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

const id = z.string().trim().min(1);
export const calendarDate = z.string().refine(isCalendarDate, '日期必须是有效的 YYYY-MM-DD 日历日期');
const localDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export function isLocalDateTime(value: string) {
  if (!localDateTimePattern.test(value)) return false;
  const [date, time] = value.split('T');
  if (!isCalendarDate(date)) return false;
  const [hour, minute] = time.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}
export const localDateTime = z.string().refine(isLocalDateTime, '时间必须是有效的 YYYY-MM-DDTHH:mm 本地时间');
const positiveMinutes = z.number().int().min(1, '时长必须至少 1 分钟').max(10080, '时长不能超过一周');
const recurrenceRule = z.string().max(200).refine(isRecurrenceRuleText, '重复规则无效').transform(canonicalRecurrenceRuleText);
export const taskFields = z.object({
  topicId: id.nullable().optional(),
  parentId: id.nullable().optional(),
  title: z.string().trim().min(1, '任务标题不能为空'),
  description: z.string().optional(),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
  priority: z.enum(['none', 'low', 'medium', 'high']).optional(),
  dueDate: calendarDate.nullable().optional(),
  estimatedMinutes: positiveMinutes.nullable().optional(),
  scheduledStart: localDateTime.nullable().optional(),
  scheduledEnd: localDateTime.nullable().optional(),
  resultSummary: z.string().optional(),
  recurrenceRule: recurrenceRule.optional(),
  // null 跟随全局默认；-1 不提醒；0 准时；正数提前分钟数（最多 30 天）。
  reminderMinutesBefore: z.number().int().min(-1, '提醒提前量无效').max(43200, '提醒提前量最多 30 天').nullable().optional(),
  tagIds: z.array(id).refine((ids) => new Set(ids).size === ids.length, '标签不能重复').optional(),
});
export const taskCreateSchema = taskFields;
export const taskUpdateSchema = taskFields.partial().extend({ completeChildren: z.boolean().optional() });
export const tagColors = ['violet', 'blue', 'teal', 'green', 'amber', 'rose', 'slate'] as const;
const tagColor = z.enum(tagColors);
export const topicCreateSchema = z.object({
  name: z.string().trim().min(1, '清单名称不能为空'),
  description: z.string().optional(),
  color: tagColor.optional(),
  isExploration: z.boolean().optional(),
  goal: z.string().optional(),
  goalDueDate: calendarDate.nullable().optional(),
});
export const topicUpdateSchema = topicCreateSchema.partial().extend({ draftSummary: z.string().optional() });
export const tagCreateSchema = z.object({
  name: z.string().trim().min(1, '标签名称不能为空'),
  color: tagColor.optional(),
});
export const tagUpdateSchema = z.object({
  name: z.string().trim().min(1, '标签名称不能为空').optional(),
  color: tagColor.optional(),
}).refine((value) => value.name !== undefined || value.color !== undefined, '标签修改不能为空');
export const reorderSchema = z.object({
  topicId: id.nullable(),
  parentId: id.nullable(),
  orderedTaskIds: z.array(id).refine((ids) => new Set(ids).size === ids.length, '任务 ID 不能重复'),
});
export const taskListSchema = z.object({
  inbox: z.boolean().optional(),
  q: z.string().optional(),
  status: z.enum(['open', 'done', 'all', 'todo', 'doing', 'blocked']).optional(),
  dueFrom: calendarDate.optional(),
  dueTo: calendarDate.optional(),
  scheduledFrom: calendarDate.optional(),
  scheduledTo: calendarDate.optional(),
  tagIds: z.array(id).optional(),
  sort: z.enum(['manual', 'date', 'priority']).optional(),
  includeArchived: z.boolean().optional(),
  includeDeleted: z.boolean().optional(),
  parentId: id.nullable().optional(),
});
export type TaskListOptions = z.infer<typeof taskListSchema>;

export const focusSessionCreateSchema = z.object({
  taskId: id.nullable(),
  kind: z.enum(['focus', 'break']).default('focus'),
  startedAt: localDateTime,
  endedAt: localDateTime,
  durationMinutes: z.number().int().min(0).max(1440),
  plannedMinutes: positiveMinutes.default(25),
  completed: z.boolean().default(true),
}).refine((value) => value.startedAt < value.endedAt, '结束时间必须晚于开始时间');
export const focusSessionListSchema = z.object({
  taskId: id.optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// Strip explicitly undefined properties as well as unknown adapter fields.
// This keeps omission identical for REST and programmatic/Tool callers.
export function parseInput<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DomainError('INVALID_INPUT', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), 400);
  return Object.fromEntries(Object.entries(parsed.data).filter(([, field]) => field !== undefined));
}
