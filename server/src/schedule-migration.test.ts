import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { migrateTaskSchedules } from './schedule-migration.js';

async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'wwa-schedule-'));
  const path = join(directory, 'test.db');
  const db = new DatabaseSync(path);
  const migrations = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
  for (const name of readdirSync(migrations).sort()) if (name !== 'migration_lock.toml') db.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'));
  db.close();
  return { directory, prisma: new PrismaClient({ datasourceUrl: `file:${path}` }) };
}
describe('safe schedule migration', () => {
  it('backs up conflicts, includes every task state and runs once', async () => {
    const { directory, prisma } = await database();
    try {
      await prisma.topic.create({ data: { id: 'archived', name: '归档', archivedAt: '2026-10-10' } });
      for (const state of ['active', 'done', 'deleted', 'archived']) await prisma.task.create({ data: { id: state, title: state, topicId: state === 'archived' ? 'archived' : null, status: state === 'done' ? 'done' : 'todo', deletedAt: state === 'deleted' ? '2026-10-10' : null, dueDate: '2026-10-20', scheduledStart: '2026-10-11T23:00', scheduledEnd: '2026-10-12T01:00' } });
      await prisma.task.create({ data: { id: 'allday', title: '全天', dueDate: '2026-10-20' } });
      await migrateTaskSchedules(prisma);
      const rows = await prisma.task.findMany({ orderBy: { id: 'asc' } });
      expect(rows.filter((row) => row.id !== 'allday').every((row) => row.dueDate === '2026-10-11' && row.revision === 2)).toBe(true);
      expect(rows.find((row) => row.id === 'allday')).toMatchObject({ dueDate: '2026-10-20', revision: 1 });
      const backups = await readdir(join(directory, 'schedule-backups'));
      const report = JSON.parse(await readFile(join(directory, 'schedule-backups', backups[0], 'report.json'), 'utf8'));
      expect(report.changes).toHaveLength(4);
      const backup = new DatabaseSync(report.backupPath, { readOnly: true });
      try { expect(backup.prepare('SELECT due_date FROM tasks WHERE id = ?').get('active')?.due_date).toBe('2026-10-20'); expect(backup.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok'); } finally { backup.close(); }
      await migrateTaskSchedules(prisma);
      expect(await prisma.task.findMany({ orderBy: { id: 'asc' } })).toEqual(rows);
      expect(await readdir(join(directory, 'schedule-backups'))).toEqual(backups);
    } finally { await prisma.$disconnect(); await rm(directory, { recursive: true, force: true }); }
  }, 30_000); // Applies all migrations and verifies an on-disk backup on CI.
  it('reports malformed rows without changing tasks or marking completion', async () => {
    const { directory, prisma } = await database();
    try {
      await prisma.task.create({ data: { id: 'bad', title: '孤立结束', scheduledEnd: '2026-10-12T01:00' } });
      await prisma.task.create({ data: { id: 'valid', title: '冲突', dueDate: '2026-10-20', scheduledStart: '2026-10-11T23:00' } });
      await expect(migrateTaskSchedules(prisma)).rejects.toThrow('迁移已停止');
      expect(await prisma.task.findUnique({ where: { id: 'valid' } })).toMatchObject({ dueDate: '2026-10-20', revision: 1 });
      expect(await prisma.$queryRaw`SELECT * FROM app_data_migrations`).toEqual([]);
      const backups = await readdir(join(directory, 'schedule-backups'));
      const report = JSON.parse(await readFile(join(directory, 'schedule-backups', backups[0], 'report.json'), 'utf8'));
      expect(report.errors).toEqual([expect.objectContaining({ id: 'bad' })]);
    } finally { await prisma.$disconnect(); await rm(directory, { recursive: true, force: true }); }
  });
});
