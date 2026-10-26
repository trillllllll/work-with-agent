import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../infrastructure/prisma.js';
import { pullSyncOps, readLive, readSyncSnapshot } from './sync-log.js';
import { isCompleteSyncRow, type SyncRow } from './sync-merge.js';

const ids: string[] = [];
afterEach(async () => {
  await prisma.syncOp.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.task.deleteMany({ where: { id: { in: ids } } });
  await prisma.topic.deleteMany({ where: { id: { in: ids } } });
  ids.length = 0;
});
async function fixture(entity: 'task' | 'topic') {
  const id = randomUUID(), stamp = new Date().toISOString(); ids.push(id);
  if (entity === 'task') await prisma.task.create({ data: { id, title: '当前任务', recurrenceRule: '{"unit":"week","step":1}', createdAt: stamp, updatedAt: stamp } });
  else await prisma.topic.create({ data: { id, name: '当前清单', goalDueDate: '2026-11-01', createdAt: stamp, updatedAt: stamp } });
  const row = (await prisma.$transaction(tx => readLive(tx, entity, id))).row!;
  return { id, row, stamp };
}
async function log(entity: 'task' | 'topic', item: Awaited<ReturnType<typeof fixture>>, before: SyncRow | null, after: SyncRow | null) {
  return prisma.syncOp.create({ data: { opId: randomUUID(), deviceId: 'server', entityType: entity, entityId: item.id, beforeJson: before ? JSON.stringify(before) : null, afterJson: after ? JSON.stringify(after) : null, revision: 1, createdAt: item.stamp } });
}
describe('historical sync log schema compatibility', () => {
  for (const [entity, field] of [['task', 'recurrenceRule'], ['topic', 'goalDueDate']] as const) {
    it(`requests an atomic baseline for old ${entity} logs without modifying history or current ${field}`, async () => {
      const item = await fixture(entity), legacy = { ...item.row }; delete legacy[field];
      const stored = await log(entity, item, legacy, legacy);
      const page = await pullSyncOps(stored.seq - 1, 100);
      expect(page).toMatchObject({ baselineRequired: true, ops: [] });
      expect(page.tip).toBeGreaterThanOrEqual(stored.seq);
      expect(await prisma.syncOp.findUnique({ where: { seq: stored.seq } })).toEqual(stored);
      const snapshot = await readSyncSnapshot();
      const current = snapshot.entities[entity].find(row => row.id === item.id)!;
      expect(current.row[field]).toBe(item.row[field]);
      expect(isCompleteSyncRow(entity, current.row)).toBe(true);
    });
  }
  it('keeps complete incremental logs available', async () => {
    const item = await fixture('task'), stored = await log('task', item, null, item.row);
    const page = await pullSyncOps(stored.seq - 1, 100);
    expect(page.ops).toHaveLength(1);
    expect(page.ops[0].after).toEqual(item.row);
    expect('baselineRequired' in page).toBe(false);
  });
  it('does not hide corruption when a page mixes known legacy and malformed rows', async () => {
    const one = await fixture('task'), legacy = { ...one.row }; delete legacy.recurrenceRule;
    const first = await log('task', one, null, legacy);
    const two = await fixture('task'), broken = { ...two.row }; delete broken.title;
    await log('task', two, null, broken);
    const page = await pullSyncOps(first.seq - 1, 100);
    expect(page.ops).toHaveLength(2);
    expect('baselineRequired' in page).toBe(false);
  });
  it.each(['title', 'invalid-recurrence'])('does not hide unrelated malformed log data (%s)', async (kind) => {
    const item = await fixture('task'), broken = { ...item.row };
    if (kind === 'title') { delete broken.title; delete broken.recurrenceRule; }
    else broken.recurrenceRule = 42;
    const stored = await log('task', item, null, broken), page = await pullSyncOps(stored.seq - 1, 100);
    expect(page.ops).toHaveLength(1);
    expect(isCompleteSyncRow('task', page.ops[0].after)).toBe(false);
    expect('baselineRequired' in page).toBe(false);
  });
});
