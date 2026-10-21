import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { localSchemaVersion } from './snapshots.js';
import { canonicalSyncRow, isSyncEntityType, mergeSyncRow, syncFields, syncRowsEqual, type SyncEntityType, type SyncFieldConflict, type SyncRow } from './sync-merge.js';

const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Tx = Prisma.TransactionClient;

type GroupSide = {
  entities: {
    tasks: Record<string, Record<string, unknown> | null>;
    topics: Record<string, Record<string, unknown> | null>;
    tags: Record<string, Record<string, unknown> | null>;
  };
};

const kindOf = { tasks: 'task', topics: 'topic', tags: 'tag' } as const;

type PendingOp = {
  entityType: SyncEntityType;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  revision: number;
};

function asRow(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function revisionOf(row: Record<string, unknown> | null) {
  return typeof row?.revision === 'number' ? row.revision : 0;
}

/** Topics and tags first, then parent tasks, then child tasks, then deletes. */
function orderOps(ops: PendingOp[]) {
  const topics = ops.filter((op) => op.entityType === 'topic');
  const tags = ops.filter((op) => op.entityType === 'tag');
  const writes = ops.filter((op) => op.entityType === 'task' && op.after);
  const deletions = ops.filter((op) => op.entityType === 'task' && !op.after);
  const creating = new Set(writes.filter((op) => !op.before).map((op) => op.entityId));
  const ordered: PendingOp[] = [];
  const left = [...writes];
  while (left.length) {
    const index = left.findIndex((op) => {
      const parent = op.after?.parentId;
      return typeof parent !== 'string' || !creating.has(parent) || ordered.some((item) => item.entityId === parent);
    });
    ordered.push(left.splice(index < 0 ? 0 : index, 1)[0]);
  }
  const deletedIds = new Set(deletions.map((op) => op.entityId));
  const deleted: PendingOp[] = [];
  const remaining = [...deletions];
  while (remaining.length) {
    const index = remaining.findIndex((op) => {
      const parent = op.before?.parentId;
      return typeof parent !== 'string' || !deletedIds.has(parent) || !remaining.some((item) => item.entityId === parent);
    });
    deleted.push(remaining.splice(index < 0 ? 0 : index, 1)[0]);
  }
  return [...topics, ...tags, ...ordered, ...deleted];
}

export function diffGroupOps(before: GroupSide, after: GroupSide) {
  const pending: PendingOp[] = [];
  for (const kind of ['topics', 'tags', 'tasks'] as const) {
    const entityType = kindOf[kind];
    const ids = new Set([...Object.keys(before.entities[kind] ?? {}), ...Object.keys(after.entities[kind] ?? {})]);
    for (const entityId of ids) {
      const previous = asRow(before.entities[kind]?.[entityId]);
      const next = asRow(after.entities[kind]?.[entityId]);
      const previousRow = canonicalSyncRow(entityType, previous);
      const nextRow = canonicalSyncRow(entityType, next);
      if (syncRowsEqual(entityType, previousRow, nextRow)) continue;
      pending.push({ entityType, entityId, before: previousRow, after: nextRow, revision: revisionOf(next) || revisionOf(previous) });
    }
  }
  return orderOps(pending);
}

/** Writes one hub op per task, topic, or tag that this committed group actually changed. */
export async function appendGroupSyncOps(tx: Tx, changeId: string, before: GroupSide, after: GroupSide) {
  for (const op of diffGroupOps(before, after)) {
    await tx.syncOp.create({
      data: {
        opId: `${changeId}:${op.entityType}:${op.entityId}`,
        deviceId: 'server',
        entityType: op.entityType,
        entityId: op.entityId,
        beforeJson: op.before ? JSON.stringify(canonicalSyncRow(op.entityType, op.before)) : null,
        afterJson: op.after ? JSON.stringify(canonicalSyncRow(op.entityType, op.after)) : null,
        revision: op.revision,
        createdAt: now(),
      },
    });
  }
}

export async function currentSyncSeq() {
  const row = await prisma.syncOp.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } });
  return row?.seq ?? 0;
}

export async function pairSyncDevice(name: string) {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const timestamp = now();
  await prisma.syncDevice.create({ data: { id, name: name.trim() || 'device', tokenHash: hash(token), lastSeenAt: timestamp, createdAt: timestamp } });
  return { deviceId: id, token };
}

const rowSchema = z.record(z.unknown()).nullable();
const pushOpSchema = z.object({
  opId: z.string().min(8).max(200),
  entityType: z.string(),
  entityId: z.string().min(1).max(200),
  before: rowSchema,
  after: rowSchema,
}).strict();

export const pushBodySchema = z.object({
  schemaVersion: z.string().min(1),
  ops: z.array(pushOpSchema).min(1).max(50),
}).strict();

export function assertSchema(schemaVersion: string) {
  if (schemaVersion !== localSchemaVersion()) throw new DomainError('SCHEMA_MISMATCH', '同步协议版本不一致，请先升级到同一版本', 409);
}

function parseStored(value: string | null): SyncRow | null {
  if (!value) return null;
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return parsed;
}

function requireComplete(entityType: SyncEntityType, row: Record<string, unknown> | null) {
  if (!row) return;
  for (const field of syncFields[entityType]) {
    if (!(field in row)) throw new DomainError('VALIDATION_ERROR', '同步操作无效', 400);
  }
}

export async function readLive(tx: Tx, entityType: SyncEntityType, entityId: string): Promise<{ row: SyncRow | null; revision: number }> {
  if (entityType === 'topic') {
    const row = await tx.topic.findUnique({ where: { id: entityId } });
    return { row: canonicalSyncRow('topic', row), revision: row?.revision ?? 0 };
  }
  if (entityType === 'tag') {
    const row = await tx.tag.findUnique({ where: { id: entityId } });
    return { row: canonicalSyncRow('tag', row), revision: row?.revision ?? 0 };
  }
  const row = await tx.task.findUnique({ where: { id: entityId }, include: { tags: true } });
  if (!row) return { row: null, revision: 0 };
  const { tags, ...data } = row;
  return { row: canonicalSyncRow('task', { ...data, tagIds: tags.map((tag) => tag.tagId) }), revision: row.revision };
}

export async function writeLive(tx: Tx, entityType: SyncEntityType, entityId: string, row: SyncRow | null) {
  const timestamp = now();
  if (entityType === 'topic') {
    if (!row) {
      await tx.topic.delete({ where: { id: entityId } });
      return 0;
    }
    const existing = await tx.topic.findUnique({ where: { id: entityId } });
    if (!existing) {
      await tx.topic.create({ data: { id: entityId, name: String(row.name ?? ''), description: String(row.description ?? ''), color: String(row.color ?? 'slate'), isExploration: Boolean(row.isExploration), goal: String(row.goal ?? ''), draftSummary: String(row.draftSummary ?? ''), finalSummary: String(row.finalSummary ?? ''), summaryStatus: String(row.summaryStatus ?? 'empty'), summaryUpdatedAt: row.summaryUpdatedAt == null ? null : String(row.summaryUpdatedAt), archivedAt: row.archivedAt == null ? null : String(row.archivedAt), revision: 1, createdAt: timestamp, updatedAt: timestamp } });
      return 1;
    }
    const updated = await tx.topic.update({ where: { id: entityId }, data: { name: String(row.name ?? ''), description: String(row.description ?? ''), color: String(row.color ?? 'slate'), isExploration: Boolean(row.isExploration), goal: String(row.goal ?? ''), draftSummary: String(row.draftSummary ?? ''), finalSummary: String(row.finalSummary ?? ''), summaryStatus: String(row.summaryStatus ?? 'empty'), summaryUpdatedAt: row.summaryUpdatedAt == null ? null : String(row.summaryUpdatedAt), archivedAt: row.archivedAt == null ? null : String(row.archivedAt), revision: { increment: 1 }, updatedAt: timestamp } });
    return updated.revision;
  }
  if (entityType === 'tag') {
    if (!row) {
      await tx.taskTag.deleteMany({ where: { tagId: entityId } });
      await tx.tag.delete({ where: { id: entityId } });
      return 0;
    }
    const existing = await tx.tag.findUnique({ where: { id: entityId } });
    if (!existing) {
      await tx.tag.create({ data: { id: entityId, name: String(row.name ?? ''), color: String(row.color ?? 'violet'), revision: 1, createdAt: timestamp, updatedAt: timestamp } });
      return 1;
    }
    const updated = await tx.tag.update({ where: { id: entityId }, data: { name: String(row.name ?? ''), color: String(row.color ?? 'violet'), revision: { increment: 1 }, updatedAt: timestamp } });
    return updated.revision;
  }
  if (!row) {
    await tx.taskTag.deleteMany({ where: { taskId: entityId } });
    await tx.task.updateMany({ where: { parentId: entityId }, data: { parentId: null } });
    await tx.task.delete({ where: { id: entityId } });
    return 0;
  }
  const scalars = {
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    status: String(row.status ?? 'todo') as 'todo' | 'doing' | 'blocked' | 'done',
    priority: String(row.priority ?? 'none') as 'none' | 'low' | 'medium' | 'high',
    dueDate: row.dueDate == null ? null : String(row.dueDate),
    estimatedMinutes: typeof row.estimatedMinutes === 'number' ? row.estimatedMinutes : null,
    scheduledStart: row.scheduledStart == null ? null : String(row.scheduledStart),
    scheduledEnd: row.scheduledEnd == null ? null : String(row.scheduledEnd),
    resultSummary: String(row.resultSummary ?? ''),
    topicId: row.topicId == null ? null : String(row.topicId),
    parentId: row.parentId == null ? null : String(row.parentId),
    deletedAt: row.deletedAt == null ? null : String(row.deletedAt),
    deleteBatchId: row.deleteBatchId == null ? null : String(row.deleteBatchId),
    sortOrder: typeof row.sortOrder === 'number' ? row.sortOrder : 0,
  };
  const existing = await tx.task.findUnique({ where: { id: entityId } });
  // completedAt is not a sync field. Derive it here because writeLive bypasses ChangeGroup.
  // done → done leaves the previous completion time alone.
  const completion = scalars.status === 'done' && existing?.status === 'done'
    ? {}
    : scalars.status === 'done'
      ? { completedAt: timestamp, completedAtEstimated: false }
      : { completedAt: null, completedAtEstimated: false };
  const saved = existing
    ? await tx.task.update({ where: { id: entityId }, data: { ...scalars, ...completion, revision: { increment: 1 }, updatedAt: timestamp } })
    : await tx.task.create({ data: { id: entityId, ...scalars, ...completion, revision: 1, createdAt: timestamp, updatedAt: timestamp } });
  const tagIds = Array.isArray(row.tagIds) ? row.tagIds.map(String) : [];
  await tx.taskTag.deleteMany({ where: { taskId: entityId } });
  if (tagIds.length) await tx.taskTag.createMany({ data: tagIds.map((tagId) => ({ taskId: entityId, tagId })) });
  return saved.revision;
}

async function storeConflicts(tx: Tx, opId: string, deviceId: string, entityType: SyncEntityType, entityId: string, conflicts: SyncFieldConflict[]) {
  const timestamp = now();
  for (const conflict of conflicts) {
    const pending = await tx.syncConflict.findFirst({ where: { entityType, entityId, field: conflict.field, state: 'pending' }, select: { id: true } });
    if (pending) continue;
    await tx.syncConflict.create({
      data: {
        id: randomUUID(),
        opId,
        deviceId,
        entityType,
        entityId,
        field: conflict.field,
        baseJson: JSON.stringify(conflict.base ?? null),
        liveJson: JSON.stringify(conflict.live ?? null),
        incomingJson: JSON.stringify(conflict.incoming ?? null),
        state: 'pending',
        createdAt: timestamp,
      },
    });
  }
}

async function applyIncoming(tx: Tx, deviceId: string, input: z.infer<typeof pushOpSchema>) {
  if (!isSyncEntityType(input.entityType)) throw new DomainError('VALIDATION_ERROR', '同步操作无效', 400);
  const entityType = input.entityType;
  requireComplete(entityType, input.before);
  requireComplete(entityType, input.after);
  const existing = await tx.syncOp.findUnique({ where: { opId: input.opId } });
  if (existing) return { opId: input.opId, status: 'duplicate' as const, seq: existing.seq, revision: existing.revision, conflicts: [] as SyncFieldConflict[], landed: null as SyncRow | null };
  const live = await readLive(tx, entityType, input.entityId);
  const before = canonicalSyncRow(entityType, input.before);
  const after = canonicalSyncRow(entityType, input.after);
  const merged = mergeSyncRow(entityType, live.row, before, after);
  const changed = !syncRowsEqual(entityType, live.row, merged.row);
  let revision = live.revision;
  let seq: number | null = null;
  if (changed) {
    revision = await writeLive(tx, entityType, input.entityId, merged.row);
    const created = await tx.syncOp.create({
      data: {
        opId: input.opId,
        deviceId,
        entityType,
        entityId: input.entityId,
        beforeJson: before ? JSON.stringify(before) : null,
        afterJson: merged.row ? JSON.stringify(merged.row) : null,
        revision,
        createdAt: now(),
      },
    });
    seq = created.seq;
  }
  if (merged.conflicts.length) await storeConflicts(tx, input.opId, deviceId, entityType, input.entityId, merged.conflicts);
  return { opId: input.opId, status: merged.conflicts.length ? 'conflict' as const : 'applied' as const, seq, revision, conflicts: merged.conflicts, landed: merged.row };
}

export async function pushSyncOps(deviceId: string, body: z.infer<typeof pushBodySchema>) {
  assertSchema(body.schemaVersion);
  const outcome = await prisma.$transaction(async (tx) => {
    const results = [];
    for (const op of body.ops) results.push(await applyIncoming(tx, deviceId, op));
    await tx.syncDevice.update({ where: { id: deviceId }, data: { lastSeenAt: now() } });
    return results;
  });
  return { schemaVersion: localSchemaVersion(), tip: await currentSyncSeq(), results: outcome };
}

export async function pullSyncOps(after: number, limit: number) {
  const ops = await prisma.syncOp.findMany({ where: { seq: { gt: after } }, orderBy: { seq: 'asc' }, take: limit });
  return {
    schemaVersion: localSchemaVersion(),
    tip: await currentSyncSeq(),
    ops: ops.map((op) => ({
      seq: op.seq,
      opId: op.opId,
      deviceId: op.deviceId,
      entityType: op.entityType,
      entityId: op.entityId,
      before: parseStored(op.beforeJson),
      after: parseStored(op.afterJson),
      revision: op.revision,
      createdAt: op.createdAt,
    })),
  };
}

export async function listSyncConflicts() {
  const rows = await prisma.syncConflict.findMany({ where: { state: 'pending' }, orderBy: { createdAt: 'asc' }, take: 100 });
  return rows.map((row) => ({
    id: row.id,
    opId: row.opId,
    deviceId: row.deviceId,
    entityType: row.entityType,
    entityId: row.entityId,
    field: row.field,
    base: JSON.parse(row.baseJson) as unknown,
    live: JSON.parse(row.liveJson) as unknown,
    incoming: JSON.parse(row.incomingJson) as unknown,
    createdAt: row.createdAt,
  }));
}

export async function resolveSyncConflict(id: string, choice: 'mine' | 'theirs', deviceId: string) {
  const outcome = await prisma.$transaction(async (tx) => {
    const conflict = await tx.syncConflict.findUnique({ where: { id } });
    if (!conflict || conflict.state !== 'pending') throw new DomainError('NOT_FOUND', '冲突不存在或已处理', 404);
    if (!isSyncEntityType(conflict.entityType)) throw new DomainError('VALIDATION_ERROR', '同步操作无效', 400);
    if (choice === 'theirs') {
      await tx.syncConflict.update({ where: { id }, data: { state: 'resolved', resolvedAt: now() } });
      return { id, choice, revision: null as number | null };
    }
    const live = await readLive(tx, conflict.entityType, conflict.entityId);
    const incoming = JSON.parse(conflict.incomingJson) as unknown;
    let next: SyncRow | null;
    if (conflict.field === '_deleted') next = canonicalSyncRow(conflict.entityType, asRow(incoming));
    else {
      if (!live.row) throw new DomainError('NOT_FOUND', '冲突不存在或已处理', 404);
      next = { ...live.row, [conflict.field]: incoming };
    }
    const revision = await writeLive(tx, conflict.entityType, conflict.entityId, next);
    await tx.syncOp.create({
      data: {
        opId: `resolve:${id}`,
        deviceId,
        entityType: conflict.entityType,
        entityId: conflict.entityId,
        beforeJson: live.row ? JSON.stringify(live.row) : null,
        afterJson: next ? JSON.stringify(canonicalSyncRow(conflict.entityType, next)) : null,
        revision,
        createdAt: now(),
      },
    });
    await tx.syncConflict.update({ where: { id }, data: { state: 'resolved', resolvedAt: now() } });
    return { id, choice, revision };
  });
  return outcome;
}

export async function listBaselineIds(entityType: string, afterId: string, limit: number) {
  if (!isSyncEntityType(entityType)) throw new DomainError('VALIDATION_ERROR', '同步操作无效', 400);
  const where = { id: { gt: afterId } };
  const orderBy = { id: 'asc' as const };
  const select = { id: true };
  const rows = entityType === 'topic'
    ? await prisma.topic.findMany({ where, orderBy, take: limit, select })
    : entityType === 'tag'
      ? await prisma.tag.findMany({ where, orderBy, take: limit, select })
      : await prisma.task.findMany({ where, orderBy, take: limit, select });
  return { ids: rows.map((row) => row.id) };
}

export async function listBaselineRows(entityType: string, afterId: string, limit: number) {
  const ids = await listBaselineIds(entityType, afterId, limit);
  const rows = await prisma.$transaction(async (tx) => {
    const page = [];
    for (const id of ids.ids) {
      const live = await readLive(tx, entityType as SyncEntityType, id);
      if (live.row) page.push({ id, row: live.row });
    }
    return page;
  });
  return { rows };
}

/** Copies rows the hub does not have, and files conflicts for rows that differ. The hub row stays. */
export async function offerBaselineRows(deviceId: string, schemaVersion: string, entityType: string, rows: Array<{ id: string; row: Record<string, unknown> }>) {
  assertSchema(schemaVersion);
  if (!isSyncEntityType(entityType)) throw new DomainError('VALIDATION_ERROR', '同步操作无效', 400);
  if (rows.length < 1 || rows.length > 40) throw new DomainError('VALIDATION_ERROR', '同步操作无效', 400);
  const outcome = await prisma.$transaction(async (tx) => {
    const results = [];
    for (const item of rows) {
      if (!item.id || item.id.length > 200) throw new DomainError('VALIDATION_ERROR', '同步操作无效', 400);
      requireComplete(entityType, item.row);
      const incoming = canonicalSyncRow(entityType, item.row);
      const live = await readLive(tx, entityType, item.id);
      if (live.row && incoming && syncRowsEqual(entityType, live.row, incoming)) {
        results.push({ id: item.id, status: 'same' as const, row: live.row });
        continue;
      }
      if (live.row) {
        const merged = mergeSyncRow(entityType, live.row, null, incoming);
        await storeConflicts(tx, `baseline:${deviceId}:${entityType}:${item.id}`, deviceId, entityType, item.id, merged.conflicts);
        results.push({ id: item.id, status: 'conflict' as const, row: live.row });
        continue;
      }
      const applied = await applyIncoming(tx, deviceId, { opId: `baseline:${deviceId}:${entityType}:${item.id}`, entityType, entityId: item.id, before: null, after: incoming });
      results.push({ id: item.id, status: applied.status === 'conflict' ? 'conflict' as const : 'copied' as const, row: applied.landed ?? incoming });
    }
    await tx.syncDevice.update({ where: { id: deviceId }, data: { lastSeenAt: now() } });
    return results;
  });
  return { schemaVersion: localSchemaVersion(), tip: await currentSyncSeq(), results: outcome };
}

export async function findSyncDevice(token: string) {
  return prisma.syncDevice.findUnique({ where: { tokenHash: hash(token) } });
}
