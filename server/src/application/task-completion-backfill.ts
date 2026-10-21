import type { PrismaClient } from '@prisma/client';
import { collectTaskStates } from './task-activity.js';

const pageSize = 500;

/** Fill completedAt for done tasks that predate the column. Exact when a change record shows the transition; otherwise updatedAt and estimated. */
export async function backfillTaskCompletion(prisma: PrismaClient) {
  const pending = await prisma.task.count({ where: { status: 'done', completedAt: null } });
  if (pending === 0) return { exact: 0, estimated: 0, skippedBadSnapshots: 0 };

  const lastDoneAt = new Map<string, string>();
  let skippedBadSnapshots = 0;
  let cursor: { createdAt: string; id: string } | undefined;
  for (;;) {
    const records = await prisma.changeRecord.findMany({
      where: cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : undefined,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
      select: { id: true, createdAt: true, beforeSnapshot: true, afterSnapshot: true },
    });
    for (const record of records) {
      const beforeStats = { badSnapshots: 0 };
      const afterStats = { badSnapshots: 0 };
      const before = collectTaskStates(record.beforeSnapshot, beforeStats);
      const after = collectTaskStates(record.afterSnapshot, afterStats);
      skippedBadSnapshots += beforeStats.badSnapshots + afterStats.badSnapshots;
      if (beforeStats.badSnapshots || afterStats.badSnapshots) continue;
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const previous = before.get(id);
        const next = after.get(id);
        if (next && next.status !== 'done') lastDoneAt.delete(id);
        else if (next?.status === 'done' && previous?.status !== 'done') lastDoneAt.set(id, record.createdAt);
      }
    }
    if (records.length < pageSize) break;
    const last = records[records.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
  }

  const tasks = await prisma.task.findMany({ where: { status: 'done', completedAt: null }, select: { id: true, updatedAt: true } });
  let exact = 0;
  let estimated = 0;
  for (const task of tasks) {
    const at = lastDoneAt.get(task.id);
    const result = await prisma.task.updateMany({
      where: { id: task.id, status: 'done', completedAt: null },
      data: at ? { completedAt: at, completedAtEstimated: false } : { completedAt: task.updatedAt, completedAtEstimated: true },
    });
    if (!result.count) continue;
    if (at) exact += 1;
    else estimated += 1;
  }
  console.log(`精确 ${exact} / 估算 ${estimated} / 跳过坏快照 ${skippedBadSnapshots}`);
  return { exact, estimated, skippedBadSnapshots };
}
