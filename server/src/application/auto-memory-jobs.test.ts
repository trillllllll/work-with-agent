import { afterEach, expect, it } from 'vitest';
import { prisma } from '../infrastructure/prisma.js';
import { listMemoryJobs, memoryJobsQuery } from './auto-memory-jobs.js';
import { ownerActor } from './security.js';
const topicId = 'usage-statistics-test';
afterEach(async () => {
  await prisma.autoMemoryJob.deleteMany({ where: { scopeKey: 'topic:' + topicId } });
  await prisma.topic.deleteMany({ where: { id: topicId } });
});
it('aggregates all matched jobs across pages, preserves unknowns, and excludes private content', async () => {
  await prisma.topic.create({ data: { id: topicId, name: '用量测试' } });
  for (let i = 0; i < 25; i++) await prisma.autoMemoryJob.create({ data: {
    scopeKey: 'topic:' + topicId, inputHash: 'usage-' + i, snapshot: 'private snapshot', modelOutput: 'private model output',
    requestedModel: i < 23 ? 'model-A' : null, provider: i < 23 ? 'api.example' : null,
    inputTokens: i < 23 ? 10 : null, outputTokens: i < 23 ? 2 : null, totalTokens: i < 23 ? 12 : null,
    usageStatus: i < 23 ? 'reported' : 'legacy', status: i < 23 ? 'failed' : 'completed', createdAt: '2026-10-16T03:' + String(i).padStart(2, '0') + ':00.000Z',
  } });
  const page = await listMemoryJobs(ownerActor, { topicId, limit: 20 });
  expect(page.items).toHaveLength(20);
  expect(page.total).toBe(25);
  expect(page.nextCursor).toBe(20);
  expect(page.summary).toEqual({ jobCount: 25, inputTokens: 230, outputTokens: 46, totalTokens: 276, missingUsageCount: 2 });
  expect(page.items[0]).toMatchObject({ scopeName: '用量测试', requestedModel: null, totalTokens: null });
  expect(JSON.stringify(page)).not.toContain('private');
  const filtered = await listMemoryJobs(ownerActor, { topicId, model: 'model-A', provider: 'api.example', status: 'failed', from: '2026-10-16T03:05:00Z', to: '2026-10-16T03:10:00Z' });
  expect(filtered.total).toBe(5);
  expect(filtered.summary.totalTokens).toBe(60);
  expect((await listMemoryJobs(ownerActor, { topicId, cursor: 20 })).items).toHaveLength(5);
});
it('validates ranges by instants rather than string offset ordering', () => {
  expect(memoryJobsQuery.safeParse({ from: '2026-10-16T10:00:00+08:00', to: '2026-10-16T03:00:00Z' }).success).toBe(true);
  expect(memoryJobsQuery.safeParse({ from: '2026-10-16T10:00:00Z', to: '2026-10-16T03:00:00Z' }).success).toBe(false);
});
