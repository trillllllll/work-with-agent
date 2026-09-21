import { z } from 'zod';
import { DomainError } from '../domain/task.js';

export function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

const id = z.string().trim().min(1);
export const calendarDate = z.string().refine(isCalendarDate, '日期必须是有效的 YYYY-MM-DD 日历日期');
export const taskCreateSchema = z.object({
  topicId: id.nullable().optional(),
  parentId: id.nullable().optional(),
  title: z.string().trim().min(1, '任务标题不能为空'),
  description: z.string().optional(),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
  priority: z.enum(['none', 'low', 'medium', 'high']).optional(),
  dueDate: calendarDate.nullable().optional(),
  resultSummary: z.string().optional(),
  tagIds: z.array(id).refine((ids) => new Set(ids).size === ids.length, '标签不能重复').optional(),
});
export const taskUpdateSchema = taskCreateSchema.partial().extend({ completeChildren: z.boolean().optional() });
export const topicCreateSchema = z.object({
  name: z.string().trim().min(1, '清单名称不能为空'),
  description: z.string().optional(),
  isExploration: z.boolean().optional(),
  goal: z.string().optional(),
});
export const topicUpdateSchema = topicCreateSchema.partial().extend({ draftSummary: z.string().optional() });
export const tagSchema = z.object({ name: z.string().trim().min(1, '标签名称不能为空') });
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
  tagIds: z.array(id).optional(),
  sort: z.enum(['manual', 'date', 'priority']).optional(),
  includeArchived: z.boolean().optional(),
  includeDeleted: z.boolean().optional(),
  parentId: id.nullable().optional(),
});
export type TaskListOptions = z.infer<typeof taskListSchema>;

// Strip explicitly undefined properties as well as unknown adapter fields.
// This keeps omission identical for REST and programmatic/Tool callers.
export function parseInput<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DomainError('INVALID_INPUT', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), 400);
  return Object.fromEntries(Object.entries(parsed.data).filter(([, field]) => field !== undefined));
}
