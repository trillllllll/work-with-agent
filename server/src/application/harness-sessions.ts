import type { AgentNode, HarnessCommand as CommandRow, HarnessSession } from '@prisma/client';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { isOnline } from './orchestration/nodes.js';
import {
  applyHarnessEvent, HARNESS_EVENTS, HARNESS_FEATURE, harnessCommandSchema, harnessCreateSchema, harnessSyncSchema,
  type HarnessDelivery, type HarnessEvent, type HarnessLease, type HarnessReceipt, type HarnessSnapshot,
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

function publish(id: string, event: StreamEvent) {
  for (const listener of listeners.get(id) ?? []) listener(event);
}
function commandDto(row: CommandRow) {
  return { commandId: row.commandId, status: row.status, error: row.error, createdAt: row.createdAt, expiresAt: row.expiresAt };
}
function sessionDto(session: HarnessSession, node: AgentNode | null) {
  return {
    id: session.id, nodeId: session.nodeId, nodeName: node?.name ?? null, online: node ? isOnline(node) : false,
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
export async function listHarnessSessions() {
  const nodes = await prisma.agentNode.findMany({ where: { deletedAt: null, status: 'active' } });
  const available = new Map(nodes.map((node) => [node.id, node]));
  const sessions = await prisma.harnessSession.findMany({ orderBy: { updatedAt: 'desc' }, take: 100 });
  return {
    nodes: nodes.map((node) => ({ id: node.id, name: node.name, online: isOnline(node), supportsHarness: supportsHarness(node) })),
    sessions: sessions.map((session) => sessionDto(session, available.get(session.nodeId) ?? null)),
  };
}
export async function readHarnessSession(id: string) {
  const row = await load(id);
  const node = await prisma.agentNode.findUnique({ where: { id: row.nodeId } });
  const view = cache.get(id);
  return { ...sessionDto(row, node), snapshot: view?.snapshot.epoch === row.epoch ? view.snapshot : null, current: !!view && !view.stale && view.snapshot.epoch === row.epoch };
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
    const location = await tx.projectLocation.findUnique({ where: { id: input.locationId }, include: { node: true, project: true } });
    if (!location || location.nodeId !== input.nodeId || location.status !== 'verified' || location.project.archivedAt) {
      throw new DomainError('HARNESS_LOCATION', '请选择这台电脑上已经验证的项目位置', 409);
    }
    requireAvailable(location.node);
    if (await tx.harnessSession.findUnique({ where: { activeNodeId: input.nodeId } })) {
      throw new DomainError('HARNESS_ACTIVE', '这台电脑已有会话，请打开原会话', 409);
    }
    const now = new Date();
    const session = await tx.harnessSession.create({ data: {
      nodeId: input.nodeId, activeNodeId: input.nodeId, locationId: location.id,
      projectName: location.project.name, startCommandId: input.commandId,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    } });
    const command = await tx.harnessCommand.create({ data: {
      sessionId: session.id, commandId: input.commandId,
      payload: JSON.stringify({ commandId: input.commandId, operation: 'start', cwd: location.path }),
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
    requireAvailable(await tx.agentNode.findUnique({ where: { id: session.nodeId } }));
    const view = cache.get(id);
    if (!session.activeNodeId || session.status !== 'ready' || session.epoch !== input.expectedEpoch || !view || view.stale || view.snapshot.epoch !== session.epoch) {
      throw new DomainError('HARNESS_SESSION_STALE', '会话正在恢复，请刷新后重试', 409);
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
  const session = await prisma.harnessSession.findUnique({ where: { activeNodeId: nodeId } });
  if (!session) return;
  await expireQueued(session.id);
  return prisma.$transaction(async (tx) => {
    const node = await tx.agentNode.findUnique({ where: { id: nodeId } });
    const row = await tx.harnessSession.findUnique({ where: { activeNodeId: nodeId } });
    if (!node || node.status !== 'active' || node.deletedAt || node.tokenHash !== tokenHash || !row || !supportsHarness(node)) return;
    const dispatchTime = new Date().toISOString();
    const commands = await tx.harnessCommand.findMany({
      where: { sessionId: row.id, OR: [{ status: 'dispatched' }, { status: 'queued', expiresAt: { gt: dispatchTime } }] },
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
    return updated;
  });
  publish(session.id, { type: 'receipt', receipt: commandDto(record) });
}

export async function syncHarness(node: AgentNode, id: string, raw: unknown) {
  const input = harnessSyncSchema.parse(raw);
  const row = await load(id);
  const authenticated = await prisma.agentNode.findFirst({ where: { id: node.id, tokenHash: node.tokenHash, status: 'active', deletedAt: null }, select: { id: true } });
  if (!authenticated) throw new DomainError('NODE_REVOKED', '电脑已断开', 401);
  if (row.nodeId !== node.id || !supportsHarness(node) || !row.activeNodeId && input.type !== 'receipt') {
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
    refresh.add(id);
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

export function subscribeHarness(id: string, after: { epoch: number; seq: number } | null, emit: (event: StreamEvent) => void) {
  let subscribed = listeners.get(id);
  if (!subscribed) { subscribed = new Set(); listeners.set(id, subscribed); }
  subscribed.add(emit);
  const current = cache.get(id);
  if (current && !current.stale) {
    if (!after) emit(current.snapshot);
    else if (current.snapshot.epoch === after.epoch && after.seq <= current.snapshot.seq && after.seq >= (current.frames[0]?.seq ?? current.snapshot.seq + 1) - 1) {
      for (const frame of current.frames) if (frame.seq > after.seq) emit({ type: 'event', epoch: after.epoch, ...frame });
      emit({ type: 'caughtUp', epoch: current.snapshot.epoch, seq: current.snapshot.seq });
    } else refresh.add(id);
  } else refresh.add(id);
  return () => {
    subscribed.delete(emit);
    if (!subscribed.size) listeners.delete(id);
  };
}
