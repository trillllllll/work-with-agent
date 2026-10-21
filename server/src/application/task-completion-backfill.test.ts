import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { collectTaskStates } from './task-activity.js';
import { backfillTaskCompletion } from './task-completion-backfill.js';

function group(id: string, status: string | null) {
  return JSON.stringify({ version: 2, entities: { tasks: { [id]: status ? { id, title: id, status } : null }, topics: {}, tags: {} }, scopes: [] });
}
function batch(id: string, statuses: Array<string | null>) {
  return JSON.stringify({ version: 3, changes: statuses.map((status) => ({ entityType: 'task', entityId: id, operation: 'update', snapshot: group(id, status) })) });
}
function legacy(id: string, status: string) {
  return JSON.stringify({ id, title: id, status });
}

describe('collectTaskStates', () => {
  it('reads every task from a v2 group, a v3 batch, and a legacy object', () => {
    const states = collectTaskStates(JSON.stringify({ version: 2, entities: { tasks: { a: { id: 'a', title: '甲', status: 'done' }, b: { id: 'b', title: '乙', status: 'todo' }, gone: null }, topics: {}, tags: {} }, scopes: [] }));
    expect(states.get('a')?.status).toBe('done');
    expect(states.get('b')?.status).toBe('todo');
    expect(states.has('gone')).toBe(false);
    const net = collectTaskStates(batch('a', ['done', 'todo']));
    expect(net.get('a')?.status).toBe('todo');
    expect(collectTaskStates(legacy('old', 'done')).get('old')?.status).toBe('done');
    expect(collectTaskStates(group('a', 'done')).get('a')?.status).toBe('done');
  });

  it('skips unreadable JSON and counts it', () => {
    const stats = { badSnapshots: 0 };
    expect(collectTaskStates('{', stats).size).toBe(0);
    expect(stats.badSnapshots).toBe(1);
    const nested = { badSnapshots: 0 };
    expect(collectTaskStates(JSON.stringify({ version: 3, changes: [{ snapshot: '{' }] }), nested).size).toBe(0);
    expect(nested.badSnapshots).toBe(1);
    expect(collectTaskStates(null).size).toBe(0);
  });
});

async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'wwa-completed-at-'));
  const path = join(directory, 'test.db');
  const db = new DatabaseSync(path);
  const migrations = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
  for (const name of readdirSync(migrations).sort()) if (name !== 'migration_lock.toml') db.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'));
  db.close();
  return { directory, prisma: new PrismaClient({ datasourceUrl: `file:${path}` }) };
}

describe('task completion backfill', () => {
  it('replays enter, leave, undo, batch net result, and bad JSON without touching revision or updatedAt', async () => {
    const { directory, prisma } = await database();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const tasks = [
        { id: 'entered', status: 'done' as const, updatedAt: '2026-01-10T00:00:00.000Z' },
        { id: 'left', status: 'doing' as const, updatedAt: '2026-01-10T00:00:00.000Z' },
        { id: 'undone', status: 'done' as const, updatedAt: '2026-01-11T00:00:00.000Z' },
        { id: 'batched', status: 'done' as const, updatedAt: '2026-01-12T00:00:00.000Z' },
        { id: 'reopened', status: 'done' as const, updatedAt: '2026-01-13T00:00:00.000Z' },
        { id: 'broken', status: 'done' as const, updatedAt: '2026-01-14T00:00:00.000Z' },
        { id: 'missing', status: 'done' as const, updatedAt: '2026-01-15T00:00:00.000Z' },
        { id: 'open', status: 'todo' as const, updatedAt: '2026-01-16T00:00:00.000Z' },
      ];
      await prisma.task.createMany({ data: tasks.map((task) => ({ ...task, title: task.id, revision: 7, createdAt: task.updatedAt })) });
      const changes = [
        { id: 'entered-1', entityId: 'entered', createdAt: '2026-01-01T00:00:00.000Z', beforeSnapshot: legacy('entered', 'todo'), afterSnapshot: legacy('entered', 'done') },
        { id: 'left-1', entityId: 'left', createdAt: '2026-02-01T00:00:00.000Z', beforeSnapshot: legacy('left', 'todo'), afterSnapshot: legacy('left', 'done') },
        { id: 'left-2', entityId: 'left', createdAt: '2026-02-02T00:00:00.000Z', beforeSnapshot: legacy('left', 'done'), afterSnapshot: legacy('left', 'doing') },
        { id: 'undone-1', entityId: 'undone', createdAt: '2026-03-01T00:00:00.000Z', beforeSnapshot: legacy('undone', 'todo'), afterSnapshot: legacy('undone', 'done') },
        { id: 'undone-2', entityId: 'undone', createdAt: '2026-03-02T00:00:00.000Z', beforeSnapshot: legacy('undone', 'done'), afterSnapshot: legacy('undone', 'todo') },
        { id: 'undone-3', entityId: 'undone', createdAt: '2026-03-03T00:00:00.000Z', beforeSnapshot: legacy('undone', 'todo'), afterSnapshot: legacy('undone', 'done') },
        { id: 'batched-1', entityId: 'batched', createdAt: '2026-04-01T00:00:00.000Z', beforeSnapshot: batch('batched', ['todo']), afterSnapshot: batch('batched', ['doing', 'done']) },
        { id: 'reopened-1', entityId: 'reopened', createdAt: '2026-05-01T00:00:00.000Z', beforeSnapshot: batch('reopened', ['todo']), afterSnapshot: batch('reopened', ['done', 'todo']) },
        { id: 'broken-1', entityId: 'broken', createdAt: '2026-06-01T00:00:00.000Z', beforeSnapshot: '{', afterSnapshot: legacy('broken', 'done') },
        { id: 'open-1', entityId: 'open', createdAt: '2026-07-01T00:00:00.000Z', beforeSnapshot: legacy('open', 'todo'), afterSnapshot: legacy('open', 'done') },
        { id: 'open-2', entityId: 'open', createdAt: '2026-07-02T00:00:00.000Z', beforeSnapshot: legacy('open', 'done'), afterSnapshot: legacy('open', 'todo') },
      ];
      await prisma.changeRecord.createMany({ data: changes.map((row) => ({ ...row, entityType: 'task', operation: 'update', source: 'user' })) });
      const result = await backfillTaskCompletion(prisma);
      expect(result).toEqual({ exact: 3, estimated: 3, skippedBadSnapshots: 1 });
      expect(log).toHaveBeenCalledWith('精确 3 / 估算 3 / 跳过坏快照 1');
      const rows = new Map((await prisma.task.findMany()).map((row) => [row.id, row]));
      expect(rows.get('entered')).toMatchObject({ completedAt: '2026-01-01T00:00:00.000Z', completedAtEstimated: false, revision: 7, updatedAt: '2026-01-10T00:00:00.000Z' });
      expect(rows.get('undone')).toMatchObject({ completedAt: '2026-03-03T00:00:00.000Z', completedAtEstimated: false, revision: 7, updatedAt: '2026-01-11T00:00:00.000Z' });
      expect(rows.get('batched')).toMatchObject({ completedAt: '2026-04-01T00:00:00.000Z', completedAtEstimated: false, revision: 7, updatedAt: '2026-01-12T00:00:00.000Z' });
      expect(rows.get('reopened')).toMatchObject({ completedAt: '2026-01-13T00:00:00.000Z', completedAtEstimated: true, revision: 7, updatedAt: '2026-01-13T00:00:00.000Z' });
      expect(rows.get('broken')).toMatchObject({ completedAt: '2026-01-14T00:00:00.000Z', completedAtEstimated: true, revision: 7, updatedAt: '2026-01-14T00:00:00.000Z' });
      expect(rows.get('missing')).toMatchObject({ completedAt: '2026-01-15T00:00:00.000Z', completedAtEstimated: true, revision: 7, updatedAt: '2026-01-15T00:00:00.000Z' });
      expect(rows.get('left')).toMatchObject({ completedAt: null, completedAtEstimated: false, revision: 7, status: 'doing' });
      expect(rows.get('open')).toMatchObject({ completedAt: null, completedAtEstimated: false, revision: 7, status: 'todo' });
    } finally {
      log.mockRestore();
      await prisma.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not scan change records when every done task already has completedAt', async () => {
    const { directory, prisma } = await database();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const scanned = vi.spyOn(prisma.changeRecord, 'findMany');
    try {
      await prisma.task.create({ data: { id: 'has-time', title: '已有', status: 'done', completedAt: '2026-01-01T00:00:00.000Z', completedAtEstimated: false, updatedAt: '2026-01-02T00:00:00.000Z', revision: 2 } });
      await prisma.task.create({ data: { id: 'open', title: '未完成', status: 'todo', updatedAt: '2026-01-02T00:00:00.000Z', revision: 2 } });
      await prisma.changeRecord.create({ data: { id: 'ignored', entityType: 'task', entityId: 'has-time', operation: 'update', source: 'user', createdAt: '2026-01-01T00:00:00.000Z', beforeSnapshot: legacy('has-time', 'todo'), afterSnapshot: legacy('has-time', 'done') } });
      await expect(backfillTaskCompletion(prisma)).resolves.toEqual({ exact: 0, estimated: 0, skippedBadSnapshots: 0 });
      expect(scanned).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(await prisma.task.findUniqueOrThrow({ where: { id: 'has-time' } })).toMatchObject({ completedAt: '2026-01-01T00:00:00.000Z', revision: 2, updatedAt: '2026-01-02T00:00:00.000Z' });
    } finally {
      scanned.mockRestore();
      log.mockRestore();
      await prisma.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the completion that sits on the next (createdAt, id) page', async () => {
    const { directory, prisma } = await database();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await prisma.task.create({ data: { id: 'paged', title: '分页', status: 'done', updatedAt: '2026-08-01T00:00:00.000Z', revision: 4, createdAt: '2026-08-01T00:00:00.000Z' } });
      const fillers = Array.from({ length: 499 }, (_, index) => ({
        id: `filler-${index}`,
        entityType: 'task',
        entityId: 'paged',
        operation: 'update',
        source: 'user',
        createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, 0, index)).toISOString(),
        beforeSnapshot: null,
        afterSnapshot: null,
      }));
      const boundary = '2026-04-02T00:00:00.000Z';
      const edges = [
        { id: 'boundary-a', entityType: 'task', entityId: 'paged', operation: 'update', source: 'user', createdAt: boundary, beforeSnapshot: legacy('paged', 'todo'), afterSnapshot: legacy('paged', 'todo') },
        { id: 'boundary-b', entityType: 'task', entityId: 'paged', operation: 'update', source: 'user', createdAt: boundary, beforeSnapshot: legacy('paged', 'todo'), afterSnapshot: legacy('paged', 'done') },
      ];
      for (let index = 0; index < fillers.length; index += 100) await prisma.changeRecord.createMany({ data: fillers.slice(index, index + 100) });
      await prisma.changeRecord.createMany({ data: edges });
      await expect(backfillTaskCompletion(prisma)).resolves.toEqual({ exact: 1, estimated: 0, skippedBadSnapshots: 0 });
      expect(log).toHaveBeenCalledWith('精确 1 / 估算 0 / 跳过坏快照 0');
      expect(await prisma.task.findUniqueOrThrow({ where: { id: 'paged' } })).toMatchObject({ completedAt: boundary, completedAtEstimated: false, revision: 4, updatedAt: '2026-08-01T00:00:00.000Z' });
    } finally {
      log.mockRestore();
      await prisma.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
