import { z } from 'zod';
import { DomainError } from '../domain/task.js';
import { digest } from '../runner/workspaces.js';
import { assertTopicAccess, actorFromConnection, type Actor } from './security.js';
import { prisma } from '../infrastructure/prisma.js';
import type { Prisma, Run, Handoff } from '@prisma/client';

export const now = () => new Date().toISOString();
export type Db = Prisma.TransactionClient;
export const requestSchema = z.string().trim().min(8).max(200);
export function decode<T>(value: string): T { return JSON.parse(value) as T; }
export function handoffDto(row: Handoff) { return { ...row, inputSnapshot: decode(row.inputSnapshot), permissions: decode(row.permissions) }; }
export function runDto(row: Run) { const { claimTokenHash: _hash, configJson, workspaceJson, resultJson, ...value } = row; return { ...value, config: decode(configJson), workspace: decode(workspaceJson), result: resultJson ? decode(resultJson) : null }; }
export async function handoffAccess(actor: Actor, id: string, db: Db = prisma) {
  if (actor.kind === 'connection') {
    const connection = await db.connection.findUnique({ where: { id: actor.connectionId } });
    if (!connection || connection.status !== 'active') throw new DomainError('CONNECTION_REVOKED', '连接已撤销', 401);
    actor = actorFromConnection(connection);
  }
  const row = await db.handoff.findUnique({ where: { id } });
  if (!row) throw new DomainError('NOT_FOUND', '交接不存在', 404);
  const snapshot = decode<{ task: { topicId: string | null } }>(row.inputSnapshot);
  assertTopicAccess(actor, snapshot.task.topicId);
  const current = await db.task.findUnique({ where: { id: row.taskId }, select: { topicId: true } });
  if (current) assertTopicAccess(actor, current.topicId);
  return row;
}
export async function runAccess(actor: Actor, id: string, db: Db = prisma) {
  const run = await db.run.findUnique({ where: { id } });
  if (!run) throw new DomainError('NOT_FOUND', '运行不存在', 404);
  const handoff = await handoffAccess(actor, run.handoffId, db);
  return { run, handoff };
}
/** A stable event id deduplicates delivery, while sequence numbers are assigned only here. */
export async function appendEvent(tx: Db, runId: string, type: string, payload: unknown, eventId?: string) {
  const serialized = JSON.stringify(payload);
  if (eventId) {
    const prior = await tx.runEvent.findUnique({ where: { runId_eventId: { runId, eventId } } });
    if (prior) {
      if (prior.type !== type || digest(prior.payload) !== digest(serialized)) throw new DomainError('EVENT_CONFLICT', '相同事件 ID 不能对应不同内容');
      return prior;
    }
  }
  const run = await tx.run.update({ where: { id: runId }, data: { lastSequence: { increment: 1 }, updatedAt: now() } });
  return tx.runEvent.create({ data: { runId, sequence: run.lastSequence, eventId, type, payload: serialized, createdAt: now() } });
}
export async function handoffAudit(tx: Db, actor: Actor, entityType: string, entityId: string, operation: string, before: unknown, after: unknown) {
  return tx.changeRecord.create({ data: { entityType, entityId, operation, beforeSnapshot: before ? JSON.stringify(before) : null, afterSnapshot: after ? JSON.stringify(after) : null, source: actor.kind === 'user' ? 'user' : 'agent', actorId: actor.id, connectionId: actor.connectionId, createdAt: now() } });
}
export const activeRunStatuses = ['created', 'accepted', 'running', 'cancelling', 'unknown'];
