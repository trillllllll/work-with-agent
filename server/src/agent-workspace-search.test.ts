import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from './infrastructure/prisma.js';
import { searchWorkspace, walkSearch, type SearchSource } from './agent/workspace-search.js';
import type { StoredChatContext } from './agent/chat-context.js';

const stamp = () => new Date().toISOString();
const inbox: StoredChatContext = {
  schemaVersion: 2, page: 'inbox', scope: { kind: 'inbox' }, taskId: null, materialId: null, selectedTaskIds: [], taskFilter: null,
  timeZone: 'Asia/Shanghai', timeZoneSource: 'context', referencedApprovalId: null,
};
const everywhere: StoredChatContext = { ...inbox, page: 'search', scope: { kind: 'all' } };

async function clean() {
  await prisma.materialVersion.deleteMany({ where: { materialId: { startsWith: 'repair-' } } });
  await prisma.material.deleteMany({ where: { id: { startsWith: 'repair-' } } });
  await prisma.memory.deleteMany({ where: { id: { startsWith: 'repair-' } } });
  await prisma.autoMemoryTurn.deleteMany({ where: { id: { startsWith: 'repair-' } } });
  await prisma.message.deleteMany({ where: { id: { startsWith: 'repair-' } } });
  await prisma.task.deleteMany({ where: { OR: [{ id: { startsWith: 'repair-' } }, { topicId: { startsWith: 'repair-' } }] } });
  await prisma.topic.deleteMany({ where: { id: { startsWith: 'repair-' } } });
  await prisma.conversation.deleteMany({ where: { id: { startsWith: 'repair-' } } });
}

async function collect(args: Record<string, unknown>, context: StoredChatContext) {
  const items: Array<{ type: string; id: string }> = [];
  let cursor: string | undefined;
  let partial = false;
  for (let page = 0; page < 30; page += 1) {
    const result = await searchWorkspace({ ...args, ...(cursor ? { cursor } : {}) }, context);
    partial = partial || result.partial;
    items.push(...result.items.map((item) => ({ type: String(item.type), id: String(item.id) })));
    if (!result.hasMore) return { items, partial, hasMore: false };
    expect(result.nextCursor).toEqual(expect.any(String));
    cursor = result.nextCursor ?? undefined;
  }
  throw new Error('search did not finish');
}

afterEach(clean);

describe('workspace search pages', () => {
  it('reads a match past the first 200 rows and past 200 non-matching rows', async () => {
    const created = stamp();
    await prisma.task.createMany({ data: Array.from({ length: 201 }, (_, index) => ({ id: `repair-task-${String(index + 1).padStart(3, '0')}`, title: `repairneedle ${index + 1}`, createdAt: created, updatedAt: created })) });
    await prisma.task.createMany({ data: Array.from({ length: 210 }, (_, index) => ({ id: `repair-skip-${String(index + 1).padStart(3, '0')}`, title: 'ordinary row', createdAt: created, updatedAt: created })) });
    await prisma.task.create({ data: { id: 'repair-skip-999', title: 'repairhidden hit', createdAt: created, updatedAt: created } });
    const needle = await collect({ q: 'repairneedle', types: ['task'], limit: 50 }, inbox);
    expect(needle.items.map((item) => item.id)).toContain('repair-task-201');
    expect(new Set(needle.items.map((item) => item.id)).size).toBe(needle.items.length);
    expect(needle.items.filter((item) => item.id.startsWith('repair-task-'))).toHaveLength(201);
    const hidden = await collect({ q: 'repairhidden', types: ['task'], limit: 20 }, inbox);
    expect(hidden.items.map((item) => item.id)).toEqual(['repair-skip-999']);
  });

  it('walks every page until the independent total, with one copy of each id', async () => {
    const created = stamp();
    const topic = await prisma.topic.create({ data: { id: 'repair-topic-search', name: '搜索清单', createdAt: created, updatedAt: created } });
    await prisma.task.create({ data: { id: 'repair-quad-task', topicId: topic.id, title: 'repairquad task', createdAt: created, updatedAt: created } });
    await prisma.material.create({ data: { id: 'repair-quad-material', kind: 'note', title: 'repairquad material', topicId: topic.id, createdAt: created, updatedAt: created } });
    await prisma.materialVersion.create({ data: { id: 'repair-quad-version', materialId: 'repair-quad-material', revision: 1, content: 'repairquad body', contentHash: 'quad', createdAt: created } });
    await prisma.memory.create({ data: { id: 'repair-quad-memory', kind: 'note', title: 'repairquad memory', content: '记忆', topicId: topic.id, createdAt: created, updatedAt: created } });
    const conversation = await prisma.conversation.create({ data: { id: 'repair-quad-conversation', createdAt: created, updatedAt: created } });
    await prisma.message.create({ data: { id: 'repair-quad-user', conversationId: conversation.id, role: 'user', content: 'repairquad chat', status: 'completed', createdAt: created } });
    await prisma.autoMemoryTurn.create({ data: { id: 'repair-quad-turn', conversationId: conversation.id, topicId: topic.id, userMessageId: 'repair-quad-user', assistantMessageIds: '[]', createdAt: created } });
    const found = await collect({ q: 'repairquad', limit: 1, scope: 'all' }, inbox);
    expect(found.partial).toBe(false);
    expect(found.items.map((item) => item.type).sort()).toEqual(['conversation', 'material', 'memory', 'task']);
    expect(new Set(found.items.map((item) => item.id)).size).toBe(4);
    const tasks = await prisma.task.count({ where: { deletedAt: null, OR: [{ title: { contains: 'repairquad' } }, { description: { contains: 'repairquad' } }] } });
    expect(found.items.filter((item) => item.type === 'task')).toHaveLength(tasks);
  });

  it('matches the current material body, keeps global scope global, and rejects a stale cursor', async () => {
    const created = stamp();
    const topic = await prisma.topic.create({ data: { id: 'repair-topic-scope', name: '范围清单', createdAt: created, updatedAt: created } });
    await prisma.material.create({ data: { id: 'repair-old-material', kind: 'note', title: '旧资料', createdAt: created, updatedAt: created } });
    await prisma.materialVersion.create({ data: { id: 'repair-old-v1', materialId: 'repair-old-material', revision: 1, content: 'repairoldonly', contentHash: 'old', createdAt: created } });
    await prisma.materialVersion.create({ data: { id: 'repair-old-v2', materialId: 'repair-old-material', revision: 2, content: 'current plain', contentHash: 'new', createdAt: created } });
    await prisma.material.create({ data: { id: 'repair-current-material', kind: 'note', title: '新资料', createdAt: created, updatedAt: created } });
    await prisma.materialVersion.create({ data: { id: 'repair-current-v1', materialId: 'repair-current-material', revision: 1, content: 'repaircurrent', contentHash: 'current', createdAt: created } });
    await prisma.material.create({ data: { id: 'repair-current-material-2', kind: 'note', title: '另一份新资料', createdAt: created, updatedAt: created } });
    await prisma.materialVersion.create({ data: { id: 'repair-current-v2b', materialId: 'repair-current-material-2', revision: 1, content: 'repaircurrent too', contentHash: 'current-2', createdAt: created } });
    await prisma.memory.create({ data: { id: 'repair-memory-topic', kind: 'note', title: 'repairglobal memory', content: '清单记忆', topicId: topic.id, createdAt: created, updatedAt: created } });
    await prisma.memory.create({ data: { id: 'repair-memory-inbox', kind: 'note', title: 'repairinbox memory', content: '收集箱记忆', createdAt: created, updatedAt: created } });
    const conversation = await prisma.conversation.create({ data: { id: 'repair-scope-conversation', createdAt: created, updatedAt: created } });
    await prisma.message.create({ data: { id: 'repair-scope-user', conversationId: conversation.id, role: 'user', content: 'repairglobal chat', status: 'completed', createdAt: created } });
    await prisma.autoMemoryTurn.create({ data: { id: 'repair-scope-turn', conversationId: conversation.id, topicId: topic.id, userMessageId: 'repair-scope-user', assistantMessageIds: '[]', createdAt: created } });
    expect((await collect({ q: 'repairoldonly', types: ['material'] }, inbox)).items).toEqual([]);
    expect((await collect({ q: 'repaircurrent', types: ['material'] }, inbox)).items.map((item) => item.id)).toEqual(['repair-current-material', 'repair-current-material-2']);
    const inboxOnly = await collect({ q: 'repairglobal', scope: 'current' }, inbox);
    expect(inboxOnly.items).toEqual([]);
    const explicitAll = await collect({ q: 'repairglobal', scope: 'all' }, inbox);
    expect(explicitAll.items.map((item) => item.type).sort()).toEqual(['conversation', 'memory']);
    const contextAll = await collect({ q: 'repairglobal', scope: 'current' }, everywhere);
    expect(contextAll.items.map((item) => item.id).sort()).toEqual(['repair-memory-topic', 'repair-scope-user']);
    const first = await searchWorkspace({ q: 'repaircurrent', types: ['material'], limit: 1 }, inbox);
    await expect(searchWorkspace({ q: 'repaircurrent', types: ['material'], cursor: '%%%' }, inbox)).rejects.toMatchObject({ code: 'CURSOR_STALE' });
    await expect(searchWorkspace({ q: 'other', types: ['material'], cursor: first.nextCursor ?? undefined }, inbox)).rejects.toMatchObject({ code: 'CURSOR_STALE' });
    await expect(searchWorkspace({ q: 'repaircurrent', types: ['task', 'material'], cursor: first.nextCursor ?? undefined }, inbox)).rejects.toMatchObject({ code: 'CURSOR_STALE' });
  });

  it('reports a failed source as partial instead of a complete empty page', async () => {
    const read = async (source: SearchSource, afterId: string | null) => {
      if (source === 'memory') throw new Error('memory down');
      if (source === 'task' && afterId === null) return { rows: [{ id: 'repair-live-task' }], done: true };
      return { rows: [], done: true };
    };
    const page = await walkSearch({ fingerprint: 'fp', requested: ['task', 'memory'], limit: 10, read, match: () => true });
    expect(page.partial).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(page.items.map((item) => item.id)).toEqual(['repair-live-task']);
    expect(page.errors).toEqual([{ type: 'memory', message: 'memory down' }]);
    const empty = await walkSearch({ fingerprint: 'fp', requested: ['memory'], limit: 10, read, match: () => true });
    expect(empty.items).toEqual([]);
    expect(empty.partial).toBe(true);
    expect(empty.hasMore).toBe(true);
  });
});
