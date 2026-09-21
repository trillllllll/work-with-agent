import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { recordChange, type MutationContext } from './workspace-store.js';
import { assertOwner, assertTopicAccess, type Actor } from './security.js';
import { registerCommandHandler, registerEvidenceValidator, type Command } from './commands.js';
import { registerUndoHandler, type UndoRecord } from './undo-registry.js';
import { jsonSchema } from './command-catalog.js';

export type KnowledgeDb = Prisma.TransactionClient;
export const knowledgeNow = () => new Date().toISOString();
export const evidenceSchema = z.object({ type: z.enum(['material', 'memory', 'task']), id: z.string().min(1), revision: z.number().int().positive(), hash: z.string().optional() }).strict();
export type EvidenceRef = z.infer<typeof evidenceSchema>;
export type KnowledgeSource = EvidenceRef & { title: string; content: string };
export type KnowledgeSnapshot = { topicId: string | null; sources: KnowledgeSource[]; capturedAt: string; truncated: boolean };
const titleSchema = z.string().trim().min(1).max(300);
const contentSchema = z.string().max(500_000);
const attachmentLimit = 8 * 1024 * 1024;
const materialSchema = z.object({
  topicId: z.string().min(1).nullable().default(null), taskId: z.string().min(1).nullable().optional(),
  kind: z.enum(['text', 'markdown', 'link', 'thread', 'attachment']).default('text'), title: titleSchema,
  content: contentSchema.default(''), uri: z.string().max(4000).nullable().optional(), metadata: z.record(z.unknown()).default({}),
  attachmentBase64: z.string().max(Math.ceil(attachmentLimit / 3) * 4).optional(), fileName: z.string().min(1).max(255).optional(), mimeType: z.string().max(150).optional(),
}).strict();
const materialUpdateSchema = materialSchema.omit({ topicId: true, taskId: true, kind: true }).partial().extend({ reason: z.string().max(1000).optional() }).strict();
const memorySchema = z.object({ topicId: z.string().min(1).nullable().default(null), kind: z.enum(['fact', 'decision', 'constraint', 'learning', 'question']).default('fact'), title: titleSchema, content: contentSchema.min(1), evidence: z.array(evidenceSchema).max(100).default([]), reason: z.string().trim().min(1).max(1000).default('人工记录') }).strict();
const memoryUpdateSchema = memorySchema.omit({ topicId: true }).partial().extend({ status: z.enum(['active', 'retired', 'superseded']).optional(), reason: z.string().trim().min(1).max(1000).default('修订记忆') }).strict();
export const knowledgeFailure = (code: string, message: string, status = 409) => new DomainError(code, message, status);
export const knowledgeHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const parseJson = <T>(value: string, fallback: T): T => { try { return JSON.parse(value) as T; } catch { return fallback; } };
export function readEvidence(value: string): EvidenceRef[] { return parseJson(value, []); }

export async function checkKnowledgeScope(tx: KnowledgeDb, actor: Actor, topicId: string | null, write = false) {
  assertTopicAccess(actor, topicId);
  if (topicId) {
    const topic = await tx.topic.findUnique({ where: { id: topicId } });
    if (!topic) throw knowledgeFailure('NOT_FOUND', '清单不存在', 404);
    if (write && topic.archivedAt) throw knowledgeFailure('TOPIC_ARCHIVED', '已归档清单的资料不能修改');
    return topic;
  }
  return null;
}
function assertRevision(actual: number, expected: number | undefined) {
  if (!Number.isInteger(expected) || actual !== expected) throw knowledgeFailure('VERSION_CONFLICT', '内容已经变化，请刷新后重试');
}
function materialBytes(value?: string) {
  if (value === undefined) return undefined;
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw knowledgeFailure('INVALID_ATTACHMENT', '附件必须是有效 Base64', 400);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength > attachmentLimit) throw knowledgeFailure('ATTACHMENT_TOO_LARGE', '附件不能超过 8 MiB', 413);
  return bytes;
}
function validateMaterialInput(input: z.infer<typeof materialSchema>) {
  if (JSON.stringify(input.metadata).length > 32_000) throw knowledgeFailure('INVALID_METADATA', '材料元信息过长', 400);
  if (input.uri) {
    try { if (!['https:', 'http:'].includes(new URL(input.uri).protocol)) throw new Error(); }
    catch { throw knowledgeFailure('INVALID_URI', '材料链接须为 HTTP(S) 地址', 400); }
  }
  if (input.kind === 'link' && !input.uri) throw knowledgeFailure('INVALID_URI', '链接材料需要原始网址', 400);
  if (input.kind === 'thread') {
    if (!['full', 'excerpt', 'summary'].includes(String(input.metadata.completeness))) throw knowledgeFailure('THREAD_COMPLETENESS_REQUIRED', '会话必须标明完整记录、片段或摘要', 400);
    if (!input.content.trim()) throw knowledgeFailure('INVALID_CONTENT', '会话内容不能为空', 400);
  }
  if (input.kind === 'attachment' && !input.attachmentBase64) throw knowledgeFailure('ATTACHMENT_REQUIRED', '请选择需要保存的附件', 400);
  materialBytes(input.attachmentBase64);
}
export function knowledgeStorageRoot() { return resolve(process.env.KNOWLEDGE_STORAGE_ROOT || fileURLToPath(new URL('../../data/knowledge-blobs', import.meta.url))); }
async function storeAttachment(bytes: Uint8Array) {
  const hash = knowledgeHash(bytes);
  const root = knowledgeStorageRoot();
  await mkdir(root, { recursive: true });
  const destination = resolve(root, hash);
  try { if (knowledgeHash(await readFile(destination)) === hash) return hash; } catch { /* New immutable blob. */ }
  const temporary = resolve(root, `.${hash}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: 'wx' });
  try { await rename(temporary, destination); }
  catch (error) {
    // Concurrent identical uploads can win the rename; never remove the shared blob.
    try { if (knowledgeHash(await readFile(destination)) !== hash) throw error; }
    finally { await unlink(temporary).catch(() => {}); }
  }
  return hash;
}
function publicVersion<T extends { attachmentPath: string | null }>(row: T) {
  const { attachmentPath, ...rest } = row;
  return { ...rest, hasAttachment: Boolean(attachmentPath) };
}

export async function knowledgeSource(tx: KnowledgeDb, actor: Actor, ref: Pick<EvidenceRef, 'type' | 'id'>): Promise<KnowledgeSource & { topicId: string | null; unavailable?: boolean }> {
  if (ref.type === 'material') {
    const material = await tx.material.findUnique({ where: { id: ref.id } });
    if (!material) throw knowledgeFailure('NOT_FOUND', '来源材料不存在', 404);
    await checkKnowledgeScope(tx, actor, material.topicId);
    const version = await tx.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: material.id, revision: material.revision } } });
    return { type: 'material', id: material.id, topicId: material.topicId, revision: material.revision, hash: version.contentHash, title: material.title, content: version.content, unavailable: Boolean(material.archivedAt) };
  }
  if (ref.type === 'memory') {
    const memory = await tx.memory.findUnique({ where: { id: ref.id } });
    if (!memory) throw knowledgeFailure('NOT_FOUND', '来源记忆不存在', 404);
    await checkKnowledgeScope(tx, actor, memory.topicId);
    return { type: 'memory', id: memory.id, topicId: memory.topicId, revision: memory.revision, hash: knowledgeHash(memory.content), title: memory.title, content: memory.content, unavailable: memory.status !== 'active' };
  }
  const task = await tx.task.findUnique({ where: { id: ref.id } });
  if (!task) throw knowledgeFailure('NOT_FOUND', '来源任务不存在', 404);
  await checkKnowledgeScope(tx, actor, task.topicId);
  const content = JSON.stringify({ title: task.title, description: task.description, status: task.status, dueDate: task.dueDate, resultSummary: task.resultSummary });
  return { type: 'task', id: task.id, topicId: task.topicId, revision: task.revision, hash: knowledgeHash(content), title: task.title, content, unavailable: Boolean(task.deletedAt) };
}

/** Called both at proposal creation and inside the final confirmation transaction. */
export async function validateKnowledgeEvidence(tx: KnowledgeDb, actor: Actor, refs: EvidenceRef[], topicId?: string | null) {
  const rows = [];
  for (const ref of refs) {
    const current = await knowledgeSource(tx, actor, ref);
    if (topicId !== undefined && current.topicId !== topicId) throw knowledgeFailure('SOURCE_SCOPE_MISMATCH', '证据必须属于同一项目', 403);
    if (current.unavailable || current.revision !== ref.revision || (ref.hash && current.hash !== ref.hash)) throw knowledgeFailure('SOURCE_STALE', '来源已变化或不可用，请重新核对后提交');
    if (ref.type === 'memory') {
      const memory = await tx.memory.findUniqueOrThrow({ where: { id: ref.id } });
      if (await evidenceHealth(tx, actor, readEvidence(memory.evidence), new Set([ref.id])) !== 'current') throw knowledgeFailure('SOURCE_STALE', '引用的记忆需要复核');
    }
    rows.push({ type: current.type, id: current.id, revision: current.revision, hash: current.hash, topicId: current.topicId });
  }
  return rows.sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
}

async function evidenceHealth(tx: KnowledgeDb, actor: Actor, evidence: EvidenceRef[], seen = new Set<string>()): Promise<string> {
  for (const ref of evidence) {
    try {
      const source = await knowledgeSource(tx, actor, ref);
      if (source.unavailable || source.revision !== ref.revision || (ref.hash && source.hash !== ref.hash)) return 'needs_review';
      if (ref.type === 'memory') {
        if (seen.has(ref.id) || seen.size > 32) return 'needs_review';
        const memory = await tx.memory.findUniqueOrThrow({ where: { id: ref.id } });
        const nested = await evidenceHealth(tx, actor, readEvidence(memory.evidence), new Set([...seen, ref.id]));
        if (nested !== 'current') return nested;
      }
    } catch { return 'source_unavailable'; }
  }
  return 'current';
}

export async function takeKnowledgeSnapshot(actor: Actor, input: { topicId: string | null; materialIds?: string[]; memoryIds?: string[]; taskIds?: string[] }, tx: KnowledgeDb = prisma): Promise<KnowledgeSnapshot> {
  const topic = await checkKnowledgeScope(tx, actor, input.topicId);
  if (topic?.archivedAt) throw knowledgeFailure('TOPIC_ARCHIVED', '已归档清单不参与上下文装配');
  const selectIds = async (type: 'material' | 'memory' | 'task', explicit?: string[]) => {
    if (explicit) { if (explicit.length > 100) throw knowledgeFailure('TOO_MANY_SOURCES', '每类最多选择 100 个来源', 400); return [...new Set(explicit)]; }
    if (type === 'material') return (await tx.material.findMany({ where: { topicId: input.topicId, archivedAt: null }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 41 })).map((row) => row.id);
    if (type === 'memory') return (await tx.memory.findMany({ where: { topicId: input.topicId, status: 'active' }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 41 })).map((row) => row.id);
    return (await tx.task.findMany({ where: { topicId: input.topicId, deletedAt: null }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 41 })).map((row) => row.id);
  };
  const sources: KnowledgeSource[] = [];
  let truncated = false;
  let remaining = 100_000;
  for (const [type, requested] of [['material', input.materialIds], ['memory', input.memoryIds], ['task', input.taskIds]] as const) {
    const ids = await selectIds(type, requested);
    const limit = requested ? 100 : 40;
    truncated ||= ids.length > limit;
    for (const id of ids.slice(0, limit)) {
      if (sources.length >= 120) { truncated = true; break; }
      const source = await knowledgeSource(tx, actor, { type, id });
      if (source.topicId !== input.topicId) throw knowledgeFailure('SOURCE_SCOPE_MISMATCH', '选择的来源不属于当前清单', 403);
      if (source.unavailable) { if (requested) throw knowledgeFailure('SOURCE_UNAVAILABLE', '选择的来源已归档或失效'); continue; }
      if (type === 'memory') {
        const memory = await tx.memory.findUniqueOrThrow({ where: { id } });
        if (await evidenceHealth(tx, actor, readEvidence(memory.evidence)) !== 'current') { if (requested) throw knowledgeFailure('SOURCE_STALE', '选择的记忆需要复核'); continue; }
      }
      if (remaining <= 0) { truncated = true; continue; }
      const content = source.content.slice(0, Math.min(12_000, remaining));
      truncated ||= content.length !== source.content.length;
      remaining -= content.length;
      sources.push({ type, id, revision: source.revision, hash: source.hash, title: source.title, content });
    }
  }
  return { topicId: input.topicId, sources, capturedAt: knowledgeNow(), truncated };
}

async function inspectKnowledgeCommand(tx: KnowledgeDb, actor: Actor, command: Command) {
  const input = command.input;
  if (command.kind === 'material.create') {
    const data = materialSchema.parse(input);
    validateMaterialInput(data);
    const topic = await checkKnowledgeScope(tx, actor, data.topicId, true);
    let task: { id: string; revision: number } | null = null;
    if (data.taskId) { const source = await knowledgeSource(tx, actor, { type: 'task', id: data.taskId }); if (source.topicId !== data.topicId || source.unavailable) throw knowledgeFailure('SOURCE_SCOPE_MISMATCH', '关联任务不属于当前清单', 403); task = { id: source.id, revision: source.revision }; }
    return { preconditions: { topic: topic ? { id: topic.id, revision: topic.revision } : null, task }, preview: { kind: command.kind, title: data.title, topicId: data.topicId, hasAttachment: Boolean(data.attachmentBase64) } };
  }
  if (command.kind.startsWith('material.')) {
    const material = await tx.material.findUnique({ where: { id: command.targetId } });
    if (!material) throw knowledgeFailure('NOT_FOUND', '材料不存在', 404);
    const topic = await checkKnowledgeScope(tx, actor, material.topicId, true);
    assertRevision(material.revision, command.expectedRevision);
    if (command.kind === 'material.update') {
      const data = materialUpdateSchema.parse(input);
      const version = await tx.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: material.id, revision: material.revision } } });
      validateMaterialInput({ topicId: material.topicId, kind: material.kind as z.infer<typeof materialSchema>['kind'], title: data.title ?? material.title, content: data.content ?? version.content, uri: data.uri === undefined ? material.uri : data.uri, metadata: data.metadata ?? parseJson(version.metadata, {}), attachmentBase64: data.attachmentBase64 ?? (material.kind === 'attachment' ? 'AA==' : undefined), fileName: data.fileName, mimeType: data.mimeType });
    } else z.object({ archived: z.boolean() }).strict().parse(input);
    return { preconditions: { materialId: material.id, revision: material.revision, topicRevision: topic?.revision ?? null }, preview: { kind: command.kind, title: material.title, changes: Object.keys(input).filter((key) => key !== 'attachmentBase64') } };
  }
  const isCreate = command.kind === 'memory.create';
  const existing = isCreate ? null : await tx.memory.findUnique({ where: { id: command.targetId } });
  if (!isCreate && !existing) throw knowledgeFailure('NOT_FOUND', '记忆不存在', 404);
  if (existing) assertRevision(existing.revision, command.expectedRevision);
  const data = isCreate ? memorySchema.parse(input) : memoryUpdateSchema.parse(command.kind === 'memory.retire' ? { ...input, status: 'retired' } : input);
  const topicId = existing?.topicId ?? ('topicId' in data ? data.topicId : null);
  const topic = await checkKnowledgeScope(tx, actor, topicId, true);
  const evidence = data.evidence ?? (existing ? readEvidence(existing.evidence) : []);
  if (actor.kind !== 'user' && evidence.length === 0) throw knowledgeFailure('EVIDENCE_REQUIRED', 'AI 记忆候选必须引用原始来源', 400);
  if (evidence.some((ref) => ref.type === 'memory' && ref.id === existing?.id)) throw knowledgeFailure('CYCLIC_EVIDENCE', '记忆不能引用自身作为依据', 400);
  // A retirement preserves its historical references even if a source is no longer available.
  const evidenceState = command.kind === 'memory.retire' ? [] : await validateKnowledgeEvidence(tx, actor, evidence, topicId);
  return { preconditions: { memoryId: existing?.id ?? null, revision: existing?.revision ?? null, topicRevision: topic?.revision ?? null, evidence: evidenceState }, preview: { kind: command.kind, title: data.title ?? existing?.title, content: data.content ?? existing?.content, evidence, reason: data.reason } };
}

async function executeKnowledgeCommand(tx: KnowledgeDb, actor: Actor, command: Command, context: MutationContext) {
  await inspectKnowledgeCommand(tx, actor, command);
  const timestamp = knowledgeNow();
  if (command.kind === 'material.create' || command.kind === 'material.update') {
    const existing = command.kind === 'material.update' ? await tx.material.findUniqueOrThrow({ where: { id: command.targetId } }) : null;
    const previous = existing ? await tx.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: existing.id, revision: existing.revision } } }) : null;
    const data = existing ? materialUpdateSchema.parse(command.input) : materialSchema.parse(command.input);
    const bytes = materialBytes(data.attachmentBase64);
    const attachmentPath = bytes ? context.preview ? knowledgeHash(bytes) : await storeAttachment(bytes) : previous?.attachmentPath ?? null;
    const content = data.content ?? previous?.content ?? '';
    const contentHash = knowledgeHash(`${content}\0${attachmentPath ?? ''}`);
    const material = existing ? await tx.material.update({ where: { id: existing.id, revision: command.expectedRevision }, data: { title: data.title ?? existing.title, ...(data.uri !== undefined ? { uri: data.uri } : {}), revision: { increment: 1 }, updatedAt: timestamp } }) : await tx.material.create({ data: { id: context.entityId ?? command.entityId, topicId: 'topicId' in data ? data.topicId : null, taskId: 'taskId' in data ? data.taskId : null, kind: 'kind' in data ? data.kind : 'text', title: data.title!, uri: data.uri, createdAt: timestamp, updatedAt: timestamp } });
    await tx.materialVersion.create({ data: { materialId: material.id, revision: material.revision, content, contentHash, metadata: JSON.stringify(data.metadata ?? (previous ? parseJson(previous.metadata, {}) : {})), attachmentPath, fileName: data.fileName ?? previous?.fileName, mimeType: data.mimeType ?? previous?.mimeType, createdAt: timestamp } });
    await recordChange(tx, 'material', material.id, existing ? 'update' : 'create', existing, { ...material, contentHash }, context);
    return { ...material, content, contentHash, hasAttachment: Boolean(attachmentPath) };
  }
  if (command.kind === 'material.archive') {
    const before = await tx.material.findUniqueOrThrow({ where: { id: command.targetId } });
    const data = z.object({ archived: z.boolean() }).parse(command.input);
    const result = await tx.material.update({ where: { id: before.id, revision: command.expectedRevision }, data: { archivedAt: data.archived ? timestamp : null, revision: { increment: 1 }, updatedAt: timestamp } });
    const latest = await tx.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: before.id, revision: before.revision } } });
    const { id: _id, ...version } = latest;
    await tx.materialVersion.create({ data: { ...version, revision: result.revision, createdAt: timestamp } });
    await recordChange(tx, 'material', before.id, data.archived ? 'archive' : 'restore', before, result, context);
    return result;
  }
  const existing = command.kind !== 'memory.create' ? await tx.memory.findUniqueOrThrow({ where: { id: command.targetId } }) : null;
  const data = existing ? memoryUpdateSchema.parse(command.kind === 'memory.retire' ? { ...command.input, status: 'retired' } : command.input) : memorySchema.parse(command.input);
  const evidence = data.evidence ?? (existing ? readEvidence(existing.evidence) : []);
  const memory = existing ? await tx.memory.update({ where: { id: existing.id, revision: command.expectedRevision }, data: { ...(data.title !== undefined ? { title: data.title } : {}), ...(data.content !== undefined ? { content: data.content } : {}), ...(data.kind !== undefined ? { kind: data.kind } : {}), ...('status' in data && data.status ? { status: data.status } : {}), evidence: JSON.stringify(evidence), health: 'current', revision: { increment: 1 }, updatedAt: timestamp } }) : await tx.memory.create({ data: { id: context.entityId ?? command.entityId, topicId: 'topicId' in data ? data.topicId : null, title: data.title!, content: data.content!, kind: data.kind!, evidence: JSON.stringify(evidence), createdAt: timestamp, updatedAt: timestamp } });
  await tx.memoryVersion.create({ data: { memoryId: memory.id, revision: memory.revision, title: memory.title, content: memory.content, kind: memory.kind, status: memory.status, health: memory.health, evidence: memory.evidence, reason: data.reason, createdAt: timestamp } });
  await recordChange(tx, 'memory', memory.id, existing ? 'update' : 'create', existing, memory, context);
  return { ...memory, evidence };
}

export function registerKnowledgeCommands() {
  const schemas = { 'material.create': materialSchema, 'material.update': materialUpdateSchema, 'material.archive': z.object({ archived: z.boolean() }).strict(), 'memory.create': memorySchema, 'memory.update': memoryUpdateSchema, 'memory.retire': memoryUpdateSchema };
  for (const [kind, schema] of Object.entries(schemas)) registerCommandHandler(kind, { inspect: inspectKnowledgeCommand, execute: executeKnowledgeCommand, forceProposal: true, inputSchema: jsonSchema(schema) });
  registerEvidenceValidator(validateKnowledgeEvidence);
  registerUndoHandler('material', undoKnowledgeChange);
  registerUndoHandler('memory', undoKnowledgeChange);
}

export async function undoKnowledgeChange(tx: KnowledgeDb, actor: Actor, record: UndoRecord, _context: MutationContext) {
  assertOwner(actor);
  const before = record.beforeSnapshot ? JSON.parse(record.beforeSnapshot) : null;
  const after = record.afterSnapshot ? JSON.parse(record.afterSnapshot) : null;
  if (!after) throw knowledgeFailure('UNDO_CONFLICT', '缺少可验证的知识版本');
  const dependents = await tx.memory.findMany({ where: { status: 'active', id: { not: record.entityId } }, select: { evidence: true } });
  if (dependents.some((row) => readEvidence(row.evidence).some((ref) => ref.type === record.entityType && ref.id === record.entityId && ref.revision === after.revision))) throw knowledgeFailure('UNDO_CONFLICT', '该版本已有后续有效记忆引用，不能撤销');
  const timestamp = knowledgeNow();
  if (record.entityType === 'material') {
    const current = await tx.material.findUnique({ where: { id: record.entityId } });
    if (!current || current.revision !== after.revision) throw knowledgeFailure('UNDO_CONFLICT', '材料已有后续修改');
    await checkKnowledgeScope(tx, actor, current.topicId, true);
    const source = await tx.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: current.id, revision: before?.revision ?? current.revision } } });
    const result = await tx.material.update({ where: { id: current.id, revision: current.revision }, data: { title: before?.title ?? current.title, uri: before ? before.uri : current.uri, archivedAt: before ? before.archivedAt : timestamp, revision: { increment: 1 }, updatedAt: timestamp } });
    const { id: _id, ...version } = source;
    await tx.materialVersion.create({ data: { ...version, revision: result.revision, createdAt: timestamp } });
    return result;
  }
  const current = await tx.memory.findUnique({ where: { id: record.entityId } });
  if (!current || current.revision !== after.revision) throw knowledgeFailure('UNDO_CONFLICT', '记忆已有后续修改');
  await checkKnowledgeScope(tx, actor, current.topicId, true);
  const desired = before ?? { ...current, status: 'retired' };
  const result = await tx.memory.update({ where: { id: current.id, revision: current.revision }, data: { title: desired.title, content: desired.content, kind: desired.kind, status: desired.status, health: desired.health, evidence: desired.evidence, revision: { increment: 1 }, updatedAt: timestamp } });
  await tx.memoryVersion.create({ data: { memoryId: result.id, revision: result.revision, title: result.title, content: result.content, kind: result.kind, status: result.status, health: result.health, evidence: result.evidence, reason: `撤销${record.operation}，保留历史版本`, createdAt: timestamp } });
  return result;
}

export class KnowledgeService {
  async materials(actor: Actor, topicId: string | null, options: { taskId?: string; includeArchived?: boolean; cursor?: number; limit?: number } = {}) {
    await checkKnowledgeScope(prisma, actor, topicId);
    const limit = Math.min(100, Math.max(1, options.limit ?? 40));
    const offset = Math.max(0, options.cursor ?? 0);
    const where = { topicId, ...(options.taskId ? { taskId: options.taskId } : {}), ...(options.includeArchived ? {} : { archivedAt: null }) };
    const [items, total] = await Promise.all([prisma.material.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset }), prisma.material.count({ where })]);
    return { items, total, nextCursor: offset + items.length < total ? offset + items.length : null, hasMore: offset + items.length < total };
  }
  async material(actor: Actor, id: string) {
    const material = await prisma.material.findUnique({ where: { id } });
    if (!material) throw knowledgeFailure('NOT_FOUND', '材料不存在', 404);
    await checkKnowledgeScope(prisma, actor, material.topicId);
    const versions = await prisma.materialVersion.findMany({ where: { materialId: id }, orderBy: { revision: 'desc' } });
    return { ...material, versions: versions.map((value) => ({ ...publicVersion(value), metadata: parseJson(value.metadata, {}) })) };
  }
  async attachment(actor: Actor, id: string, revision: number) {
    const material = await prisma.material.findUnique({ where: { id } });
    if (!material) throw knowledgeFailure('NOT_FOUND', '材料不存在', 404);
    await checkKnowledgeScope(prisma, actor, material.topicId);
    const version = await prisma.materialVersion.findUnique({ where: { materialId_revision: { materialId: id, revision } } });
    if (!version?.attachmentPath || !/^[a-f0-9]{64}$/.test(version.attachmentPath)) throw knowledgeFailure('NOT_FOUND', '附件不存在', 404);
    const bytes = await readFile(resolve(knowledgeStorageRoot(), version.attachmentPath)).catch(() => { throw knowledgeFailure('ATTACHMENT_MISSING', '附件原件已不可用', 404); });
    if (knowledgeHash(bytes) !== version.attachmentPath) throw knowledgeFailure('ATTACHMENT_CORRUPT', '附件内容校验失败');
    return { bytes, fileName: version.fileName ?? 'attachment', mimeType: version.mimeType ?? 'application/octet-stream' };
  }
  async memories(actor: Actor, topicId: string | null, options: { history?: boolean; cursor?: number; limit?: number } = {}) {
    await checkKnowledgeScope(prisma, actor, topicId);
    const where = { topicId, ...(options.history ? {} : { status: 'active' }) };
    const offset = Math.max(0, options.cursor ?? 0);
    const limit = Math.min(100, Math.max(1, options.limit ?? 40));
    const [records, total] = await Promise.all([prisma.memory.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: offset, take: limit }), prisma.memory.count({ where })]);
    const items = [];
    for (const row of records) { const evidence = readEvidence(row.evidence); items.push({ ...row, evidence, health: await evidenceHealth(prisma, actor, evidence) }); }
    return { items, total, nextCursor: offset + items.length < total ? offset + items.length : null, hasMore: offset + items.length < total };
  }
  async memory(actor: Actor, id: string) {
    const row = await prisma.memory.findUnique({ where: { id } });
    if (!row) throw knowledgeFailure('NOT_FOUND', '记忆不存在', 404);
    await checkKnowledgeScope(prisma, actor, row.topicId);
    const evidence = readEvidence(row.evidence);
    const versions = await prisma.memoryVersion.findMany({ where: { memoryId: id }, orderBy: { revision: 'desc' } });
    return { ...row, evidence, health: await evidenceHealth(prisma, actor, evidence), versions: versions.map((item) => ({ ...item, evidence: readEvidence(item.evidence) })) };
  }
  async brief(actor: Actor, topicId: string | null) {
    const snapshot = await takeKnowledgeSnapshot(actor, { topicId });
    const id = topicId ? `topic:${topicId}` : 'inbox';
    const previous = await prisma.workingBrief.findUnique({ where: { id } });
    const manifest = snapshot.sources.map(({ type, id: sourceId, revision, hash }) => ({ type, id: sourceId, revision, hash }));
    const memories = await this.memories(actor, topicId);
    const stale = memories.items.filter((item) => item.health !== 'current');
    const lines = ['# 当前简报', '', '## 任务', ...snapshot.sources.filter((source) => source.type === 'task').map((source) => { const task = parseJson(source.content, { status: '', title: source.title }); return `- [${task.status}] ${task.title}`; }), '', '## 有效记忆', ...snapshot.sources.filter((source) => source.type === 'memory').map((source) => `- ${source.title}：${source.content.slice(0, 1000)}`), '', '## 需要复核', ...stale.map((row) => `- ${row.title}（${row.health}）`)];
    if (snapshot.truncated) lines.push('', '部分资料未展开，请按需查找详情。');
    const timestamp = knowledgeNow();
    // Regeneration only updates derived fields; manualNotes and its revision are never overwritten.
    const content = lines.join('\n');
    const row = await prisma.workingBrief.upsert({ where: { id }, create: { id, topicId, content, manifest: JSON.stringify(manifest), generatedAt: timestamp, updatedAt: timestamp }, update: { content, manifest: JSON.stringify(manifest), generatedAt: timestamp } });
    return { ...row, manifest, previouslyStale: Boolean(previous && previous.manifest !== JSON.stringify(manifest)), truncated: snapshot.truncated };
  }
  async saveBrief(actor: Actor, input: { topicId: string | null; expectedVersion: number; manualNotes: string }) {
    assertOwner(actor);
    await checkKnowledgeScope(prisma, actor, input.topicId, true);
    const id = input.topicId ? `topic:${input.topicId}` : 'inbox';
    const data = z.object({ topicId: z.string().nullable(), expectedVersion: z.number().int().positive(), manualNotes: z.string().max(10_000) }).parse(input);
    const updated = await prisma.workingBrief.updateMany({ where: { id, revision: data.expectedVersion }, data: { manualNotes: data.manualNotes, revision: { increment: 1 }, updatedAt: knowledgeNow() } });
    if (!updated.count) throw knowledgeFailure('VERSION_CONFLICT', '简报备注已变化，请重新加载');
    return this.brief(actor, input.topicId);
  }
  async search(actor: Actor, input: { topicId: string | null; q: string; includeHistory?: boolean; cursor?: number; limit?: number }) {
    await checkKnowledgeScope(prisma, actor, input.topicId);
    const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
    const query = normalize(input.q);
    if (!query || query.length > 500) throw knowledgeFailure('INVALID_QUERY', '请输入 1 至 500 个字符的检索内容', 400);
    const terms = query.split(' ');
    const rows: Array<{ type: string; id: string; revision: number; title: string; content: string; status: string; updatedAt: string }> = [];
    const tasks = await prisma.task.findMany({ where: { topicId: input.topicId, ...(input.includeHistory ? {} : { deletedAt: null }) } });
    for (const task of tasks) rows.push({ type: 'task', id: task.id, revision: task.revision, title: task.title, content: `${task.description}\n${task.resultSummary}`, status: task.deletedAt ? 'deleted' : task.status, updatedAt: task.updatedAt });
    const materials = await prisma.material.findMany({ where: { topicId: input.topicId, ...(input.includeHistory ? {} : { archivedAt: null }) }, include: { versions: true } });
    for (const material of materials) for (const version of material.versions) {
      if (!input.includeHistory && version.revision !== material.revision) continue;
      rows.push({ type: 'material', id: material.id, revision: version.revision, title: material.title, content: version.content, status: material.archivedAt ? 'archived' : version.revision === material.revision ? 'current' : 'historical', updatedAt: version.createdAt });
    }
    const memories = await prisma.memory.findMany({ where: { topicId: input.topicId, ...(input.includeHistory ? {} : { status: 'active' }) }, include: { versions: true } });
    for (const memory of memories) {
      const health = await evidenceHealth(prisma, actor, readEvidence(memory.evidence));
      if (!input.includeHistory && health !== 'current') continue;
      for (const version of memory.versions) {
        if (!input.includeHistory && version.revision !== memory.revision) continue;
        rows.push({ type: 'memory', id: memory.id, revision: version.revision, title: version.title, content: version.content, status: version.revision === memory.revision ? health === 'current' ? memory.status : health : 'historical', updatedAt: version.createdAt });
      }
    }
    const hits = rows.filter((row) => terms.every((term) => normalize(`${row.title}\n${row.content}`).includes(term))).map((row) => {
      const normalizedTitle = normalize(row.title);
      const rank = normalizedTitle === query ? 0 : normalizedTitle.includes(query) ? 1 : 2;
      const offset = Math.max(0, normalize(row.content).indexOf(terms[0]) - 60);
      return { ...row, content: undefined, snippet: row.content.slice(offset, offset + 300), rank };
    }).sort((a, b) => a.rank - b.rank || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id) || b.revision - a.revision);
    const cursor = Math.max(0, input.cursor ?? 0), limit = Math.min(100, Math.max(1, input.limit ?? 30));
    return { items: hits.slice(cursor, cursor + limit), total: hits.length, nextCursor: cursor + limit < hits.length ? cursor + limit : null, hasMore: cursor + limit < hits.length, mode: 'literal' };
  }
}
