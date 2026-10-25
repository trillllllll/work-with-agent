import { publishWorkspaceChange } from './workspace-events.js';
import { runtimeEnv } from '../shared/runtime-env.js';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { desktopDataDir, isServerMode } from './desktop-paths.js';
import { canonicalSyncRow, isCompleteSyncRow, isSyncEntityType, mergeSyncRow, syncRowsEqual, type SyncEntityType, type SyncRow } from './sync-merge.js';
import { appendGroupSyncOps, diffGroupOps, readLive, writeLive } from './sync-log.js';
import { localSchemaVersion } from './snapshots.js';
import { listSyncConflicts, resolveSyncConflict } from './sync-log.js';

const now = () => new Date().toISOString();
type GroupSide = Parameters<typeof diffGroupOps>[0];
type ReplicaDb = PrismaClient;
type SyncSnapshot = { schemaVersion: string; tip: number; entities: Record<SyncEntityType, Array<{ id: string; row: SyncRow }>> };

export type SyncBinding = { url: string; token: string };

export type ReplicaTransport = {
  snapshot?(): Promise<SyncSnapshot>;
  push(body: { schemaVersion: string; ops: Array<{ opId: string; entityType: string; entityId: string; before: SyncRow | null; after: SyncRow | null }> }): Promise<{ tip: number; results: Array<{ opId: string; status: string; seq: number | null; landed: SyncRow | null }> }>;
  pull(after: number, limit: number): Promise<{ tip: number; schemaVersion: string; ops: Array<{ seq: number; opId: string; entityType: string; entityId: string; before: SyncRow | null; after: SyncRow | null }> }>;
  rows(entity: SyncEntityType, afterId: string, limit: number): Promise<{ rows: Array<{ id: string; row: SyncRow }> }>;
  offer(entity: SyncEntityType, rows: Array<{ id: string; row: SyncRow }>): Promise<{ tip: number; results: Array<{ id: string; status: string; row: SyncRow | null }> }>;
};

export function assertSyncUrl(value: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new DomainError('VALIDATION_ERROR', '同步地址只接受 https 或本机 http', 400); }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  const allowed = !parsed.username && !parsed.password && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback));
  if (!allowed) throw new DomainError('VALIDATION_ERROR', '同步地址只接受 https 或本机 http', 400);
  return parsed.origin;
}

export function syncBindingPath() {
  return join(desktopDataDir(), 'sync-device.json');
}

/** Token stays in this file, never in the database that snapshots copy. */
export function readSyncBinding(): SyncBinding | null {
  const syncUrl = runtimeEnv('SYNC_URL'), syncToken = runtimeEnv('SYNC_TOKEN');
  if (syncUrl && syncToken) return { url: assertSyncUrl(syncUrl), token: syncToken };
  const path = syncBindingPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { url?: string; token?: string };
    if (!parsed.url || !parsed.token) return null;
    return { url: assertSyncUrl(parsed.url), token: parsed.token };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    return null;
  }
}

export function writeSyncBinding(binding: SyncBinding) {
  if (isServerMode()) throw new DomainError('VALIDATION_ERROR', '服务器不需要绑定到另一台服务器', 400);
  const url = assertSyncUrl(binding.url);
  const token = binding.token.trim();
  if (token.length < 20 || token.length > 200) throw new DomainError('VALIDATION_ERROR', '同步绑定无效', 400);
  const previous = readSyncBinding();
  if (previous && (previous.url !== url || previous.token !== token)) throw new DomainError('SYNC_ALREADY_BOUND', '这台设备已绑定同步工作区，请先完成原工作区迁移再更换凭据', 409);
  const path = syncBindingPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ url, token }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { url };
}

/** Vitest shares this process with a developer binding file. Tests opt in with DOVUN_SYNC_URL. */
function replicaBinding() {
  if (process.env.VITEST && !runtimeEnv('SYNC_URL')) return null;
  return readSyncBinding();
}

export async function syncStatus() {
  const binding = isServerMode() ? null : readSyncBinding();
  const state = await prisma.syncState.findUnique({ where: { id: 'local' } }).catch(() => null);
  const pending = await prisma.syncOutbox.count({ where: { state: 'pending' } });
  return { mode: isServerMode() ? 'server' as const : 'local' as const, bound: Boolean(binding), url: binding?.url ?? null, baselineReady: Boolean(state?.baselineReady), appliedHubSeq: state?.appliedHubSeq ?? 0, pending, ...replicaHealth };
}

const replicaHealth = { lastSuccessAt: null as string | null, lastError: null as string | null, syncing: false };

/** Conflict decisions belong to the hub; a local binding must not show an empty local inbox. */
export async function workspaceSyncConflicts() {
  const binding = isServerMode() ? null : replicaBinding();
  return binding ? hubData(binding, '/api/v1/sync/conflicts') : listSyncConflicts();
}
export async function resolveWorkspaceSyncConflict(id: string, choice: 'mine' | 'theirs', deviceId = 'server') {
  const binding = isServerMode() ? null : replicaBinding();
  return binding ? hubData(binding, `/api/v1/sync/conflicts/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({ choice }) }) : resolveSyncConflict(id, choice, deviceId);
}

async function ensureSyncState(db: ReplicaDb) {
  const row = await db.syncState.findUnique({ where: { id: 'local' } });
  if (row) return row;
  return db.syncState.create({ data: { id: 'local', appliedHubSeq: 0, baselineReady: false, updatedAt: now() } });
}

export async function appendReplicaOutbox(tx: Prisma.TransactionClient, changeId: string, before: GroupSide, after: GroupSide) {
  for (const op of diffGroupOps(before, after)) {
    await tx.syncOutbox.create({
      data: { opId: `${changeId}:${op.entityType}:${op.entityId}`, entityType: op.entityType, entityId: op.entityId, beforeJson: op.before ? JSON.stringify(op.before) : null, afterJson: op.after ? JSON.stringify(op.after) : null, state: 'pending', createdAt: now() },
    });
  }
}

/** A bound replica retains committed changes even while its first alignment is pending. */
export async function recordCommittedGroup(tx: Prisma.TransactionClient, changeId: string, before: GroupSide, after: GroupSide) {
  if (isServerMode() || !replicaBinding()) {
    await appendGroupSyncOps(tx, changeId, before, after);
    return;
  }
  await appendReplicaOutbox(tx, changeId, before, after);
}

async function enqueueOp(tx: Prisma.TransactionClient, opId: string, entityType: SyncEntityType, entityId: string, before: SyncRow | null, after: SyncRow | null) {
  const existing = await tx.syncOutbox.findUnique({ where: { opId }, select: { opId: true } });
  if (existing) return;
  await tx.syncOutbox.create({ data: { opId, entityType, entityId, beforeJson: before ? JSON.stringify(before) : null, afterJson: after ? JSON.stringify(after) : null, state: 'pending', createdAt: now() } });
}

async function applyPulled(tx: Prisma.TransactionClient, op: { opId: string; entityType: string; entityId: string; before: SyncRow | null; after: SyncRow | null }) {
  if (!isSyncEntityType(op.entityType)) return;
  const live = await readLive(tx, op.entityType, op.entityId);
  const before = canonicalSyncRow(op.entityType, op.before);
  const after = canonicalSyncRow(op.entityType, op.after);
  const merged = mergeSyncRow(op.entityType, live.row, before, after);
  if (!syncRowsEqual(op.entityType, live.row, merged.row)) await writeLive(tx, op.entityType, op.entityId, merged.row);
  if (merged.conflicts.length) await enqueueOp(tx, `pull:${createHash('sha256').update(op.opId).digest('hex').slice(0, 32)}`, op.entityType, op.entityId, after, live.row);
}

async function pageIds(db: ReplicaDb, entity: SyncEntityType, afterId: string) {
  const where = { id: { gt: afterId } };
  const orderBy = { id: 'asc' as const };
  const select = { id: true };
  if (entity === 'topic') return db.topic.findMany({ where, orderBy, take: 50, select });
  if (entity === 'tag') return db.tag.findMany({ where, orderBy, take: 50, select });
  return db.task.findMany({ where, orderBy, take: 50, select });
}

async function localRows(db: ReplicaDb, entity: SyncEntityType) {
  const rows: Array<{ id: string; row: SyncRow }> = [];
  let after = '';
  for (;;) {
    const ids = await pageIds(db, entity, after);
    if (!ids.length) break;
    const page = await db.$transaction(async (tx) => {
      const found: Array<{ id: string; row: SyncRow }> = [];
      for (const item of ids) {
        const live = await readLive(tx, entity, item.id);
        if (live.row) found.push({ id: item.id, row: live.row });
      }
      return found;
    });
    rows.push(...page);
    after = ids[ids.length - 1].id;
    if (ids.length < 50) break;
  }
  return rows;
}

function orderTasks(rows: Array<{ id: string; row: SyncRow }>) {
  const pending = new Map(rows.map((item) => [item.id, item]));
  const ordered: Array<{ id: string; row: SyncRow; detachParent: boolean }> = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((item) => typeof item.row.parentId !== 'string' || !pending.has(String(item.row.parentId)));
    const batch = ready.length ? ready : [[...pending.values()][0]];
    for (const item of batch) {
      pending.delete(item.id);
      ordered.push({ ...item, detachParent: !ready.length });
    }
  }
  return ordered;
}

async function writeMissing(db: ReplicaDb, entity: SyncEntityType, rows: Array<{ id: string; row: SyncRow }>) {
  const have = new Set((await localRows(db, entity)).map((item) => item.id));
  const missing = rows.filter((item) => !have.has(item.id));
  const ordered = entity === 'task' ? orderTasks(missing) : missing.map((item) => ({ ...item, detachParent: false }));
  for (const item of ordered) {
    const parent = item.row.parentId;
    const row = item.detachParent || (typeof parent === 'string' && !have.has(parent) && entity === 'task') ? { ...item.row, parentId: null } : item.row;
    await db.$transaction(async (tx) => {
      const live = await readLive(tx, entity, item.id);
      if (!live.row) await writeLive(tx, entity, item.id, row);
    });
    have.add(item.id);
  }
  if (entity !== 'task') return;
  for (const item of missing) {
    if (typeof item.row.parentId !== 'string') continue;
    await db.$transaction(async (tx) => {
      const live = await readLive(tx, entity, item.id);
      if (!live.row || live.row.parentId === item.row.parentId) return;
      if (!have.has(String(item.row.parentId))) return;
      await writeLive(tx, entity, item.id, { ...live.row, parentId: item.row.parentId });
    });
  }
}

async function offerAll(db: ReplicaDb, transport: ReplicaTransport, entity: SyncEntityType) {
  const found = await localRows(db, entity);
  const rows = entity === 'task' ? orderTasks(found).map(({ id, row }) => ({ id, row })) : found;
  for (let index = 0; index < rows.length; index += 40) {
    const batch = rows.slice(index, index + 40);
    if (!batch.length) continue;
    const offered = await transport.offer(entity, batch);
    if (!Number.isSafeInteger(offered.tip) || offered.tip < 0 || !Array.isArray(offered.results) || offered.results.length !== batch.length) protocolError();
    const seen = new Set<string>();
    for (const result of offered.results) {
      if (!batch.some(item => item.id === result.id) || seen.has(result.id) || !['same', 'copied', 'conflict'].includes(result.status) || !validRow(entity, result.row) || !result.row) protocolError();
      seen.add(result.id);
    }
    for (const result of offered.results) {
      if (result.status !== 'conflict' || !result.row) continue;
      await db.$transaction(async (tx) => {
        const live = await readLive(tx, entity, result.id);
        const ancestor = batch.find(item => item.id === result.id)!.row;
        const rebased = mergeSyncRow(entity, live.row, ancestor, result.row);
        if (!syncRowsEqual(entity, live.row, rebased.row)) await writeLive(tx, entity, result.id, rebased.row);
      });
    }
  }
}

function protocolError(): never {
  throw new DomainError('SYNC_PROTOCOL_ERROR', '同步响应无效，已保留本机修改和同步进度', 502);
}

function validRow(entity: SyncEntityType, value: unknown): boolean {
  return isCompleteSyncRow(entity, value);
}

function validateRows(entity: SyncEntityType, rows: Array<{ id: string; row: SyncRow }>, after: string, limit = 50) {
  if (!Array.isArray(rows) || rows.length > limit) protocolError();
  let previous = after;
  for (const item of rows) {
    if (typeof item.id !== 'string' || item.id <= previous || !item.row || !validRow(entity, item.row)) protocolError();
    previous = item.id;
  }
}

function validatePull(page: Awaited<ReturnType<ReplicaTransport['pull']>>, cursor: number) {
  if (!Number.isSafeInteger(page.tip) || page.tip < cursor || !Array.isArray(page.ops)) protocolError();
  let previous = cursor;
  const ids = new Set<string>();
  for (const op of page.ops) {
    if (!Number.isSafeInteger(op.seq) || op.seq !== previous + 1 || op.seq > page.tip || typeof op.opId !== 'string' || !op.opId || ids.has(op.opId) || typeof op.entityId !== 'string' || !op.entityId || !isSyncEntityType(op.entityType)) protocolError();
    if (!validRow(op.entityType, op.before) || !validRow(op.entityType, op.after)) protocolError();
    ids.add(op.opId); previous = op.seq;
  }
  // A missing range needs explicit recovery; it is not permission to skip to the tip.
  if (!page.ops.length && page.tip !== cursor) protocolError();
}

async function pullFrom(db: ReplicaDb, transport: ReplicaTransport, after: number) {
  let cursor = after;
  for (;;) {
    const page = await transport.pull(cursor, 100);
    if (page.schemaVersion !== localSchemaVersion()) throw new DomainError('SCHEMA_MISMATCH', '同步协议版本不一致，请先升级到同一版本', 409);
    validatePull(page, cursor);
    if (!page.ops.length) return cursor;
    for (const op of page.ops) {
      await db.$transaction(async (tx) => {
        await applyPulled(tx, op);
        await tx.syncState.upsert({ where: { id: 'local' }, create: { id: 'local', appliedHubSeq: op.seq, baselineReady: false, updatedAt: now() }, update: { appliedHubSeq: op.seq, updatedAt: now() } });
      });
      cursor = op.seq;
    }
    if (page.ops.length < 100 && page.tip <= cursor) return cursor;
  }
}

async function pushPending(db: ReplicaDb, transport: ReplicaTransport) {
  const pending = await db.syncOutbox.findMany({ where: { state: 'pending' }, orderBy: { seq: 'asc' }, take: 50 });
  if (!pending.length) return;
  const result = await transport.push({
    schemaVersion: localSchemaVersion(),
    ops: pending.map((op) => ({ opId: op.opId, entityType: op.entityType, entityId: op.entityId, before: op.beforeJson ? JSON.parse(op.beforeJson) as SyncRow : null, after: op.afterJson ? JSON.parse(op.afterJson) as SyncRow : null })),
  });
  if (!Number.isSafeInteger(result.tip) || result.tip < 0 || !Array.isArray(result.results) || result.results.length !== pending.length) protocolError();
  const receipts = new Set<string>();
  for (const item of result.results) {
    const op = pending.find(row => row.opId === item.opId);
    if (!op || !isSyncEntityType(op.entityType) || receipts.has(item.opId) || !['applied', 'conflict', 'duplicate'].includes(item.status) || (item.seq !== null && (!Number.isSafeInteger(item.seq) || item.seq < 1 || item.seq > result.tip)) || !validRow(op.entityType, item.landed)) protocolError();
    receipts.add(item.opId);
  }
  await db.$transaction(async (tx) => {
    for (const item of result.results) {
      const op = pending.find((row) => row.opId === item.opId);
      if (!op || !isSyncEntityType(op.entityType)) continue;
      const newer = await tx.syncOutbox.count({ where: { entityType: op.entityType, entityId: op.entityId, state: 'pending', seq: { gt: op.seq } } });
      if (!newer && item.landed) {
        const live = await readLive(tx, op.entityType, op.entityId);
        if (!syncRowsEqual(op.entityType, live.row, item.landed)) await writeLive(tx, op.entityType, op.entityId, item.landed);
      }
      await tx.syncOutbox.update({ where: { opId: item.opId }, data: { state: 'acked' } });
    }
  });
}

/** First alignment. Same id with different fields stays on the hub and enters the conflict inbox. */
async function alignReplicaUnlocked(db: ReplicaDb, transport: ReplicaTransport) {
  const state = await ensureSyncState(db);
  if (state.baselineReady) return { already: true, appliedHubSeq: state.appliedHubSeq };
  const snapshot = transport.snapshot ? await transport.snapshot() : null;
  const probe = snapshot ?? await transport.pull(0, 1);
  if (snapshot) {
    if (!Number.isSafeInteger(snapshot.tip) || snapshot.tip < 0 || !snapshot.entities) protocolError();
    for (const entity of ['topic', 'tag', 'task'] as const) validateRows(entity, snapshot.entities[entity], '', Number.MAX_SAFE_INTEGER);
  } else validatePull(probe as Awaited<ReturnType<ReplicaTransport['pull']>>, 0);
  if (probe.schemaVersion !== localSchemaVersion()) throw new DomainError('SCHEMA_MISMATCH', '同步协议版本不一致，请先升级到同一版本', 409);
  for (const entity of ['topic', 'tag', 'task'] as const) {
    let after = '';
    const remote: Array<{ id: string; row: SyncRow }> = snapshot ? snapshot.entities[entity] : [];
    for (; !snapshot;) {
      const page = await transport.rows(entity, after, 50);
      validateRows(entity, page.rows, after);
      if (!page.rows.length) break;
      remote.push(...page.rows);
      after = page.rows[page.rows.length - 1].id;
      if (page.rows.length < 50) break;
    }
    await writeMissing(db, entity, remote);
    await offerAll(db, transport, entity);
  }
  const tip = await pullFrom(db, transport, probe.tip);
  await db.syncState.update({ where: { id: 'local' }, data: { baselineReady: true, appliedHubSeq: tip, updatedAt: now() } });
  return { already: false, appliedHubSeq: tip };
}

async function runReplicaCycleUnlocked(db: ReplicaDb, transport: ReplicaTransport) {
  const state = await ensureSyncState(db);
  if (!state.baselineReady) return { skipped: 'baseline' as const };
  await pushPending(db, transport);
  const fresh = await db.syncState.findUniqueOrThrow({ where: { id: 'local' } });
  await pullFrom(db, transport, fresh.appliedHubSeq);
  return { skipped: null };
}

// Manual alignment and the automatic timer share the same queue. A failed operation
// releases it, and every subsequent operation re-reads the committed cursor.
const replicaLocks = new WeakMap<ReplicaDb, Promise<unknown>>();
function withReplicaLock<T>(db: ReplicaDb, operation: () => Promise<T>): Promise<T> {
  const next = (replicaLocks.get(db) ?? Promise.resolve()).catch(() => {}).then(operation);
  replicaLocks.set(db, next);
  void next.finally(() => { if (replicaLocks.get(db) === next) replicaLocks.delete(db); }).catch(() => {});
  return next;
}
export function alignReplica(db: ReplicaDb, transport: ReplicaTransport) {
  return withReplicaLock(db, () => alignReplicaUnlocked(db, transport));
}
export function runReplicaCycle(db: ReplicaDb, transport: ReplicaTransport) {
  return withReplicaLock(db, () => runReplicaCycleUnlocked(db, transport));
}

function hubData(binding: SyncBinding, path: string, init?: RequestInit) {
  return fetch(new URL(path, binding.url), {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/json', authorization: `Bearer ${binding.token}`, 'content-type': 'application/json', 'x-dovun-language': 'zh-CN' },
  }).then(async (response) => {
    const body = await response.json().catch(() => null) as { data?: unknown; error?: string } | null;
    // Remote authentication failure must not expire the owner's local login.
    if (response.status === 401 || response.status === 403) throw new DomainError('SYNC_AUTH_FAILED', '服务器未接受同步凭据，请核对后重试', 502);
    if (!response.ok || !body || body.data === undefined) throw new DomainError('SYNC_FAILED', '同步操作无效', 502);
    return body.data;
  });
}

export function httpReplicaTransport(binding = readSyncBinding()): ReplicaTransport {
  if (!binding) throw new DomainError('VALIDATION_ERROR', '同步绑定无效', 400);
  const schema = encodeURIComponent(localSchemaVersion());
  return {
    snapshot: () => hubData(binding, `/api/v1/sync/baseline/snapshot?schemaVersion=${schema}`) as Promise<SyncSnapshot>,
    push: (body) => hubData(binding, '/api/v1/sync/push', { method: 'POST', body: JSON.stringify(body) }) as ReturnType<ReplicaTransport['push']>,
    pull: (after, limit) => hubData(binding, `/api/v1/sync/pull?after=${after}&limit=${limit}&schemaVersion=${schema}`) as ReturnType<ReplicaTransport['pull']>,
    rows: (entity, afterId, limit) => hubData(binding, `/api/v1/sync/baseline/rows?entity=${entity}&afterId=${encodeURIComponent(afterId)}&limit=${limit}&schemaVersion=${schema}`) as ReturnType<ReplicaTransport['rows']>,
    offer: (entity, rows) => hubData(binding, '/api/v1/sync/baseline/offer', { method: 'POST', body: JSON.stringify({ schemaVersion: localSchemaVersion(), entityType: entity, rows }) }) as ReturnType<ReplicaTransport['offer']>,
  };
}

export async function alignBoundReplica() {
  if (isServerMode()) throw new DomainError('VALIDATION_ERROR', '服务器不需要绑定到另一台服务器', 400);
  if (!readSyncBinding()) throw new DomainError('VALIDATION_ERROR', '同步绑定无效', 400);
  return alignReplica(prisma, httpReplicaTransport());
}

/** Authentication and protocol checks happen before the binding file is created. */
export async function bindReplica(binding: SyncBinding) {
  if (isServerMode()) throw new DomainError('VALIDATION_ERROR', '服务器不需要绑定到另一台服务器', 400);
  const normalized = { url: assertSyncUrl(binding.url), token: binding.token.trim() };
  return withReplicaLock(prisma, async () => {
    const probe = await httpReplicaTransport(normalized).pull(0, 1);
    if (probe.schemaVersion !== localSchemaVersion()) throw new DomainError('SCHEMA_MISMATCH', '同步协议版本不一致，请先升级到同一版本', 409);
    // Pairing only probes connectivity; a legacy log can contain historical gaps.
    // Alignment uses its atomic snapshot cursor, then incremental pages must be contiguous.
    if (!Number.isSafeInteger(probe.tip) || probe.tip < 0 || !Array.isArray(probe.ops)) protocolError();
    return writeSyncBinding(normalized);
  });
}

export async function syncBoundReplicaNow() {
  if (isServerMode()) throw new DomainError('VALIDATION_ERROR', '服务器不需要绑定到另一台服务器', 400);
  const binding = replicaBinding();
  if (!binding) throw new DomainError('VALIDATION_ERROR', '同步绑定无效', 400);
  return withReplicaLock(prisma, async () => {
    replicaHealth.syncing = true;
    try {
      const transport = httpReplicaTransport(binding);
      const before = await ensureSyncState(prisma);
      const pending = await prisma.syncOutbox.count({ where: { state: 'pending' } });
      if (!before.baselineReady) await alignReplicaUnlocked(prisma, transport);
      await runReplicaCycleUnlocked(prisma, transport);
      replicaHealth.lastSuccessAt = now();
      replicaHealth.lastError = null;
      const state = await ensureSyncState(prisma);
      if (!before.baselineReady || pending || state.appliedHubSeq !== before.appliedHubSeq) publishWorkspaceChange({ kind: 'sync', syncSeq: state.appliedHubSeq });
      return { appliedHubSeq: state.appliedHubSeq };
    } catch (error) {
      replicaHealth.lastError = error instanceof DomainError ? error.code : 'SYNC_UNAVAILABLE';
      throw error;
    } finally { replicaHealth.syncing = false; }
  });
}

export function startReplicaSync() {
  if (isServerMode()) return () => {};
  let running = false;
  const timer = setInterval(() => {
    if (running || !replicaBinding()) return;
    running = true;
    void syncBoundReplicaNow().catch(() => {
      // Never include the remote body or credential in status/logs.
      console.error('同步失败：', replicaHealth.lastError);
    }).finally(() => { running = false; });
  }, 5_000);
  timer.unref();
  return () => clearInterval(timer);
}
