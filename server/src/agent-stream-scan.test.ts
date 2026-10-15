import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from './infrastructure/prisma.js';
import { ContextService } from './application/conversation.js';
import { AutoMemoryService } from './application/auto-memory.js';
import { followRun, resetRunSchedulerState, scheduleRun, startChat } from './agent/runs.js';

const topicIds: string[] = [];
const conversationIds: string[] = [];
afterEach(async () => {
  resetRunSchedulerState();
  await prisma.autoMemoryTurn.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.agentRun.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.autoMemorySource.deleteMany({ where: { scopeKey: { in: topicIds.map((id) => `topic:${id}`) } } });
  await prisma.autoMemoryScope.deleteMany({ where: { topicId: { in: topicIds } } });
  await prisma.materialVersion.deleteMany({ where: { material: { topicId: { in: topicIds } } } });
  await prisma.material.deleteMany({ where: { topicId: { in: topicIds } } });
  await prisma.task.deleteMany({ where: { topicId: { in: topicIds } } });
  await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
  topicIds.length = 0; conversationIds.length = 0;
});

describe('chat persistence during memory scanning', () => {
  it('keeps two streamed replies complete and ordered while scanning 150 tasks and a 500k-character material', async () => {
    // Other suites may leave completed turns whose fixture topics were removed.
    // The scan in this integration should archive only this test's conversations.
    await prisma.autoMemoryTurn.deleteMany();
    const topic = await prisma.topic.create({ data: { name: `stream-scan-${randomUUID()}` } });
    topicIds.push(topic.id);
    await prisma.task.createMany({ data: Array.from({ length: 150 }, (_, i) => ({ topicId: topic.id, title: `任务 ${i}`, description: '稳定事实 '.repeat(30) })) });
    await prisma.material.create({ data: { topicId: topic.id, kind: 'text', title: '大资料', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), versions: { create: { revision: 1, content: '事实'.repeat(250_000), contentHash: 'large-source-fixture', createdAt: new Date().toISOString() } } } });
    const service = new AutoMemoryService({ now: () => new Date(), hasModelConfig: async () => false, model: { complete: async () => ({ text: '' }) } });
    const runs = [];
    for (let i = 0; i < 2; i += 1) {
      const run = await startChat({ message: '检查并发回复', context: { schemaVersion: 2, page: 'topic', scope: { kind: 'topic', topicId: topic.id }, taskId: null, materialId: null, selectedTaskIds: [], taskFilter: null, timeZone: 'Asia/Shanghai', referencedApprovalId: null } });
      conversationIds.push(run.conversationId);
      runs.push(run);
    }
    const chunks = Array.from({ length: 800 }, (_, i) => `${i}青🐦`);
    for (const run of runs) scheduleRun(run.id, async function* () {
      for (let i = 0; i < chunks.length; i += 1) {
        yield { text: chunks[i] };
        if (i % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }, new ContextService());
    const scan = service.scan();
    await Promise.all([scan, ...runs.map(async (run) => {
      const events = [];
      for await (const event of followRun(run.id)) events.push(event);
      const saved = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(saved.state, saved.errorMessage ?? '').toBe('completed');
      const deltas = events.filter((event) => event.type === 'message_delta');
      expect(deltas.map((event) => event.type === 'message_delta' ? event.delta : '').join('')).toBe(chunks.join(''));
      expect(deltas.length).toBeLessThan(20);
      const assistant = await prisma.message.findFirstOrThrow({ where: { conversationId: run.conversationId, role: 'assistant' } });
      expect(assistant.content).toBe(chunks.join(''));
      expect(events.findIndex((event) => event.type === 'message_end')).toBeGreaterThan(events.reduce((last, event, index) => event.type === 'message_delta' ? index : last, -1));
    })]);
    expect(await prisma.autoMemorySource.count({ where: { scopeKey: `topic:${topic.id}`, sourceType: 'task', available: true } })).toBe(150);
    expect(await prisma.autoMemorySource.count({ where: { scopeKey: `topic:${topic.id}`, sourceType: 'material', available: true } })).toBeGreaterThan(40);
  }, 30_000);
});
