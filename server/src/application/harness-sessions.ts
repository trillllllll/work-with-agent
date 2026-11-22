import { randomUUID } from 'node:crypto';
import type { AgentNode, HarnessCommand as CommandRow, HarnessSession, Prisma } from '@prisma/client';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { isOnline } from './orchestration/nodes.js';
import { canBrowse } from './harness-directories.js';
import { requestHarnessRead, supportsHarnessLibrary } from './harness-library.js';
import {
  applyHarnessEvent, HARNESS_EVENTS, HARNESS_FEATURE, HARNESS_LIBRARY_LEASES, HARNESS_SETTINGS_FEATURE, harnessCommandSchema, harnessCreateSchema, harnessSyncSchema,
  harnessCatalogQuerySchema, harnessHistoryQuerySchema, harnessOpenThreadSchema, harnessStartSchema,
  harnessEventForClient, harnessSnapshotForClient,
  type HarnessDelivery, type HarnessEvent, type HarnessLease, type HarnessLibraryLease, type HarnessReceipt, type HarnessSnapshot,
} from '../node-agent/harness-protocol.js';

type Frame = { seq: number; event: HarnessEvent };
type Cache = { snapshot: HarnessSnapshot; frames: Frame[]; stale: boolean };
type StreamEvent =
  | HarnessSnapshot
  | { type: 'event'; epoch: number; seq: number; event: HarnessEvent }
  | { type: 'receipt'; receipt: ReturnType<typeof commandDto> }
  | { type: 'caughtUp'; epoch: number; seq: number }
  | { type: 'unavailable'; epoch: number; error: string };

const cache = new Map<string, Cache>();
const refresh = new Set<string>();
const listeners = new Map<string, Set<(event: StreamEvent) => void>>();
const expiresAfter = 30_000;
const codex = { id: 'codex', name: 'Codex' } as const;
const titleCommand = {
  where: { status: 'accepted', payload: { contains: '"operation":"send"' } },
  orderBy: [{ createdAt: 'asc' }, { commandId: 'asc' }],
  select: { payload: true },
  take: 1,
} satisfies Prisma.HarnessSession$commandsArgs;

function publish(id: string, event: StreamEvent) {
  for (const listener of listeners.get(id) ?? []) listener(event);
}
function pruneInactiveSnapshots() {
  if (cache.size <= 48) return;
  for (const [id, entry] of cache) {
    if (listeners.has(id) || entry.snapshot.view.turn?.status === 'inProgress' || entry.snapshot.view.approvals.length) continue;
    cache.delete(id);
    if (cache.size <= 48) break;
  }
}
function commandDto(row: CommandRow) {
  return { commandId: row.commandId, status: row.status, error: row.error, createdAt: row.createdAt, expiresAt: row.expiresAt };
}
function readStoredCommand(payload: string) {
  try { return harnessCommandSchema.parse(JSON.parse(payload)); }
  catch { return null; }
}
function sessionDto(session: HarnessSession & { commands: Array<{ payload: string }> }, node: AgentNode | null) {
  const first = session.commands[0];
  const command = first ? readStoredCommand(first.payload) : null;
  const title = command?.operation === 'send' ? Array.from(command.text.replace(/\s+/g, ' ')) : [];
  const state = cache.get(session.id);
  const view = state && !state.stale && state.snapshot.epoch === session.epoch ? state.snapshot.view : null;
  return {
    id: session.id, harness: codex.id, nodeId: session.nodeId, nodeName: node?.name ?? null,
    online: Boolean(node && isOnline(node) && (!session.library || supportsHarnessLibrary(node))),
    historyAvailable: Boolean(node && isOnline(node) && supportsHarnessLibrary(node) && session.threadId),
    settingsAvailable: Boolean(node && supportsHarnessSettings(node)),
    native: session.nativeTitle !== null,
    title: session.nativeTitle || (title.length ? title.slice(0, 48).join('') + (title.length > 48 ? '…' : '') : null),
    activity: view?.approvals.length ? 'approval' : view?.turn?.status === 'inProgress' ? 'running' : null,
    locationId: session.locationId, projectName: session.projectName, threadId: session.threadId, epoch: session.epoch,
    status: session.status, error: session.error, updatedAt: session.updatedAt,
    startCommandId: session.startCommandId,
  };
}
async function load(id: string) {
  const row = await prisma.harnessSession.findUnique({ where: { id } });
  if (!row) throw new DomainError('HARNESS_NOT_FOUND', '会话不存在', 404);
  return row;
}
function requireAvailable(node: AgentNode | null) {
  if (!node || !isOnline(node)) throw new DomainError('HARNESS_OFFLINE', '这台电脑当前离线', 409);
  if (!supportsHarness(node)) throw new DomainError('HARNESS_UNSUPPORTED', '电脑尚未启用 Codex 会话', 409);
}

export function supportsHarness(node: Pick<AgentNode, 'capabilitiesJson'>) {
  try { return JSON.parse(node.capabilitiesJson).harnessSessions === HARNESS_FEATURE; }
  catch { return false; }
}
function supportsHarnessSettings(node: Pick<AgentNode, 'capabilitiesJson'>) {
  try { return JSON.parse(node.capabilitiesJson).harnessSettings === HARNESS_SETTINGS_FEATURE; }
  catch { return false; }
}
async function projectLocation(db: Prisma.TransactionClient, nodeId: string, locationId: string) {
  const location = await db.projectLocation.findFirst({ where: { id: locationId, nodeId, status: 'verified', project: { archivedAt: null } }, include: { project: true } });
  if (location) return { cwd: location.path, projectName: location.project.name };
  const directory = await db.harnessDirectory.findFirst({ where: { id: locationId, nodeId } });
  if (directory) return { cwd: directory.path, projectName: directory.name };
  throw new DomainError('HARNESS_LOCATION', '请选择这台电脑上已经验证的项目位置', 409);
}

export async function listNativeHarnessThreads(raw: unknown) {
  const { nodeId, locationId, cursor } = harnessCatalogQuerySchema.parse(raw);
  const { cwd } = await projectLocation(prisma, nodeId, locationId);
  const node = await prisma.agentNode.findUnique({ where: { id: nodeId } });
  return requestHarnessRead(node, 'catalog', { cwd, cursor: cursor ?? null });
}

export async function openNativeHarnessThread(raw: unknown) {
  const { nodeId, locationId, threadId } = harnessOpenThreadSchema.parse(raw);
  const original = await projectLocation(prisma, nodeId, locationId);
  const node = await prisma.agentNode.findUnique({ where: { id: nodeId } });
  const thread = await requestHarnessRead(node, 'thread', { cwd: original.cwd, threadId });
  if (thread.threadId !== threadId) throw new DomainError('HARNESS_THREAD_CONFLICT', '原 Codex 线程与绑定不一致', 409);
  return prisma.$transaction(async (tx) => {
    const available = await tx.agentNode.findUnique({ where: { id: nodeId, status: 'active', deletedAt: null } });
    requireAvailable(available);
    if (!available || available.tokenHash !== node?.tokenHash || !supportsHarnessLibrary(available)) {
      throw new DomainError('HARNESS_LIBRARY_UNSUPPORTED', '这台电脑的会话连接已变化，请重试', 409);
    }
    const { cwd, projectName } = await projectLocation(tx, nodeId, locationId);
    if (cwd !== original.cwd) throw new DomainError('HARNESS_LOCATION', '项目位置已变化，请重新选择', 409);
    const row = await tx.harnessSession.upsert({
      where: { nodeId_threadId: { nodeId, threadId } }, update: { threadId },
      create: { nodeId, activeNodeId: nodeId, locationId, cwd, projectName, threadId, library: true,
        nativeTitle: thread.title, startCommandId: randomUUID(), createdAt: new Date().toISOString(), updatedAt: thread.updatedAt },
    });
    return { sessionId: row.id };
  });
}

export async function readHarnessHistory(id: string, raw: unknown) {
  const { cursor } = harnessHistoryQuerySchema.parse(raw);
  const row = await load(id);
  if (!row.threadId || !row.activeNodeId) throw new DomainError('HARNESS_SESSION_STALE', '这条会话尚未连接', 409);
  let cwd = row.cwd;
  // Earlier releases saved the immutable directory in the creation command.
  if (!cwd) {
    const start = await prisma.harnessCommand.findUnique({ where: { sessionId_commandId: { sessionId: id, commandId: row.startCommandId } } });
    if (start) cwd = harnessStartSchema.safeParse(JSON.parse(start.payload)).data?.cwd ?? null;
  }
  if (!cwd) throw new DomainError('HARNESS_LOCATION', '找不到原会话的项目位置', 409);
  const node = await prisma.agentNode.findUnique({ where: { id: row.nodeId } });
  return requestHarnessRead(node, 'history', { cwd, threadId: row.threadId, cursor: cursor ?? null });
}
export async function listHarnessSessions() {
  const nodes = await prisma.agentNode.findMany({ where: { deletedAt: null, status: 'active' } });
  const available = new Map(nodes.map((node) => [node.id, node]));
  const directories = await prisma.harnessDirectory.findMany({ where: { nodeId: { in: [...available.keys()] } }, orderBy: [{ name: 'asc' }, { path: 'asc' }] });
  const sessions = await prisma.harnessSession.findMany({
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 100, include: { commands: titleCommand },
  });
  return {
    harnesses: [codex],
    nodes: nodes.map((node) => ({ id: node.id, name: node.name, online: isOnline(node), supportsHarness: supportsHarness(node),
      harnessLibrary: supportsHarnessLibrary(node), canBrowse: canBrowse(node) })),
    directories: directories.map((dir) => ({ id: dir.id, nodeId: dir.nodeId, path: dir.path, projectName: dir.name, computerName: available.get(dir.nodeId)!.name })),
    sessions: sessions.map((session) => sessionDto(session, available.get(session.nodeId) ?? null)),
  };
}
export async function readHarnessSession(id: string, timeline = false, settings = false) {
  const row = await prisma.harnessSession.findUnique({ where: { id }, include: { commands: titleCommand } });
  if (!row) throw new DomainError('HARNESS_NOT_FOUND', '会话不存在', 404);
  const node = await prisma.agentNode.findUnique({ where: { id: row.nodeId } });
  const view = cache.get(id);
  const snapshot = view?.snapshot.epoch === row.epoch ? view.snapshot : null;
  return { ...sessionDto(row, node), snapshot: snapshot && harnessSnapshotForClient(snapshot, timeline, settings),
    current: !!view && !view.stale && view.snapshot.epoch === row.epoch };
}
export async function createHarnessSession(body: unknown) {
  const input = harnessCreateSchema.parse(body);
  const result = await prisma.$transaction(async (tx) => {
    const prior = await tx.harnessSession.findUnique({ where: { startCommandId: input.commandId } });
    if (prior) {
      if (prior.nodeId !== input.nodeId || prior.locationId !== input.locationId) conflict();
      const command = await tx.harnessCommand.findUniqueOrThrow({ where: { sessionId_commandId: { sessionId: prior.id, commandId: input.commandId } } });
      return { sessionId: prior.id, receipt: commandDto(command) };
    }
    const { cwd, projectName } = await projectLocation(tx, input.nodeId, input.locationId);
    const node = await tx.agentNode.findFirst({ where: { id: input.nodeId, status: 'active', deletedAt: null } });
    requireAvailable(node);
    const library = Boolean(node && supportsHarnessLibrary(node));
    if (!library && await tx.harnessSession.findFirst({ where: { activeNodeId: input.nodeId } })) {
      throw new DomainError('HARNESS_ACTIVE', '这台电脑已有会话，请打开原会话', 409);
    }
    const now = new Date();
    const session = await tx.harnessSession.create({ data: {
      nodeId: input.nodeId, activeNodeId: input.nodeId, locationId: input.locationId,
      cwd, library, projectName, startCommandId: input.commandId,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    } });
    const command = await tx.harnessCommand.create({ data: {
      sessionId: session.id, commandId: input.commandId,
      payload: JSON.stringify({ commandId: input.commandId, operation: 'start', cwd }),
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + expiresAfter).toISOString(),
    } });
    return { sessionId: session.id, receipt: commandDto(command) };
  });
  return result;
}
function conflict(): never { throw new DomainError('HARNESS_COMMAND_CONFLICT', '同一个操作 ID 的内容已变化', 409); }

export async function queueHarnessCommand(id: string, body: unknown) {
  const input = harnessCommandSchema.parse(body);
  const payload = JSON.stringify(input);
  return prisma.$transaction(async (tx) => {
    const prior = await tx.harnessCommand.findUnique({ where: { sessionId_commandId: { sessionId: id, commandId: input.commandId } } });
    if (prior) {
      if (prior.payload !== payload) conflict();
      return commandDto(prior);
    }
    const session = await tx.harnessSession.findUnique({ where: { id } });
    if (!session) throw new DomainError('HARNESS_NOT_FOUND', '会话不存在', 404);
    const node = await tx.agentNode.findUnique({ where: { id: session.nodeId } });
    requireAvailable(node);
    const view = cache.get(id);
    if (!session.activeNodeId || (session.library && (!node || !supportsHarnessLibrary(node)))
        || session.status !== 'ready' || session.epoch !== input.expectedEpoch || !view || view.stale || view.snapshot.epoch !== session.epoch) {
      throw new DomainError('HARNESS_SESSION_STALE', '会话正在恢复，请刷新后重试', 409);
    }
    if ('expectedSettingsRevision' in input) {
      if (!node || !supportsHarnessSettings(node)) throw new DomainError('HARNESS_SETTINGS_UNSUPPORTED', '本机执行器暂不支持会话设置', 409);
      if (view.snapshot.view.settings?.revision !== input.expectedSettingsRevision) {
        throw new DomainError('HARNESS_SETTINGS_STALE', '会话设置已变更，请刷新后重试', 409);
      }
    }
    const now = new Date();
    return commandDto(await tx.harnessCommand.create({ data: {
      sessionId: id, commandId: input.commandId, payload, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresAfter).toISOString(),
    } }));
  });
}
export async function readHarnessReceipt(sessionId: string, commandId: string) {
  const row = await prisma.harnessCommand.findUnique({ where: { sessionId_commandId: { sessionId, commandId } } });
  if (!row) throw new DomainError('HARNESS_COMMAND_NOT_FOUND', '未找到这次操作', 404);
  if (row.status === 'queued' && Date.parse(row.expiresAt) <= Date.now()) {
    await expireQueued(sessionId);
    return commandDto(await prisma.harnessCommand.findUniqueOrThrow({ where: { sessionId_commandId: { sessionId, commandId } } }));
  }
  return commandDto(row);
}

async function expireQueued(sessionId: string) {
  const at = new Date().toISOString();
  const expired = await prisma.$transaction(async (tx) => {
    const rows = await tx.harnessCommand.findMany({ where: { sessionId, status: 'queued', expiresAt: { lte: at } } });
    if (!rows.length) return [];
    await tx.harnessCommand.updateMany({ where: { sessionId, status: 'queued', expiresAt: { lte: at } }, data: { status: 'expired', error: '指令已过期，未送达电脑' } });
    await tx.harnessSession.updateMany({
      where: { id: sessionId, status: 'creating', startCommandId: { in: rows.map((row) => row.commandId) } },
      data: { status: 'failed', activeNodeId: null, error: '创建指令未送达电脑', updatedAt: at },
    });
    return rows.map((row) => ({ ...row, status: 'expired', error: '指令已过期，未送达电脑' }));
  });
  for (const row of expired) publish(sessionId, { type: 'receipt', receipt: commandDto(row) });
}

export async function leaseHarness(nodeId: string, tokenHash: string): Promise<HarnessLease | undefined> {
  const session = await prisma.harnessSession.findFirst({ where: { activeNodeId: nodeId, library: false }, orderBy: { createdAt: 'asc' } });
  if (!session) return;
  const assignment = await dispatchHarness(session.id, nodeId, tokenHash, false);
  if (!assignment) return;
  const { library: _library, nativeCwd: _cwd, ...lease } = assignment;
  return lease;
}

export async function leaseHarnessLibrary(nodeId: string, tokenHash: string): Promise<HarnessLibraryLease[]> {
  const rows = await prisma.harnessSession.findMany({
    where: { activeNodeId: nodeId, OR: [
      { commands: { some: { status: { in: ['queued', 'dispatched'] } } } },
      { status: 'creating', threadId: { not: null } },
    ] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: HARNESS_LIBRARY_LEASES, select: { id: true },
  });
  if (rows.length < HARNESS_LIBRARY_LEASES) {
    const pending = rows.map((row) => row.id);
    rows.push(...await prisma.harnessSession.findMany({
      where: { activeNodeId: nodeId, id: { notIn: pending }, OR: [{ library: false }, { id: { in: [...refresh] } }] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: HARNESS_LIBRARY_LEASES - rows.length, select: { id: true },
    }));
  }
  const leases: HarnessLibraryLease[] = [];
  for (const row of rows) {
    const lease = await dispatchHarness(row.id, nodeId, tokenHash, true);
    if (lease) leases.push(lease);
  }
  return leases;
}

async function dispatchHarness(id: string, nodeId: string, tokenHash: string, library: boolean): Promise<HarnessLibraryLease | undefined> {
  await expireQueued(id);
  return prisma.$transaction(async (tx) => {
    const node = await tx.agentNode.findUnique({ where: { id: nodeId } });
    const row = await tx.harnessSession.findUnique({ where: { id, activeNodeId: nodeId } });
    if (!node || node.status !== 'active' || node.deletedAt || node.tokenHash !== tokenHash || !row || !supportsHarness(node)
        || (library ? !supportsHarnessLibrary(node) : row.library)) return;
    const dispatchTime = new Date().toISOString();
    // Old executors parse the whole lease strictly, including commands left by a newer executor.
    const unsupportedSettings: Prisma.HarnessCommandWhereInput = supportsHarnessSettings(node) ? {} : { NOT: [
      { payload: { contains: '"operation":"configure"' } }, { payload: { contains: '"expectedSettingsRevision":' } },
    ] };
    const commands = await tx.harnessCommand.findMany({
      where: { ...unsupportedSettings, sessionId: row.id, OR: [{ status: 'dispatched' }, { status: 'queued', expiresAt: { gt: dispatchTime } }] },
      orderBy: [{ createdAt: 'asc' }, { commandId: 'asc' }], take: 16,
    });
    await tx.harnessCommand.updateMany({
      where: { sessionId: row.id, commandId: { in: commands.map((command) => command.commandId) }, status: 'queued' },
      data: { status: 'dispatched', dispatchedAt: dispatchTime },
    });
    return {
      sessionId: row.id, threadId: row.threadId, epoch: row.epoch,
      snapshotRequested: row.status === 'unavailable' || refresh.has(row.id) || !cache.has(row.id),
      commands: commands.map(({ sessionId, expiresAt, payload }) => ({ sessionId, expiresAt, command: JSON.parse(payload) as HarnessDelivery['command'] })),
      library: row.library,
      ...(row.epoch === 0 && row.threadId && row.cwd && row.nativeTitle !== null ? { nativeCwd: row.cwd } : {}),
    };
  });
}

async function saveReceipt(session: HarnessSession, input: HarnessReceipt) {
  const record = await prisma.$transaction(async (tx) => {
    const current = await tx.harnessCommand.findUnique({ where: { sessionId_commandId: { sessionId: session.id, commandId: input.commandId } } });
    if (!current) throw new DomainError('HARNESS_COMMAND_NOT_FOUND', '未找到这次操作', 404);
    if (current.status !== 'dispatched' && !(current.status === 'unknown' && input.status === 'accepted')) return current;
    const at = new Date().toISOString();
    const updated = await tx.harnessCommand.update({
      where: { sessionId_commandId: { sessionId: session.id, commandId: input.commandId } },
      data: { status: input.status, error: input.error ?? null },
    });
    if (session.startCommandId === input.commandId && input.status !== 'accepted') {
      await tx.harnessSession.updateMany({
        where: { id: session.id, threadId: null },
        data: {
          status: input.status === 'unknown' ? 'unavailable' : 'failed',
          ...(input.status === 'unknown' ? {} : { activeNodeId: null }),
          error: input.error ?? '创建会话失败', updatedAt: at,
        },
      });
    }
    if (input.status === 'accepted' && session.startCommandId !== input.commandId) {
      const command = readStoredCommand(current.payload);
      if (command?.operation === 'send' || command?.operation === 'steer') {
        await tx.harnessSession.updateMany({ where: { id: session.id, updatedAt: { lt: at } }, data: { updatedAt: at } });
      }
    }
    return updated;
  });
  publish(session.id, { type: 'receipt', receipt: commandDto(record) });
}

export async function syncHarness(node: AgentNode, id: string, raw: unknown) {
  const input = harnessSyncSchema.parse(raw);
  const row = await load(id);
  const authenticated = await prisma.agentNode.findFirst({ where: { id: node.id, tokenHash: node.tokenHash, status: 'active', deletedAt: null }, select: { id: true } });
  if (!authenticated) throw new DomainError('NODE_REVOKED', '电脑已断开', 401);
  if (row.nodeId !== node.id || !supportsHarness(node) || (row.library && !supportsHarnessLibrary(node))
      || (row.activeNodeId !== node.id && input.type !== 'receipt')) {
    throw new DomainError('HARNESS_NODE_SCOPE', '这台电脑没有会话权限', 403);
  }
  if (input.type === 'receipt') { await saveReceipt(row, input); return {}; }
  if (input.epoch < row.epoch) return {};
  if (input.type === 'unavailable') {
    if (input.epoch !== row.epoch) return {};
    await prisma.harnessSession.updateMany({
      where: { id, epoch: input.epoch },
      data: { status: 'unavailable', error: input.error, updatedAt: new Date().toISOString() },
    });
    const entry = cache.get(id);
    if (entry?.snapshot.epoch === input.epoch) entry.stale = true;
    if (!row.library || listeners.has(id)) refresh.add(id);
    publish(id, input);
    return {};
  }
  const current = cache.get(id);
  if (input.type === 'snapshot') {
    if (row.threadId && row.threadId !== input.threadId) throw new DomainError('HARNESS_THREAD_CONFLICT', '原 Codex 线程与绑定不一致', 409);
    if (current?.snapshot.epoch === input.epoch && current.snapshot.seq > input.seq) return {};
    const result = await prisma.harnessSession.updateMany({
      where: { id, activeNodeId: node.id, epoch: { lte: input.epoch }, OR: [{ threadId: null }, { threadId: input.threadId }] },
      data: { threadId: input.threadId, epoch: input.epoch, status: 'ready', error: null, updatedAt: new Date().toISOString() },
    });
    const latest = cache.get(id)?.snapshot;
    if (!result.count || latest && (latest.epoch > input.epoch || latest.epoch === input.epoch && latest.seq > input.seq)) return {};
    cache.set(id, { snapshot: input, frames: current?.snapshot.epoch === input.epoch && current.snapshot.seq === input.seq ? current.frames : [], stale: false });
    refresh.delete(id);
    publish(id, input);
    pruneInactiveSnapshots();
    return { seq: input.seq };
  }
  if (!current || current.stale || input.epoch !== current.snapshot.epoch || input.epoch !== row.epoch) {
    refresh.add(id);
    return { snapshotRequested: true };
  }
  const upcoming = input.events.filter((event) => event.seq > current.snapshot.seq);
  if (upcoming.some((event, index) => event.seq !== current.snapshot.seq + index + 1)) {
    refresh.add(id);
    return { snapshotRequested: true };
  }
  for (const frame of upcoming) {
    current.snapshot = { ...current.snapshot, seq: frame.seq, view: applyHarnessEvent(current.snapshot.view, frame.event) };
    current.frames.push(frame);
    publish(id, { type: 'event', epoch: input.epoch, ...frame });
  }
  current.frames = current.frames.slice(-HARNESS_EVENTS);
  return { seq: current.snapshot.seq };
}

export function subscribeHarness(id: string, after: { epoch: number; seq: number } | null, emit: (event: StreamEvent) => void,
  timeline = false, library = false, settings = false) {
  let cursor = after;
  const projectEvent = (event: HarnessEvent) => harnessEventForClient(event, timeline, settings);
  const send = (frame: StreamEvent) => {
    if (frame.type === 'snapshot') {
      cursor = frame;
      emit(harnessSnapshotForClient(frame, timeline, settings));
      return;
    }
    if (frame.type === 'event') {
      const event = projectEvent(frame.event);
      if (!event) return;
      // A client may skip optional events. The next visible update must then supply a full snapshot.
      if (cursor && (cursor.epoch !== frame.epoch || cursor.seq + 1 !== frame.seq)) {
        const snapshot = cache.get(id)?.snapshot;
        if (snapshot) send(snapshot);
        return;
      }
      cursor = frame;
      emit({ ...frame, event });
      return;
    }
    emit(frame);
  };
  let subscribed = listeners.get(id);
  if (!subscribed) { subscribed = new Set(); listeners.set(id, subscribed); }
  subscribed.add(send);
  if (library) refresh.add(id);
  const current = cache.get(id);
  if (current && !current.stale) {
    if (!after) send(current.snapshot);
    else if (current.snapshot.epoch === after.epoch && after.seq <= current.snapshot.seq && after.seq >= (current.frames[0]?.seq ?? current.snapshot.seq + 1) - 1) {
      const later = current.frames.filter((frame) => frame.seq > after.seq);
      if (later.some((frame) => !projectEvent(frame.event))) send(current.snapshot);
      else {
        for (const frame of later) send({ type: 'event', epoch: after.epoch, ...frame });
        send({ type: 'caughtUp', epoch: current.snapshot.epoch, seq: current.snapshot.seq });
      }
    } else refresh.add(id);
  } else refresh.add(id);
  return () => {
    subscribed.delete(send);
    if (!subscribed.size) { listeners.delete(id); refresh.delete(id); pruneInactiveSnapshots(); }
  };
}
