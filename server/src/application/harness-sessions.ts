import { randomUUID } from 'node:crypto';
import { Prisma, type AgentNode, type HarnessSession } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { isOnline } from './orchestration/nodes.js';
import { canBrowse } from './harness-directories.js';
import { notifyHarnessNode } from './harness-wake.js';
import { nodeHarnesses, requestHarnessRead, supportsHarnessLibrary, supportsHarnessOrganization, supportsHarnessWorkspace } from './harness-library.js';
import {
  applyHarnessEvent, HARNESS_ADVANCED_PERMISSIONS_FEATURE, HARNESS_EVENTS, HARNESS_LIBRARY_LEASES, HARNESS_PERMISSIONS_FEATURE, HARNESS_SETTINGS_FEATURE, HARNESS_ZCODE_LIVE_FEATURE, harnessCommandSchema, harnessCreateSchema, harnessSyncSchema,
  HARNESS_IMAGE_FILE_LIMIT, HARNESS_LARGE_IMAGES_FEATURE, HARNESS_LEGACY_IMAGE_LIMIT, HARNESS_MESSAGE_ORIGIN_FEATURE, HARNESS_ZCODE_CREATE_FEATURE,
  imageAttachmentBytes,
  harnessCatalogQuerySchema, harnessFilesQuerySchema, harnessHistoryQuerySchema, harnessIndexQuerySchema, harnessMetadataSchema,
  harnessOpenThreadSchema, harnessStartSchema, harnessKind, harnessNames, harnessOrganizationSchema, harnessProjectPinsSchema,
  harnessEventForClient, harnessSnapshotForClient, HARNESS_WORKSPACE_OPERATIONS, requiresAdvancedPermissions, requiresHarnessWorkspace, requiresNativePermissionSettings,
  type HarnessDelivery, type HarnessEvent, type HarnessKind, type HarnessLease, type HarnessLibraryLease, type HarnessOrganization, type HarnessReceipt, type HarnessSnapshot,
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
const leaseCommandBytes = 8 * 1024 * 1024;
const legacyImageEncodedLimit = Math.ceil(HARNESS_LEGACY_IMAGE_LIMIT / 3) * 4;
const listQuery = z.object({
  cursor: z.string().min(1).max(200).optional(), locationId: z.string().min(1).max(200).optional(),
  archived: z.enum(['0', '1']).optional(), harness: harnessKind.optional(),
}).strip();
const receiptFields = { commandId: true, status: true, error: true, createdAt: true, expiresAt: true, resultSessionId: true } as const;
type ReceiptRow = Prisma.HarnessCommandGetPayload<{ select: typeof receiptFields }>;

async function firstPrompts(sessions: HarnessSession[]) {
  const ids = sessions.filter((session) => !session.title && !session.nativeTitle).map((session) => session.id);
  if (!ids.length) return new Map<string, string>();
  // The first prompt supplies an untitled session's label. Only load its text, since it can contain image attachments.
  const prompts = await prisma.$queryRaw<Array<{ id: string; text: string | null }>>`
    SELECT s."id", (
      SELECT CASE WHEN json_valid(c."payload") THEN json_extract(c."payload", '$.text') END
      FROM "harness_commands" c
      WHERE c."sessionId" = s."id" AND c."status" = 'accepted' AND instr(c."payload", '"operation":"send"') > 0
      ORDER BY c."createdAt", c."commandId" LIMIT 1
    ) AS "text"
    FROM "harness_sessions" s WHERE s."id" IN (${Prisma.join(ids)})
  `;
  return new Map(prompts.map(({ id, text }) => [id, typeof text === 'string' ? text : '']));
}

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
function commandDto(row: ReceiptRow) {
  return { commandId: row.commandId, status: row.status, error: row.error, createdAt: row.createdAt, expiresAt: row.expiresAt,
    ...(row.resultSessionId ? { resultSessionId: row.resultSessionId } : {}),
  };
}
function readStoredCommand(payload: string) {
  try { return harnessCommandSchema.parse(JSON.parse(payload)); }
  catch { return null; }
}
function storedJson(value: string | null | undefined): unknown {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}
const projectPinsByHarness = z.object({
  codex: harnessProjectPinsSchema.optional(), claude: harnessProjectPinsSchema.optional(), zcode: harnessProjectPinsSchema.optional(),
  opencode: harnessProjectPinsSchema.optional(), grok: harnessProjectPinsSchema.optional(), dsh: harnessProjectPinsSchema.optional(),
});

function nativeOrganizationUpdate(organization: HarnessOrganization | undefined, session?: HarnessSession | null) {
  if (!organization) return {};
  const oldState = harnessOrganizationSchema.safeParse(storedJson(session?.nativeOrganizationJson)).data;
  const nativeOrganizationJson = JSON.stringify({ ...oldState, ...organization });
  const timestamp = new Date().toISOString();
  const followsPin = session?.pinnedOverride == null && organization.pinned !== undefined;
  const followsArchive = session?.archivedOverride == null && organization.archived !== undefined;
  const pinnedAt = organization.pinned ? session?.pinnedAt ?? timestamp : null;
  const archivedAt = organization.archived ? session?.archivedAt ?? timestamp : null;
  const pinOrder = organization.pinned ? organization.pinOrder ?? null : null;
  return {
    ...(nativeOrganizationJson !== session?.nativeOrganizationJson ? { nativeOrganizationJson } : {}),
    ...(followsPin && pinnedAt !== session?.pinnedAt ? { pinnedAt } : {}),
    ...(followsPin && pinOrder !== session?.nativePinOrder ? { nativePinOrder: pinOrder } : {}),
    ...(followsArchive && archivedAt !== session?.archivedAt ? { archivedAt } : {}),
  };
}
function sessionDto(session: HarnessSession, node: AgentNode | null, firstPrompt = '') {
  const title = Array.from(firstPrompt.replace(/\s+/g, ' '));
  const state = cache.get(session.id);
  const view = state && !state.stale && state.snapshot.epoch === session.epoch ? state.snapshot.view : null;
  const organization = harnessOrganizationSchema.safeParse(storedJson(session.nativeOrganizationJson)).data;
  return {
    id: session.id, harness: session.harness, nodeId: session.nodeId, nodeName: node?.name ?? null,
    online: Boolean(node && isOnline(node) && supportsHarness(node, session.harness) && (!session.library || supportsHarnessLibrary(node))),
    historyAvailable: Boolean(node && isOnline(node) && supportsHarness(node, session.harness) && supportsHarnessLibrary(node) && session.threadId),
    settingsAvailable: Boolean(node && supportsHarnessSettings(node) && (session.harness !== 'zcode' || supportsZCodeLive(node))),
    messageOriginAvailable: Boolean(node && supportsHarnessMessageOrigin(node)
      && (session.harness !== 'zcode' || supportsZCodeLive(node))),
    workspaceAvailable: Boolean(session.harness !== 'zcode' && node && supportsHarnessWorkspace(node)),
    attachmentImageLimit: node ? imageLimitForNode(node) : HARNESS_LEGACY_IMAGE_LIMIT,
    native: session.nativeTitle !== null,
    title: session.title || session.nativeTitle || (title.length ? title.slice(0, 48).join('') + (title.length > 48 ? '…' : '') : null),
    pinned: session.pinnedAt !== null, archived: session.archivedAt !== null,
    ...(session.nativePinOrder !== null ? { pinOrder: session.nativePinOrder } : {}),
    ...(organization ? { organization } : {}),
    unread: Boolean(session.threadId && (!session.readAt || session.readAt < session.updatedAt)),
    activity: view?.approvals.length ? 'approval' : view?.turn?.status === 'inProgress' ? 'running' : null,
    locationId: session.locationId, projectName: session.projectName, threadId: session.threadId, epoch: session.epoch,
    status: session.status === 'stored' ? 'ready' : session.status, error: session.error, updatedAt: session.updatedAt,
    startCommandId: session.startCommandId,
    sourceSessionId: session.sourceSessionId, sourceTurnId: session.sourceTurnId,
  };
}
async function load(id: string) {
  const row = await prisma.harnessSession.findUnique({ where: { id } });
  if (!row) throw new DomainError('HARNESS_NOT_FOUND', '会话不存在', 404);
  return row;
}
function requireAvailable(node: AgentNode | null, harness = 'codex') {
  if (!node || !isOnline(node)) throw new DomainError('HARNESS_OFFLINE', '这台电脑当前离线', 409);
  if (!supportsHarness(node, harness)) throw new DomainError('HARNESS_UNSUPPORTED', '电脑尚未启用所选 Harness 会话', 409);
}

export function supportsHarness(node: Pick<AgentNode, 'capabilitiesJson'>, harness = 'codex') {
  return nodeHarnesses(node).some((item) => item === harness);
}

function supportsHarnessMessageOrigin(node: Pick<AgentNode, 'capabilitiesJson'>) {
  try { return JSON.parse(node.capabilitiesJson).harnessMessageOrigin === HARNESS_MESSAGE_ORIGIN_FEATURE; } catch { return false; }
}
function supportsHarnessSettings(node: Pick<AgentNode, 'capabilitiesJson'>) {
  try { return JSON.parse(node.capabilitiesJson).harnessSettings === HARNESS_SETTINGS_FEATURE; }
  catch { return false; }
}
function imageLimitForNode(node: Pick<AgentNode, 'capabilitiesJson'>) {
  const capabilities = storedJson(node.capabilitiesJson) as { harnessLargeImages?: string } | null;
  return capabilities?.harnessLargeImages === HARNESS_LARGE_IMAGES_FEATURE ? HARNESS_IMAGE_FILE_LIMIT : HARNESS_LEGACY_IMAGE_LIMIT;
}

function supportsZCodeLive(node: Pick<AgentNode, 'capabilitiesJson'>) {
  try { return JSON.parse(node.capabilitiesJson).harnessZCodeLive === HARNESS_ZCODE_LIVE_FEATURE; }
  catch { return false; }
}
function supportsZCodeCreate(node: Pick<AgentNode, 'capabilitiesJson'>) {
  try { return JSON.parse(node.capabilitiesJson).harnessZCodeCreate === HARNESS_ZCODE_CREATE_FEATURE && supportsZCodeLive(node); }
  catch { return false; }
}
function supportsHarnessPermissions(node: Pick<AgentNode, 'capabilitiesJson'>) {
  try { return JSON.parse(node.capabilitiesJson).harnessPermissions === HARNESS_PERMISSIONS_FEATURE; }
  catch { return false; }
}
function supportsAdvancedPermissions(node: Pick<AgentNode, 'capabilitiesJson'>) {
  try { return JSON.parse(node.capabilitiesJson).harnessAdvancedPermissions === HARNESS_ADVANCED_PERMISSIONS_FEATURE; }
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
  const { nodeId, locationId, cursor, harness = 'codex' } = harnessCatalogQuerySchema.parse(raw);
  const { cwd } = await projectLocation(prisma, nodeId, locationId);
  const node = await prisma.agentNode.findUnique({ where: { id: nodeId } });
  requireAvailable(node, harness);
  return requestHarnessRead(node, 'catalog', { cwd, cursor: cursor ?? null, ...(harness === 'codex' ? {} : { harness }) });
}

export async function openNativeHarnessThread(raw: unknown) {
  const { nodeId, locationId, threadId, harness = 'codex' } = harnessOpenThreadSchema.parse(raw);
  const original = await projectLocation(prisma, nodeId, locationId);
  const node = await prisma.agentNode.findUnique({ where: { id: nodeId } });
  requireAvailable(node, harness);
  const thread = await requestHarnessRead(node, 'thread', { cwd: original.cwd, threadId, ...(harness === 'codex' ? {} : { harness }) });
  if (thread.threadId !== threadId) throw new DomainError('HARNESS_THREAD_CONFLICT', '原 Codex 线程与绑定不一致', 409);
  return prisma.$transaction(async (tx) => {
    const available = await tx.agentNode.findUnique({ where: { id: nodeId, status: 'active', deletedAt: null } });
    requireAvailable(available, harness);
    if (!available || available.tokenHash !== node?.tokenHash || !supportsHarnessLibrary(available)) {
      throw new DomainError('HARNESS_LIBRARY_UNSUPPORTED', '这台电脑的会话连接已变化，请重试', 409);
    }
    const { cwd, projectName } = await projectLocation(tx, nodeId, locationId);
    if (cwd !== original.cwd) throw new DomainError('HARNESS_LOCATION', '项目位置已变化，请重新选择', 409);
    const where = { nodeId_harness_threadId: { nodeId, harness, threadId } };
    const existing = thread.organization ? await tx.harnessSession.findUnique({ where }) : null;
    const row = await tx.harnessSession.upsert({
      where, update: existing?.cwd === cwd ? nativeOrganizationUpdate(thread.organization, existing) : {},
      create: { nodeId, activeNodeId: nodeId, harness, locationId, cwd, projectName, threadId, library: true,
        nativeTitle: thread.title, startCommandId: randomUUID(), createdAt: new Date().toISOString(), updatedAt: thread.updatedAt,
        ...nativeOrganizationUpdate(thread.organization) },
    });
    return { sessionId: row.id };
  });
}

export async function indexNativeHarnessThreads(raw: unknown) {
  const { nodeId, cursor, harness = 'codex', archived } = harnessIndexQuerySchema.parse(raw);
  const node = await prisma.agentNode.findUnique({ where: { id: nodeId } });
  requireAvailable(node, harness);
  const organization = Boolean(node && supportsHarnessOrganization(node));
  const recheck = organization && !cursor && harness !== 'claude' ? await prisma.harnessSession.findMany({
    where: { nodeId, harness, threadId: { not: null }, OR: [
      { nativePinOrder: { not: null } }, { archivedAt: { not: null }, archivedOverride: null },
    ] },
    orderBy: [{ nativePinOrder: { sort: 'asc', nulls: 'last' } }, { updatedAt: 'desc' }, { id: 'asc' }],
    take: 30, select: { threadId: true },
  }) : [];
  const page = await requestHarnessRead(node, 'index', { cursor: cursor ?? null, ...(harness === 'codex' ? {} : { harness }),
    ...(archived && organization ? { archived: true } : {}),
    ...(recheck.length ? { recheckThreadIds: recheck.flatMap((row) => row.threadId ? [row.threadId] : []) } : {}) });
  await prisma.$transaction(async (tx) => {
    const available = await tx.agentNode.findFirst({ where: { id: nodeId, tokenHash: node?.tokenHash, status: 'active', deletedAt: null } });
    if (!available) throw new DomainError('NODE_REVOKED', '电脑已断开', 409);
    if (page.projectPins) {
      const prior = projectPinsByHarness.safeParse(storedJson(available.harnessProjectPinsJson)).data;
      const pins = JSON.stringify({ ...prior, [harness]: page.projectPins });
      if (pins !== available.harnessProjectPinsJson) await tx.agentNode.update({ where: { id: nodeId }, data: { harnessProjectPinsJson: pins } });
    }
    const locations = new Map<string, { id: string; name: string }>();
    const threads = new Map([...(page.priorityThreads ?? []), ...page.threads].map((thread) => [thread.threadId, thread]));
    for (const thread of threads.values()) {
      const existing = await tx.harnessSession.findUnique({
        where: { nodeId_harness_threadId: { nodeId, harness, threadId: thread.threadId } },
      });
      if (existing) {
        if (existing.cwd === thread.cwd) {
          const update = { ...nativeOrganizationUpdate(thread.organization, existing),
            ...(existing.updatedAt < thread.updatedAt ? { updatedAt: thread.updatedAt, ...(existing.nativeTitle !== null ? { nativeTitle: thread.title } : {}) } : {}) };
          if (Object.keys(update).length) await tx.harnessSession.update({ where: { id: existing.id }, data: update });
        }
        continue;
      }
      let location = locations.get(thread.cwd);
      if (!location) {
        const registered = await tx.projectLocation.findFirst({
          where: { nodeId, path: thread.cwd, status: 'verified', project: { archivedAt: null } }, include: { project: true }, orderBy: { id: 'asc' },
        });
        location = registered ? { id: registered.id, name: registered.project.name } : await tx.harnessDirectory.upsert({
          where: { nodeId_path: { nodeId, path: thread.cwd } }, update: {},
          create: { nodeId, path: thread.cwd, name: thread.name },
        });
        locations.set(thread.cwd, location);
      }
      await tx.harnessSession.create({ data: {
        nodeId, activeNodeId: nodeId, harness, locationId: location.id, cwd: thread.cwd, projectName: location.name, threadId: thread.threadId,
        library: true, status: 'stored', nativeTitle: thread.title, startCommandId: randomUUID(),
        createdAt: thread.updatedAt, updatedAt: thread.updatedAt, readAt: thread.updatedAt,
        ...nativeOrganizationUpdate(thread.organization),
      } });
    }
  }, { timeout: 15_000 });
  return { nextCursor: page.nextCursor };
}

export async function updateHarnessMetadata(id: string, raw: unknown) {
  const change = harnessMetadataSchema.parse(raw);
  await load(id);
  const now = new Date().toISOString();
  await prisma.harnessSession.update({ where: { id }, data: {
    ...(change.title !== undefined ? { title: change.title } : {}),
    ...(change.pinned !== undefined ? { pinnedAt: change.pinned ? now : null, pinnedOverride: change.pinned, nativePinOrder: null } : {}),
    ...(change.archived !== undefined ? { archivedAt: change.archived ? now : null, archivedOverride: change.archived } : {}),
    ...(change.read !== undefined ? { readAt: change.read ? now : null } : {}),
  } });
  return readHarnessSession(id);
}

async function sessionDirectory(row: HarnessSession) {
  let cwd = row.cwd;
  // Earlier releases saved the immutable directory in the creation command.
  if (!cwd) {
    const start = await prisma.harnessCommand.findUnique({ where: { sessionId_commandId: { sessionId: row.id, commandId: row.startCommandId } } });
    if (start) cwd = harnessStartSchema.safeParse(JSON.parse(start.payload)).data?.cwd ?? null;
  }
  if (!cwd) throw new DomainError('HARNESS_LOCATION', '找不到原会话的项目位置', 409);
  return cwd;
}
export async function readHarnessHistory(id: string, raw: unknown) {
  const { cursor } = harnessHistoryQuerySchema.parse(raw);
  const row = await load(id);
  if (!row.threadId || !row.activeNodeId) throw new DomainError('HARNESS_SESSION_STALE', '这条会话尚未连接', 409);
  const cwd = await sessionDirectory(row);
  const node = await prisma.agentNode.findUnique({ where: { id: row.nodeId } });
  requireAvailable(node, row.harness);
  return requestHarnessRead(node, 'history', { cwd, threadId: row.threadId, cursor: cursor ?? null,
    ...(row.harness === 'codex' ? {} : { harness: harnessKind.parse(row.harness) }),
  });
}
export async function readHarnessWorkspaceFiles(id: string, raw: unknown) {
  const query = harnessFilesQuerySchema.parse(raw);
  const row = await load(id);
  if (!row.activeNodeId || !row.library) throw new DomainError('HARNESS_SESSION_STALE', '这条会话尚未连接', 409);
  const cwd = await sessionDirectory(row);
  const node = await prisma.agentNode.findUnique({ where: { id: row.nodeId } });
  return requestHarnessRead(node, 'files', { cwd, ...query });
}
export async function listHarnessSessions(raw: unknown = {}) {
  const { cursor, locationId, archived, harness } = listQuery.parse(raw);
  const nodes = await prisma.agentNode.findMany({ where: { deletedAt: null, status: 'active' } });
  const available = new Map(nodes.map((node) => [node.id, node]));
  const directories = await prisma.harnessDirectory.findMany({ where: { nodeId: { in: [...available.keys()] } }, orderBy: [{ name: 'asc' }, { path: 'asc' }] });
  const registered = locationId ? await prisma.projectLocation.findUnique({ where: { id: locationId }, select: { nodeId: true, path: true } }) : null;
  const location = registered ?? directories.find((directory) => directory.id === locationId);
  const sessions = await prisma.harnessSession.findMany({
    where: {
      ...(harness ? { harness } : {}),
      archivedAt: archived === '1' ? { not: null } : null,
      ...(locationId ? { OR: [{ locationId }, ...(location ? [{ nodeId: location.nodeId, cwd: location.path }] : [])] } : {}),
    },
    orderBy: [{ nativePinOrder: { sort: 'asc', nulls: 'last' } }, { pinnedAt: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), take: 101,
  });
  const hasMore = sessions.length > 100;
  if (hasMore) sessions.pop();
  const prompts = await firstPrompts(sessions);
  return {
    harnesses: [...new Set<HarnessKind>(['codex', ...nodes.flatMap(nodeHarnesses)])].map((id) => ({ id, name: harnessNames[id] })),
    nodes: nodes.map((node) => ({ id: node.id, name: node.name, online: isOnline(node), supportsHarness: supportsHarness(node),
      harnessLibrary: supportsHarnessLibrary(node), harnessWorkspace: supportsHarnessWorkspace(node), harnessOrganization: supportsHarnessOrganization(node),
      harnesses: nodeHarnesses(node), zcodeCreate: supportsZCodeCreate(node), canBrowse: canBrowse(node) })),
    projectPins: harness ? nodes.flatMap((node) => (projectPinsByHarness.safeParse(storedJson(node.harnessProjectPinsJson)).data?.[harness] ?? [])
      .map((pin) => ({ nodeId: node.id, ...pin }))) : [],
    directories: directories.map((dir) => ({ id: dir.id, nodeId: dir.nodeId, path: dir.path, projectName: dir.name, computerName: available.get(dir.nodeId)!.name })),
    sessions: sessions.map((session) => sessionDto(session, available.get(session.nodeId) ?? null, prompts.get(session.id))),
    nextCursor: hasMore ? sessions.at(-1)!.id : null,
  };
}
export async function readHarnessSession(id: string, timeline = false, settings = false, workspace = false, permissions = false, advanced = false) {
  const row = await prisma.harnessSession.findUnique({ where: { id } });
  if (!row) throw new DomainError('HARNESS_NOT_FOUND', '会话不存在', 404);
  const node = await prisma.agentNode.findUnique({ where: { id: row.nodeId } });
  const view = cache.get(id);
  const snapshot = view?.snapshot.epoch === row.epoch ? view.snapshot : null;
  return { ...sessionDto(row, node, (await firstPrompts([row])).get(id)), snapshot: snapshot && harnessSnapshotForClient(snapshot, timeline, settings, workspace, permissions, advanced),
    current: !!view && !view.stale && view.snapshot.epoch === row.epoch };
}
export async function createHarnessSession(body: unknown) {
  const input = harnessCreateSchema.parse(body);
  const harness = input.harness ?? 'codex';
  const result = await prisma.$transaction(async (tx) => {
    const prior = await tx.harnessSession.findUnique({ where: { startCommandId: input.commandId } });
    if (prior) {
      if (prior.nodeId !== input.nodeId || prior.harness !== harness || prior.locationId !== input.locationId) conflict();
      const command = await tx.harnessCommand.findUniqueOrThrow({ where: { sessionId_commandId: { sessionId: prior.id, commandId: input.commandId } } });
      return { sessionId: prior.id, receipt: commandDto(command) };
    }
    const { cwd, projectName } = await projectLocation(tx, input.nodeId, input.locationId);
    const node = await tx.agentNode.findFirst({ where: { id: input.nodeId, status: 'active', deletedAt: null } });
    requireAvailable(node, harness);
    if (harness === 'zcode' && (!node || !supportsZCodeCreate(node))) {
      throw new DomainError('HARNESS_WORKSPACE_UNSUPPORTED', '请更新这台电脑的执行器以新建 ZCode 会话', 409);
    }
    const library = Boolean(node && supportsHarnessLibrary(node));
    if (!library && await tx.harnessSession.findFirst({ where: { activeNodeId: input.nodeId } })) {
      throw new DomainError('HARNESS_ACTIVE', '这台电脑已有会话，请打开原会话', 409);
    }
    const now = new Date();
    const session = await tx.harnessSession.create({ data: {
      nodeId: input.nodeId, activeNodeId: input.nodeId, harness, locationId: input.locationId,
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
  if (result.receipt.status === 'queued') notifyHarnessNode(input.nodeId);
  return result;
}
function conflict(): never { throw new DomainError('HARNESS_COMMAND_CONFLICT', '同一个操作 ID 的内容已变化', 409); }

export async function queueHarnessCommand(id: string, body: unknown, advanced = false) {
  const input = harnessCommandSchema.parse(body);
  const payload = JSON.stringify(input);
  let recipient: string | null = null;
  const receipt = await prisma.$transaction(async (tx) => {
    const prior = await tx.harnessCommand.findUnique({ where: { sessionId_commandId: { sessionId: id, commandId: input.commandId } } });
    if (prior) {
      if (prior.payload !== payload) conflict();
      return commandDto(prior);
    }
    const session = await tx.harnessSession.findUnique({ where: { id } });
    if (!session) throw new DomainError('HARNESS_NOT_FOUND', '会话不存在', 404);
    const node = await tx.agentNode.findUnique({ where: { id: session.nodeId } });
    requireAvailable(node, session.harness);
    const permissions = node && supportsHarnessPermissions(node);
    if ((input.operation === 'choosePermission' && (!permissions || session.harness !== 'zcode'))
        || input.operation === 'configure' && requiresNativePermissionSettings(input.changes) && !permissions) {
      throw new DomainError('HARNESS_WORKSPACE_UNSUPPORTED', '本机不支持这个会话操作', 409);
    }
    if (session.harness === 'zcode') {
      const keys = input.operation === 'configure' ? Object.keys(input.changes) : [];
      const configure = input.operation === 'configure' && keys.length <= 1
        && keys.every((key) => key === 'model' || permissions && (key === 'mode' || key === 'permissionMode'));
      const liveOperation = configure || input.operation === 'choosePermission';
      if (requiresHarnessWorkspace(input)
          || (liveOperation || 'expectedSettingsRevision' in input) && (!node || !supportsZCodeLive(node))
          || !liveOperation && input.operation !== 'send' && input.operation !== 'interrupt') {
        throw new DomainError('HARNESS_WORKSPACE_UNSUPPORTED', '本机不支持这个会话操作', 409);
      }
    }
    if (requiresHarnessWorkspace(input) && (!node || !supportsHarnessWorkspace(node))) {
      throw new DomainError('HARNESS_WORKSPACE_UNSUPPORTED', '请更新这台电脑的执行器以使用这个会话功能', 409);
    }
    if (node && 'attachments' in input && input.attachments?.some((file) =>
      file.kind === 'imageFile' && imageAttachmentBytes(file.content) > imageLimitForNode(node))) {
      throw new DomainError('HARNESS_IMAGE_LIMIT', '请更新这台电脑的执行器以发送大图', 409);
    }
    const view = cache.get(id);
    if (!session.activeNodeId || (session.library && (!node || !supportsHarnessLibrary(node)))
        || session.status !== 'ready' || session.epoch !== input.expectedEpoch || !view || view.stale || view.snapshot.epoch !== session.epoch) {
      throw new DomainError('HARNESS_SESSION_STALE', '会话正在恢复，请刷新后重试', 409);
    }
    const startsWork = ['send', 'steer', 'rerun', 'approvePlan', 'enqueue', 'sendQueuedNow'].includes(input.operation);
    const queuedSettings = input.operation === 'sendQueuedNow' ? view.snapshot.view.queue?.items.find((item) => item.id === input.itemId)?.settings : undefined;
    if ((input.operation === 'configure' && requiresAdvancedPermissions(input.changes)
        || startsWork && (requiresAdvancedPermissions(view.snapshot.view.settings) || requiresAdvancedPermissions(queuedSettings)))
        && (!advanced || !node || !supportsAdvancedPermissions(node))) {
      throw new DomainError('HARNESS_ADVANCED_PERMISSIONS_UNSUPPORTED', '此权限模式需要新版页面和电脑执行器，请刷新后重试', 409);
    }
    if ('expectedSettingsRevision' in input) {
      if (!node || !supportsHarnessSettings(node)) throw new DomainError('HARNESS_SETTINGS_UNSUPPORTED', '本机执行器暂不支持会话设置', 409);
      if (view.snapshot.view.settings?.revision !== input.expectedSettingsRevision) {
        throw new DomainError('HARNESS_SETTINGS_STALE', '会话设置已变更，请刷新后重试', 409);
      }
    }
    if ('expectedQueueRevision' in input && input.expectedQueueRevision !== view.snapshot.view.queue?.revision) {
      throw new DomainError('HARNESS_QUEUE_STALE', '消息队列已变化，请刷新后重试', 409);
    }
    if (input.operation === 'choosePermission' && !view.snapshot.view.approvals.some((approval) =>
      approval.id === input.requestId && approval.options?.some((option) => option.id === input.optionId))) {
      throw new DomainError('HARNESS_PERMISSION_STALE', '这条权限请求已处理或决定无效', 409);
    }
    const now = new Date();
    recipient = session.activeNodeId;
    return commandDto(await tx.harnessCommand.create({ data: {
      sessionId: id, commandId: input.commandId, payload, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresAfter).toISOString(),
    } }));
  });
  if (recipient) notifyHarnessNode(recipient);
  return receipt;
}
export async function readHarnessReceipt(sessionId: string, commandId: string) {
  const row = await prisma.harnessCommand.findUnique({ where: { sessionId_commandId: { sessionId, commandId } }, select: receiptFields });
  if (!row) throw new DomainError('HARNESS_COMMAND_NOT_FOUND', '未找到这次操作', 404);
  if (row.status === 'queued' && Date.parse(row.expiresAt) <= Date.now()) {
    await expireQueued(sessionId);
    return commandDto(await prisma.harnessCommand.findUniqueOrThrow({ where: { sessionId_commandId: { sessionId, commandId } }, select: receiptFields }));
  }
  return commandDto(row);
}

async function expireQueued(sessionId: string) {
  const at = new Date().toISOString();
  const expired = await prisma.$transaction(async (tx) => {
    const rows = await tx.harnessCommand.findMany({ where: { sessionId, status: 'queued', expiresAt: { lte: at } }, select: receiptFields });
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
  const assignment = await dispatchHarness(session.id, nodeId, tokenHash, false, leaseCommandBytes);
  if (!assignment) return;
  const { library: _library, nativeCwd: _cwd, harness: _harness, ...lease } = assignment.lease;
  return lease;
}

export async function leaseHarnessLibrary(nodeId: string, tokenHash: string): Promise<HarnessLibraryLease[]> {
  const rows = await prisma.harnessSession.findMany({
    where: { activeNodeId: nodeId, OR: [
      { commands: { some: { status: { in: ['queued', 'dispatched'] } } } },
      { status: 'creating', threadId: { not: null } },
      { hasQueuedInput: true },
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
  let remainingBytes = leaseCommandBytes;
  for (const row of rows) {
    const assignment = await dispatchHarness(row.id, nodeId, tokenHash, true, remainingBytes);
    if (!assignment) continue;
    remainingBytes -= assignment.bytes;
    leases.push(assignment.lease);
  }
  return leases;
}

async function dispatchHarness(id: string, nodeId: string, tokenHash: string, library: boolean, byteBudget: number):
  Promise<{ lease: HarnessLibraryLease; bytes: number } | undefined> {
  await expireQueued(id);
  return prisma.$transaction(async (tx) => {
    const node = await tx.agentNode.findUnique({ where: { id: nodeId } });
    const row = await tx.harnessSession.findUnique({ where: { id, activeNodeId: nodeId } });
    if (!node || node.status !== 'active' || node.deletedAt || node.tokenHash !== tokenHash || !row || !supportsHarness(node, row.harness)
        || (library ? !supportsHarnessLibrary(node) : row.library)) return;
    const dispatchTime = new Date().toISOString();
    // Old executors parse the whole lease strictly, including commands left by a newer executor.
    const excluded: Prisma.HarnessCommandWhereInput[] = [];
    if (!supportsAdvancedPermissions(node)) {
      excluded.push({ payload: { contains: '"permission":"fullAccess"' } },
        { payload: { contains: '"permissionMode":"auto"' } }, { payload: { contains: '"permissionMode":"bypassPermissions"' } });
    }
    if (!supportsHarnessPermissions(node)) {
      excluded.push({ payload: { contains: '"operation":"choosePermission"' } },
        { payload: { contains: '"permissionMode":' } }, { payload: { contains: '"approvalPolicy":' } });
      if (row.harness === 'zcode') excluded.push({ payload: { contains: '"mode":' } });
    }
    if (!supportsHarnessSettings(node)) excluded.push({ payload: { contains: '"operation":"configure"' } }, { payload: { contains: '"expectedSettingsRevision":' } });
    if (!supportsHarnessWorkspace(node)) excluded.push({ payload: { contains: '"attachments":' } }, { payload: { contains: '"decision":"acceptForSession"' } },
      { payload: { contains: '"decision":"cancel"' } },
      ...HARNESS_WORKSPACE_OPERATIONS.map((operation) => ({ payload: { contains: '"operation":"' + operation + '"' } })));
    const candidates = await tx.harnessCommand.findMany({
      where: { NOT: excluded, sessionId: row.id, OR: [{ status: 'dispatched' }, { status: 'queued', expiresAt: { gt: dispatchTime } }] },
      orderBy: [{ createdAt: 'asc' }, { commandId: 'asc' }], take: 16, select: { commandId: true },
    });
    const ids: string[] = [];
    let bytes = 0;
    if (candidates.length && byteBudget > 0) {
      // Read sizes before loading payloads so an image backlog cannot fill one poll response.
      const sizes = await tx.$queryRaw<Array<{ commandId: string; bytes: bigint | number }>>`
        SELECT "commandId", length(CAST("payload" AS BLOB)) AS "bytes" FROM "harness_commands"
        WHERE "sessionId" = ${row.id} AND "commandId" IN (${Prisma.join(candidates.map(({ commandId }) => commandId))})
        ${imageLimitForNode(node) === HARNESS_LEGACY_IMAGE_LIMIT ? Prisma.sql`
          AND NOT EXISTS (
            SELECT 1 FROM json_each("payload", '$.attachments') AS attachment
            WHERE json_extract(attachment.value, '$.kind') = 'imageFile'
              AND length(json_extract(attachment.value, '$.content')) > ${legacyImageEncodedLimit}
          )` : Prisma.empty}
      `;
      const sizesById = new Map(sizes.map((item) => [item.commandId, Number(item.bytes)]));
      for (const { commandId } of candidates) {
        const size = sizesById.get(commandId);
        if (size === undefined) continue;
        if (bytes + size > byteBudget) break;
        bytes += size;
        ids.push(commandId);
      }
    }
    const commands = ids.length ? await tx.harnessCommand.findMany({
      where: { sessionId: row.id, commandId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { commandId: 'asc' }],
      select: { sessionId: true, expiresAt: true, payload: true },
    }) : [];
    if (ids.length) await tx.harnessCommand.updateMany({
      where: { sessionId: row.id, commandId: { in: ids }, status: 'queued' },
      data: { status: 'dispatched', dispatchedAt: dispatchTime },
    });
    return { bytes, lease: {
      sessionId: row.id, threadId: row.threadId, epoch: row.epoch,
      snapshotRequested: row.status === 'unavailable' || refresh.has(row.id) || !cache.has(row.id),
      commands: commands.map(({ sessionId, expiresAt, payload }) => ({ sessionId, expiresAt, command: JSON.parse(payload) as HarnessDelivery['command'] })),
      library: row.library,
      ...(row.harness === 'codex' ? {} : { harness: harnessKind.parse(row.harness) }),
      ...(row.epoch === 0 && row.threadId && row.cwd && row.nativeTitle !== null ? { nativeCwd: row.cwd } : {}),
    } };
  });
}

async function saveReceipt(session: HarnessSession, input: HarnessReceipt) {
  const record = await prisma.$transaction(async (tx) => {
    const current = await tx.harnessCommand.findUnique({ where: { sessionId_commandId: { sessionId: session.id, commandId: input.commandId } } });
    if (!current) throw new DomainError('HARNESS_COMMAND_NOT_FOUND', '未找到这次操作', 404);
    if (current.status !== 'dispatched' && !(current.status === 'unknown' && input.status === 'accepted')) return current;
    const at = new Date().toISOString();
    const action = readStoredCommand(current.payload);
    let resultSessionId: string | undefined;
    if (input.status === 'accepted' && action?.operation === 'fork') {
      if (!input.forkedThreadId || input.forkedThreadId === session.threadId || !session.cwd) {
        throw new DomainError('HARNESS_FORK_INVALID', '没有收到原会话的有效分支', 409);
      }
      const child = await tx.harnessSession.upsert({
        where: { nodeId_harness_threadId: { nodeId: session.nodeId, harness: session.harness, threadId: input.forkedThreadId } },
        create: {
          nodeId: session.nodeId, activeNodeId: session.activeNodeId, harness: session.harness, locationId: session.locationId,
          projectName: session.projectName, cwd: session.cwd, library: true, status: 'stored', threadId: input.forkedThreadId,
          nativeTitle: session.title ?? session.nativeTitle ?? '会话分支', startCommandId: randomUUID(), sourceSessionId: session.id,
          sourceTurnId: action.turnId, createdAt: at, updatedAt: at,
        },
        update: { sourceSessionId: session.id, sourceTurnId: action.turnId },
      });
      resultSessionId = child.id;
    }
    const updated = await tx.harnessCommand.update({
      where: { sessionId_commandId: { sessionId: session.id, commandId: input.commandId } },
      data: { status: input.status, error: input.error ?? null, resultSessionId },
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
      if (action?.operation === 'send' || action?.operation === 'steer' || action?.operation === 'rerun') {
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
  if (row.nodeId !== node.id || !supportsHarness(node, row.harness) || (row.library && !supportsHarnessLibrary(node))
      || (row.activeNodeId !== node.id && input.type !== 'receipt')) {
    throw new DomainError('HARNESS_NODE_SCOPE', '这台电脑没有会话权限', 403);
  }
  if (input.type === 'receipt') { await saveReceipt(row, input); return {}; }
  if (input.epoch < row.epoch) return {};
  if (input.type === 'unavailable') {
    if (input.epoch !== row.epoch) return {};
    await prisma.harnessSession.updateMany({
      where: { id, epoch: input.epoch },
      data: { status: 'unavailable', error: input.error },
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
      data: { threadId: input.threadId, epoch: input.epoch, status: 'ready', error: null,
        ...(input.view.queue ? { hasQueuedInput: input.view.queue.items.some((item, index) => index === 0 && item.status !== 'blocked') } : {}),
        ...(!row.threadId ? { updatedAt: new Date().toISOString() } : {}) },
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
  if (upcoming.some((frame) => frame.event.kind === 'queue')) {
    const status = current.snapshot.view.queue?.items[0]?.status;
    await prisma.harnessSession.updateMany({ where: { id, epoch: input.epoch }, data: { hasQueuedInput: status === 'queued' || status === 'starting' } });
  }
  if (upcoming.some((frame) => frame.event.kind === 'turn')) {
    const now = new Date().toISOString();
    await prisma.harnessSession.updateMany({ where: { id, epoch: input.epoch, updatedAt: { lt: now } }, data: { updatedAt: now } });
  }
  return { seq: current.snapshot.seq };
}

export function subscribeHarness(id: string, after: { epoch: number; seq: number } | null, emit: (event: StreamEvent) => void,
  timeline = false, library = false, settings = false, workspace = false, permissions = false, advanced = false) {
  let cursor = after;
  const projectEvent = (event: HarnessEvent) => harnessEventForClient(event, timeline, settings, workspace, permissions, advanced);
  const send = (frame: StreamEvent) => {
    if (frame.type === 'snapshot') {
      cursor = frame;
      emit(harnessSnapshotForClient(frame, timeline, settings, workspace, permissions, advanced));
      return;
    }
    if (frame.type === 'event') {
      const event = projectEvent(frame.event);
      if (!event) {
        if (frame.event.kind === 'settings' && settings && requiresAdvancedPermissions(frame.event.settings)) {
          const snapshot = cache.get(id)?.snapshot;
          if (snapshot) send(snapshot);
        }
        return;
      }
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
