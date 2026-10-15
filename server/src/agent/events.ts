import type { Db } from '../application/workspace-store.js';
import { notifyRuns } from './wake.js';

export async function appendRunEvent(tx: Db, runId: string, type: string, data: unknown) {
  const timestamp = new Date().toISOString();
  const run = await tx.agentRun.update({ where: { id: runId }, data: { nextEventSeq: { increment: 1 }, updatedAt: timestamp } });
  await tx.agentRunEvent.create({ data: { runId, seq: run.nextEventSeq, type, dataJson: JSON.stringify(data), createdAt: timestamp } });
  queueMicrotask(notifyRuns);
  return run.nextEventSeq;
}
