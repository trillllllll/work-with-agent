import type { PrismaClient } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeLegacySchedule, type Schedule } from './domain/schedule.js';

const name = 'unified-task-schedule-v1';
/** Called after schema deployment, before the API starts accepting writes. */
export async function migrateTaskSchedules(prisma: PrismaClient) {
  if ((await prisma.$queryRaw<Array<{ name: string }>>`SELECT name FROM app_data_migrations WHERE name = ${name}`).length) return;
  const rows = await prisma.task.findMany(); // Deliberately includes archived/deleted/completed tasks.
  const changes: Array<{ id: string; title: string; before: Schedule & { revision: number }; after: Schedule }> = [];
  const errors = [];
  for (const row of rows) {
    try {
      const next = normalizeLegacySchedule(row);
      if (next.dueDate !== row.dueDate) changes.push({ id: row.id, title: row.title, before: { dueDate: row.dueDate, scheduledStart: row.scheduledStart, scheduledEnd: row.scheduledEnd, revision: row.revision }, after: next });
    } catch (error) { errors.push({ id: row.id, message: error instanceof Error ? error.message : String(error) }); }
  }
  let reportPath: string | null = null;
  if (changes.length || errors.length) {
    const databases = await prisma.$queryRaw<Array<{ name: string; file: string }>>`PRAGMA database_list`;
    const source = databases.find((db) => db.name === 'main')?.file;
    if (!source) throw new Error('Schedule migration requires a file-backed SQLite database for its backup');
    const directory = join(dirname(source), 'schedule-backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const backupPath = join(directory, 'before.db');
    // VACUUM INTO includes WAL contents and creates a consistent SQLite snapshot.
    await prisma.$executeRawUnsafe(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    reportPath = join(directory, 'report.json');
    await writeFile(reportPath, JSON.stringify({ name, source, backupPath, changes, errors }, null, 2));
    if (errors.length) throw new Error(`安排时间迁移已停止，异常记录及备份：${reportPath}`);
  }
  await prisma.$transaction(async (tx) => {
    // A second migration process must not increment revisions twice.
    if ((await tx.$queryRaw<Array<{ name: string }>>`SELECT name FROM app_data_migrations WHERE name = ${name}`).length) return;
    for (const change of changes) {
      const updated = await tx.task.updateMany({ where: { id: change.id, revision: change.before.revision, dueDate: change.before.dueDate, scheduledStart: change.before.scheduledStart, scheduledEnd: change.before.scheduledEnd }, data: { ...change.after, revision: { increment: 1 }, updatedAt: new Date().toISOString() } });
      if (updated.count !== 1) throw new Error(`Task ${change.id} changed during schedule migration; restart with writers stopped`);
    }
    await tx.$executeRaw`INSERT INTO app_data_migrations (name, completed_at, report_path) VALUES (${name}, ${new Date().toISOString()}, ${reportPath})`;
  }, { timeout: 30000 });
  if (reportPath) console.log(`安排时间迁移报告：${reportPath}`);
}
