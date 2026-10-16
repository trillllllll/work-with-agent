import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../infrastructure/prisma.js';
import { assertOwner, type Actor } from './security.js';
import { AUTO_JOB_STATUSES, scopeKey } from './auto-memory-types.js';

export const memoryJobsQuery = z.object({
  topicId: z.string().min(1).default('inbox'),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  model: z.string().min(1).max(200).optional(),
  provider: z.string().min(1).max(253).optional(),
  status: z.enum(AUTO_JOB_STATUSES).optional(),
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).refine((data) => !data.from || !data.to || Date.parse(data.from) <= Date.parse(data.to), { message: '开始时间不能晚于结束时间', path: ['from'] });

export async function listMemoryJobs(actor: Actor, input: unknown) {
  assertOwner(actor);
  const query = memoryJobsQuery.parse(input);
  const scope: Prisma.AutoMemoryJobWhereInput = query.topicId === 'all' ? {} : { scopeKey: scopeKey(query.topicId === 'inbox' ? null : query.topicId) };
  const base: Prisma.AutoMemoryJobWhereInput = { ...scope, ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: new Date(query.from).toISOString() } : {}), ...(query.to ? { lt: new Date(query.to).toISOString() } : {}) } } : {}) };
  const where: Prisma.AutoMemoryJobWhereInput = { ...base, ...(query.model ? { requestedModel: query.model } : {}), ...(query.provider ? { provider: query.provider } : {}), ...(query.status ? { status: query.status } : {}) };
  const select = { id: true, scopeKey: true, status: true, attempt: true, requestedModel: true, responseModel: true, provider: true, inputTokens: true, outputTokens: true, totalTokens: true, usageStatus: true, reusedFromJobId: true, errorCode: true, errorMessage: true, createdAt: true, startedAt: true, completedAt: true } as const;
  const [rows, total, sums, missingUsageCount, models, providers, topics] = await prisma.$transaction([
    prisma.autoMemoryJob.findMany({ where, select, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: query.cursor, take: query.limit }),
    prisma.autoMemoryJob.count({ where }),
    prisma.autoMemoryJob.aggregate({ where: { ...where, reusedFromJobId: null }, _sum: { inputTokens: true, outputTokens: true, totalTokens: true } }),
    prisma.autoMemoryJob.count({ where: { ...where, reusedFromJobId: null, OR: [{ inputTokens: null }, { outputTokens: null }, { totalTokens: null }] } }),
    prisma.autoMemoryJob.findMany({ where: { ...base, requestedModel: { not: null } }, select: { requestedModel: true }, distinct: ['requestedModel'], orderBy: { requestedModel: 'asc' } }),
    prisma.autoMemoryJob.findMany({ where: { ...base, provider: { not: null } }, select: { provider: true }, distinct: ['provider'], orderBy: { provider: 'asc' } }),
    prisma.topic.findMany({ select: { id: true, name: true } }),
  ]);
  const names = new Map(topics.map((topic) => [scopeKey(topic.id), topic.name]));
  return {
    items: rows.map((row) => ({
      ...row,
      scopeName: row.scopeKey === 'inbox' ? '收集箱' : names.get(row.scopeKey) ?? '已移除清单',
      durationMs: row.startedAt && row.completedAt ? Math.max(0, Date.parse(row.completedAt) - Date.parse(row.startedAt)) : null,
    })),
    total, nextCursor: query.cursor + rows.length < total ? query.cursor + rows.length : null,
    summary: { jobCount: total, ...sums._sum, missingUsageCount },
    filters: { models: models.map((row) => row.requestedModel!), providers: providers.map((row) => row.provider!) },
  };
}
