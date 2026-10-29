import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Material, MaterialVersion } from '@prisma/client';
import { z } from 'zod';
import { assertWritableContent, canonicalContent, contentCapabilities, inspectRichDocument, type DocumentContent, type ResourceFormat, type ResourceReference, type RichBlock } from '../../domain/document-content.js';
import { prisma } from '../../infrastructure/prisma.js';
import { canonical, publishWorkspaceChange, runSerializedCommand } from '../commands.js';
import { knowledgeHash, readKnowledgeBlob, storeKnowledgeBlob } from '../knowledge-blobs.js';
import { assertOwner, refreshActor, type Actor } from '../security.js';
import { recordChange, type MutationContext } from '../workspace-store.js';
import { assertExpected, assertWritableTopic, libraryError, libraryNow, readableMaterial, topicVisible, writableMaterial, type LibraryDb } from '../library/access.js';
import { afterMaterialVersion, importedUtf8 } from '../library/material-write.js';
import { materialSnapshot } from '../library/links.js';
import { tagNames, writeMetaDocument } from '../library/index-docs.js';
import { serializeContent, versionContent, versionFormat, versionSupported } from './version.js';
import { assertDocumentWritable, documentWritesPaused } from './write-policy.js';

const requestId = z.string().min(1).max(200);
const formatSchema = z.enum(['richdoc-v1', 'markdown', 'text']);
export const relativeReferenceSchema = z.object({
  path: z.string().min(1).max(1024).refine((path) => !path.startsWith('/') && !/[\\\u0000]/.test(path) && !/^[a-z][a-z0-9+.-]*:/i.test(path) && path !== '.' && posix.normalize(path) === path && path.split('/').filter((part) => part === '..').length <= 32, 'Expected a normalized relative resource alias'),
  resourceId: z.string().min(1).max(128), revision: z.number().int().positive(),
}).strict();
type RelativeReference = z.infer<typeof relativeReferenceSchema>;
const contentFields = {
  requestId,
  format: formatSchema,
  schemaVersion: z.number().int().positive().nullable().optional(),
  content: z.unknown(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  relativeReferences: z.array(relativeReferenceSchema).max(1000).refine((refs) => new Set(refs.map((ref) => ref.path)).size === refs.length, 'Duplicate relative resource alias').optional(),
};
const importedVersion = z.object({ resourceId: z.string().min(1), revision: z.number().int().positive() }).strict();
export const createResourceSchema = z.object({
  ...contentFields, title: z.string().trim().min(1).max(300),
  format: z.enum(['richdoc-v1', 'markdown', 'text', 'binary']),
  topicId: z.string().min(1).nullable().default(null), folderId: z.string().min(1).nullable().default(null),
  managed: z.boolean().optional(),
  conversionSource: importedVersion.optional(),
  importSource: z.object({ original: importedVersion.optional(), sourceOriginal: importedVersion.optional(), supplementalContent: z.string().max(8 * 1024 * 1024).optional() }).strict().optional(),
}).strict();
export const saveResourceSchema = z.object({ ...contentFields, expectedRevision: z.number().int().positive() }).strict();
export const restoreResourceSchema = z.object({ requestId, expectedRevision: z.number().int().positive(), sourceRevision: z.number().int().positive() }).strict();
export const organizeResourceSchema = z.object({
  requestId, expectedOrganizationRevision: z.number().int().positive(), title: z.string().trim().min(1).max(300).optional(),
  folderId: z.string().min(1).nullable().optional(), archived: z.boolean().optional(),
}).strict();

export type ResourceReceipt = { requestId: string; resourceId: string; revision: number; contentHash: string; organizationRevision: number };

function checkedContent(input: { format: ResourceFormat; schemaVersion?: number | null; content?: unknown; contentHash?: string }, binaryImport = false) {
  try { if (!(binaryImport && input.format === 'binary' && typeof input.content === 'string')) assertWritableContent(input.format, input.content as DocumentContent, input.schemaVersion); }
  catch (error) { throw libraryError('UNSUPPORTED_CONTENT', error instanceof Error ? error.message : '不支持此正文格式', 400); }
  const content = input.content as DocumentContent;
  const body = serializeContent(input.format, content);
  if (Buffer.byteLength(body, 'utf8') > 8 * 1024 * 1024) throw libraryError('DOCUMENT_TOO_LARGE', '正文超过 8 MiB，请拆分文档或作为文件导入', 413);
  const contentHash = knowledgeHash(canonicalContent(content));
  if (input.contentHash && input.contentHash !== contentHash) throw libraryError('CONTENT_HASH_MISMATCH', '正文校验失败', 400);
  return { content, body, contentHash, schemaVersion: input.format === 'richdoc-v1' ? 1 : null };
}

export async function referencesFor(tx: LibraryDb, actor: Actor, format: ResourceFormat, content: DocumentContent, relativeReferences: RelativeReference[] = []) {
  if (format !== 'markdown' && relativeReferences.length) throw libraryError('UNSUPPORTED_CONTENT', 'Relative resources require Markdown', 400);
  const references = format === 'richdoc-v1' ? inspectRichDocument(content).references : format === 'markdown' ? relativeReferences.map((ref) => ({ nodeId: `path:${ref.path}`, mode: 'fixed' as const, resourceId: ref.resourceId, revision: ref.revision })) : [];
  return authorizeReferences(tx, actor, references);
}

async function authorizeReferences(tx: LibraryDb, actor: Actor, references: ResourceReference[]) {
  if (references.length > 1000) throw libraryError('TOO_MANY_REFERENCES', '单份文档最多引用 1000 个文件节点', 413);
  const ids = [...new Set(references.map((ref) => ref.resourceId))];
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    const materials = await tx.material.findMany({ where: { id: { in: batch } } });
    if (materials.length !== batch.length) throw libraryError('REFERENCE_NOT_FOUND', '引用的文件不存在', 400);
    if (materials.some((row) => !topicVisible(actor, row.topicId))) throw libraryError('SCOPE_DENIED', '引用的文件不在授权范围内', 403);
    const sourceTasks = materials.flatMap((row) => row.sourceTaskId ? [row.sourceTaskId] : []);
    if (sourceTasks.length) {
      const tasks = await tx.task.findMany({ where: { id: { in: sourceTasks }, deletedAt: null } });
      const visible = new Set(tasks.filter((task) => topicVisible(actor, task.topicId)).map((task) => task.id));
      if (sourceTasks.some((taskId) => !visible.has(taskId))) throw libraryError('SCOPE_DENIED', '引用的任务图片已不可访问', 403);
    }
    const relevant = references.filter((ref) => batch.includes(ref.resourceId));
    const versions = await tx.materialVersion.findMany({ where: { OR: relevant.map((ref) => ({ materialId: ref.resourceId, revision: ref.revision })) }, select: { materialId: true, revision: true } });
    const keys = new Set(versions.map((row) => `${row.materialId}:${row.revision}`));
    if (relevant.some((ref) => !keys.has(`${ref.resourceId}:${ref.revision}`))) throw libraryError('REFERENCE_NOT_FOUND', '引用的文件版本不存在', 400);
  }
  return references;
}

async function versionRelativeReferences(tx: LibraryDb, resourceId: string, revision: number): Promise<RelativeReference[]> {
  const rows = await tx.resourceReference.findMany({ where: { sourceResourceId: resourceId, sourceRevision: revision, nodeId: { startsWith: 'path:' } }, orderBy: { nodeId: 'asc' } });
  return rows.map((ref) => ({ path: ref.nodeId.slice(5), resourceId: ref.targetResourceId, revision: ref.targetRevision }));
}

export async function referencesForVersion(tx: LibraryDb, actor: Actor, kind: string, version: MaterialVersion) {
  const stored = await tx.resourceReference.findMany({ where: { sourceResourceId: version.materialId, sourceRevision: version.revision } });
  const entries: ResourceReference[] = stored.map((ref) => ({ nodeId: ref.nodeId, mode: 'fixed', resourceId: ref.targetResourceId, revision: ref.targetRevision }));
  const parsed = versionFormat(kind, version) === 'richdoc-v1' ? inspectRichDocument(versionContent(kind, version)).references : [];
  const merged = new Map(entries.map((ref) => [ref.nodeId, ref]));
  for (const ref of parsed) merged.set(ref.nodeId, ref);
  return authorizeReferences(tx, actor, [...merged.values()]);
}

export async function recordReferences(tx: LibraryDb, resourceId: string, revision: number, references: Awaited<ReturnType<typeof referencesFor>>) {
  if (references.length) await tx.resourceReference.createMany({ data: references.map((ref) => ({
    sourceResourceId: resourceId, sourceRevision: revision, nodeId: ref.nodeId, targetResourceId: ref.resourceId, targetRevision: ref.revision,
  })) });
}

async function assertFolder(tx: LibraryDb, folderId: string | null | undefined) {
  if (folderId && !await tx.libraryFolder.findUnique({ where: { id: folderId } })) throw libraryError('NOT_FOUND', '文件夹不存在', 404);
}

async function receiptIn(tx: LibraryDb, actor: Actor, id: string, hash?: string): Promise<ResourceReceipt | null> {
  const row = await tx.resourceWriteReceipt.findUnique({ where: { actorId_requestId: { actorId: actor.id, requestId: id } } });
  if (!row) return null;
  await readableMaterial(tx, actor, row.resourceId);
  if (hash && row.requestHash !== hash) throw libraryError('IDEMPOTENCY_CONFLICT', '同一请求标识不能提交不同内容');
  return JSON.parse(row.resultJson) as ResourceReceipt;
}

async function storeReceipt(tx: LibraryDb, actor: Actor, id: string, hash: string, material: Material, version: MaterialVersion, submittedHash = version.contentHash): Promise<ResourceReceipt> {
  const result = { requestId: id, resourceId: material.id, revision: version.revision, contentHash: submittedHash, organizationRevision: material.organizationRevision };
  await tx.resourceWriteReceipt.create({ data: { actorId: actor.id, requestId: id, requestHash: hash, resourceId: material.id, revision: version.revision, resultJson: JSON.stringify(result), createdAt: libraryNow() } });
  return result;
}

async function importProvenance(tx: LibraryDb, actor: Actor, input: z.infer<typeof createResourceSchema>, checked: ReturnType<typeof checkedContent>) {
  const originalOf = async (reference: z.infer<typeof importedVersion> | undefined) => {
    if (!reference) return null;
    const material = await readableMaterial(tx, actor, reference.resourceId);
    const version = await tx.materialVersion.findUnique({ where: { materialId_revision: { materialId: reference.resourceId, revision: reference.revision } } });
    if (!version?.attachmentPath) throw libraryError('IMPORT_ORIGINAL_REQUIRED', '导入来源必须是已经上传完成的文件原件', 400);
    await referencesForVersion(tx, actor, material.kind, version);
    return { version, bytes: await readKnowledgeBlob(version.attachmentPath) };
  };
  const original = await originalOf(input.importSource?.original);
  const source = await originalOf(input.importSource?.sourceOriginal);
  let conversionSource: (z.infer<typeof importedVersion> & { format: ResourceFormat; contentHash: string }) | undefined;
  if (input.conversionSource) {
    const material = await readableMaterial(tx, actor, input.conversionSource.resourceId);
    const version = await tx.materialVersion.findUnique({ where: { materialId_revision: { materialId: material.id, revision: input.conversionSource.revision } } });
    if (!version) throw libraryError('NOT_FOUND', '资料版本不存在', 404);
    if (!versionSupported(material.kind, version)) throw libraryError('UNSUPPORTED_FORMAT_WRITE', '此版本不能用该格式覆盖，请另存为新文档');
    await referencesForVersion(tx, actor, material.kind, version);
    conversionSource = { ...input.conversionSource, format: versionFormat(material.kind, version), contentHash: version.contentHash };
  }
  if (input.format === 'binary' && !original) throw libraryError('IMPORT_ORIGINAL_REQUIRED', '导入来源必须是已经上传完成的文件原件', 400);
  if (original && input.format !== 'binary') {
    const text = importedUtf8(original.bytes);
    let matches = text === checked.body;
    if (input.format === 'richdoc-v1' && text !== null) {
      try { matches = canonicalContent(JSON.parse(text)) === checked.body; } catch { matches = false; }
    }
    if (!matches) throw libraryError('IMPORT_BODY_MISMATCH', '导入原件与文档正文不一致', 400);
  }
  return {
    attachmentPath: original?.version.attachmentPath ?? null, sourceOriginalPath: source?.version.attachmentPath ?? original?.version.attachmentPath ?? null,
    fileName: original?.version.fileName ?? null, mimeType: original?.version.mimeType ?? null,
    supplementalContent: input.importSource?.supplementalContent ?? null,
    metadata: JSON.stringify({ ...(source ? { documentImportSource: { sourceOriginal: input.importSource!.sourceOriginal } } : {}), ...(conversionSource ? { documentConversionSource: conversionSource } : {}) }),
  };
}

async function resourceDto(tx: LibraryDb, actor: Actor, material: Material, version: MaterialVersion, historical: boolean) {
  const format = versionFormat(material.kind, version);
  const supported = versionSupported(material.kind, version);
  let readOnly = documentWritesPaused() || historical || Boolean(material.archivedAt) || !supported || format === 'binary' || actor.kind !== 'user' || Buffer.byteLength(version.authoritativeContent ?? version.content, 'utf8') > 8 * 1024 * 1024;
  const refs = await tx.resourceReference.findMany({ where: { sourceResourceId: material.id, sourceRevision: version.revision } });
  const targets = refs.length ? await tx.material.findMany({ where: { id: { in: [...new Set(refs.map((ref) => ref.targetResourceId))] } } }) : [];
  const sourceTaskIds = targets.flatMap((target) => target.sourceTaskId ? [target.sourceTaskId] : []);
  const sourceTasks = sourceTaskIds.length ? await tx.task.findMany({ where: { id: { in: sourceTaskIds }, deletedAt: null }, select: { id: true, topicId: true } }) : [];
  const allowedTasks = new Set(sourceTasks.filter((task) => topicVisible(actor, task.topicId)).map((task) => task.id));
  const readable = new Set(targets.filter((target) => topicVisible(actor, target.topicId) && (!target.sourceTaskId || allowedTasks.has(target.sourceTaskId))).map((target) => target.id));
  let content = versionContent(material.kind, version);
  const restrictedNodes = new Set(refs.filter((ref) => !readable.has(ref.targetResourceId)).map((ref) => ref.nodeId));
  if (!supported && restrictedNodes.size) throw libraryError('SCOPE_DENIED', '引用的文件不在授权范围内', 403);
  if (format === 'richdoc-v1' && supported && restrictedNodes.size && typeof content !== 'string') {
    content = structuredClone(content);
    const redact = (blocks: RichBlock[]) => {
      for (const block of blocks) {
        if (restrictedNodes.has(block.id)) { delete block.label; delete block.alt; delete block.caption; }
        if (block.children) redact(block.children);
      }
    };
    redact(content.blocks);
    // The redacted view must never be saved over the unmodified authoritative body.
    readOnly = true;
  }
  const versions = await tx.materialVersion.findMany({ where: { materialId: material.id }, orderBy: { revision: 'desc' }, take: 100, select: { revision: true, contentHash: true, createdAt: true, format: true } });
  let conversionSource: (z.infer<typeof importedVersion> & { format: ResourceFormat; contentHash: string }) | null = null;
  try {
    const stored = JSON.parse(version.metadata ?? '{}').documentConversionSource;
    const reference = importedVersion.safeParse(stored ? { resourceId: stored.resourceId, revision: stored.revision } : null);
    if (reference.success) {
      const source = await readableMaterial(tx, actor, reference.data.resourceId);
      const sourceVersion = await tx.materialVersion.findUnique({ where: { materialId_revision: { materialId: source.id, revision: reference.data.revision } } });
      if (sourceVersion) {
        await referencesForVersion(tx, actor, source.kind, sourceVersion);
        conversionSource = { ...reference.data, format: versionFormat(source.kind, sourceVersion), contentHash: sourceVersion.contentHash };
      }
    }
  } catch { /* Provenance remains stored, but no source identity is exposed after access is revoked. */ }
  return {
    id: material.id, title: material.title, kind: material.kind, topicId: material.topicId, folderId: material.folderId, managed: material.managed,
    revision: version.revision, currentRevision: material.revision, organizationRevision: material.organizationRevision,
    format, schemaVersion: version.schemaVersion, content, contentHash: version.contentHash,
    encoding: format === 'text' || format === 'markdown' ? 'utf-8' : null, readOnly, supported,
    capabilities: { ...contentCapabilities(format, supported), ...(documentWritesPaused() ? { edit: false } : {}) }, archivedAt: material.archivedAt, updatedAt: material.updatedAt,
    writesPaused: documentWritesPaused(),
    attachment: version.attachmentPath ? { fileName: version.fileName, mimeType: version.mimeType, url: `/api/v1/library/resources/${encodeURIComponent(material.id)}/versions/${version.revision}/original` } : null,
    hasSourceOriginal: Boolean(version.sourceOriginalPath), versions,
    supplementalContent: version.supplementalContent,
    conversionSource,
    references: refs.map((ref) => ({ nodeId: ref.nodeId, resourceId: ref.targetResourceId, revision: ref.targetRevision, accessible: readable.has(ref.targetResourceId) })),
    relativeReferences: refs.filter((ref) => ref.nodeId.startsWith('path:')).map((ref) => ({ path: ref.nodeId.slice(5), resourceId: ref.targetResourceId, revision: ref.targetRevision, accessible: readable.has(ref.targetResourceId) })),
  };
}

export class ResourceService {
  constructor(private readonly execution?: { tx: LibraryDb; context: MutationContext }) {}

  private write<T>(run: (tx: LibraryDb) => Promise<T>) {
    return this.execution ? run(this.execution.tx) : runSerializedCommand(run);
  }

  private async acknowledgement(actor: Actor, result: ResourceReceipt) {
    const document = await this.read(actor, result.resourceId, result.revision);
    const readOnly = result.revision !== document.currentRevision || Boolean(document.archivedAt) || !document.capabilities.edit || actor.kind !== 'user' || document.references.some((ref) => !ref.accessible);
    return { ...document, ...result, id: result.resourceId, readOnly };
  }

  async read(actorInput: Actor, id: string, revision?: number) {
    const actor = this.execution ? actorInput : await refreshActor(actorInput);
    const db = this.execution?.tx ?? prisma;
    const material = await readableMaterial(db, actor, id);
    const version = await db.materialVersion.findUnique({ where: { materialId_revision: { materialId: id, revision: revision ?? material.revision } } });
    if (!version) throw libraryError('NOT_FOUND', '资料版本不存在', 404);
    return resourceDto(db, actor, material, version, revision !== undefined);
  }

  async receipt(actorInput: Actor, id: string) {
    const actor = await refreshActor(actorInput);
    const result = await receiptIn(prisma, actor, requestId.parse(id));
    if (!result) throw libraryError('NOT_FOUND', '尚未找到提交回执', 404);
    return result;
  }

  async create(actorInput: Actor, body: unknown) {
    assertDocumentWritable();
    const actor = this.execution ? actorInput : await refreshActor(actorInput);
    if (!this.execution) assertOwner(actor);
    const input = createResourceSchema.parse(body);
    const checked = checkedContent(input, Boolean(input.importSource?.original));
    const hash = knowledgeHash(canonical({ operation: 'resource.create', ...input }));
    const result = await this.write(async (tx) => {
      const replay = await receiptIn(tx, actor, input.requestId, hash);
      if (replay) return replay;
      await assertWritableTopic(tx, actor, input.topicId);
      await assertFolder(tx, input.folderId);
      const references = await referencesFor(tx, actor, input.format, checked.content, input.relativeReferences);
      const provenance = await importProvenance(tx, actor, input, checked);
      const timestamp = libraryNow();
      const material = await tx.material.create({ data: { id: this.execution?.context.entityId ?? randomUUID(), topicId: input.topicId, folderId: input.folderId, managed: input.managed ?? false, title: input.title, kind: input.format === 'richdoc-v1' ? 'document' : input.format === 'binary' ? 'attachment' : input.format, createdAt: timestamp, updatedAt: timestamp } });
      const version = await tx.materialVersion.create({ data: { ...provenance, materialId: material.id, revision: 1, format: input.format, schemaVersion: checked.schemaVersion, content: checked.body, contentHash: checked.contentHash, createdAt: timestamp } });
      await recordReferences(tx, material.id, 1, references);
      await afterMaterialVersion(tx, material);
      await recordChange(tx, 'material', material.id, 'create', null, { ...await materialSnapshot(tx, material), content: checked.body, contentHash: checked.contentHash }, this.execution?.context ?? { source: 'user', actor, requestId: input.requestId });
      return storeReceipt(tx, actor, input.requestId, hash, material, version);
    });
    if (!this.execution) publishWorkspaceChange({ kind: 'resource.saved', materialId: result.resourceId, resourceId: result.resourceId, revision: result.revision, requestId: input.requestId });
    return this.acknowledgement(actor, result);
  }

  async save(actorInput: Actor, id: string, body: unknown) {
    assertDocumentWritable();
    const actor = this.execution ? actorInput : await refreshActor(actorInput);
    if (!this.execution) assertOwner(actor);
    const input = saveResourceSchema.parse(body);
    const checked = checkedContent(input);
    const hash = knowledgeHash(canonical({ operation: 'resource.save', resourceId: id, ...input }));
    const result = await this.write(async (tx) => {
      const replay = await receiptIn(tx, actor, input.requestId, hash);
      if (replay) return replay;
      const material = await writableMaterial(tx, actor, id);
      if (material.archivedAt) throw libraryError('RESOURCE_ARCHIVED', '归档资料请先恢复再编辑');
      if (material.revision !== input.expectedRevision) {
        const error = libraryError('VERSION_CONFLICT', '文档已有新版本，本机草稿已保留，请比较后处理');
        Object.assign(error, { details: { resourceId: id, expectedRevision: input.expectedRevision, currentRevision: material.revision } });
        throw error;
      }
      const previous = await tx.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: id, revision: material.revision } } });
      if (!versionSupported(material.kind, previous) || versionFormat(material.kind, previous) !== input.format) throw libraryError('UNSUPPORTED_FORMAT_WRITE', '此版本不能用该格式覆盖，请另存为新文档');
      const previousRelative = await versionRelativeReferences(tx, id, previous.revision);
      const relative = input.relativeReferences ?? previousRelative;
      const references = await referencesFor(tx, actor, input.format, checked.content, relative);
      const sameRelative = canonical([...relative].sort((a, b) => a.path.localeCompare(b.path))) === canonical([...previousRelative].sort((a, b) => a.path.localeCompare(b.path)));
      if (serializeContent(input.format, versionContent(material.kind, previous)) === checked.body && sameRelative) return storeReceipt(tx, actor, input.requestId, hash, material, previous, checked.contentHash);
      const before = await materialSnapshot(tx, material);
      const timestamp = libraryNow();
      // Edited imports download their new authoritative body. The imported bytes remain separately addressable.
      const attachmentPath = previous.attachmentPath && input.format !== 'richdoc-v1' ? this.execution?.context.preview ? knowledgeHash(checked.body) : await storeKnowledgeBlob(Buffer.from(checked.body, 'utf8')) : null;
      const updated = await tx.material.update({ where: { id, revision: material.revision }, data: { revision: { increment: 1 }, updatedAt: timestamp } });
      const version = await tx.materialVersion.create({ data: {
        materialId: id, revision: updated.revision, format: input.format, schemaVersion: checked.schemaVersion,
        content: checked.body, contentHash: checked.contentHash, metadata: previous.metadata, attachmentPath,
        sourceOriginalPath: previous.sourceOriginalPath ?? previous.attachmentPath, supplementalContent: previous.supplementalContent, fileName: previous.fileName, mimeType: previous.mimeType, createdAt: timestamp,
      } });
      await recordReferences(tx, id, updated.revision, references);
      await afterMaterialVersion(tx, updated);
      await recordChange(tx, 'material', id, 'update', before, { ...await materialSnapshot(tx, updated), content: checked.body, contentHash: checked.contentHash }, this.execution?.context ?? { source: 'user', actor, requestId: input.requestId });
      return storeReceipt(tx, actor, input.requestId, hash, updated, version);
    });
    if (!this.execution) publishWorkspaceChange({ kind: 'resource.saved', materialId: id, resourceId: id, revision: result.revision, requestId: input.requestId });
    return this.acknowledgement(actor, result);
  }

  async restore(actorInput: Actor, id: string, body: unknown) {
    assertDocumentWritable();
    const actor = await refreshActor(actorInput);
    assertOwner(actor);
    const input = restoreResourceSchema.parse(body);
    const hash = knowledgeHash(canonical({ operation: 'resource.restore', resourceId: id, ...input }));
    const result = await runSerializedCommand(async (tx) => {
      const replay = await receiptIn(tx, actor, input.requestId, hash);
      if (replay) return replay;
      const material = await writableMaterial(tx, actor, id);
      if (material.archivedAt) throw libraryError('RESOURCE_ARCHIVED', '归档资料请先恢复再编辑');
      if (material.revision !== input.expectedRevision) {
        const error = libraryError('VERSION_CONFLICT', '文档已有新版本，本机草稿已保留，请比较后处理');
        Object.assign(error, { details: { resourceId: id, expectedRevision: input.expectedRevision, currentRevision: material.revision } });
        throw error;
      }
      const source = await tx.materialVersion.findUnique({ where: { materialId_revision: { materialId: id, revision: input.sourceRevision } } });
      if (!source) throw libraryError('NOT_FOUND', '资料版本不存在', 404);
      const references = await referencesForVersion(tx, actor, material.kind, source);
      // Verify both immutable originals before committing a restoration receipt.
      for (const path of new Set([source.attachmentPath, source.sourceOriginalPath].filter((path): path is string => Boolean(path)))) await readKnowledgeBlob(path);
      const before = await materialSnapshot(tx, material);
      const timestamp = libraryNow();
      const updated = await tx.material.update({ where: { id, revision: material.revision }, data: { revision: { increment: 1 }, updatedAt: timestamp } });
      const { id: _id, ...snapshot } = source;
      const version = await tx.materialVersion.create({ data: { ...snapshot, revision: updated.revision, createdAt: timestamp } });
      await recordReferences(tx, id, version.revision, references);
      await afterMaterialVersion(tx, updated);
      await recordChange(tx, 'material', id, 'update', before, { ...await materialSnapshot(tx, updated), content: source.content, contentHash: source.contentHash }, { source: 'user', actor, requestId: input.requestId });
      return storeReceipt(tx, actor, input.requestId, hash, updated, version);
    });
    publishWorkspaceChange({ kind: 'resource.saved', materialId: id, resourceId: id, revision: result.revision, requestId: input.requestId });
    return this.acknowledgement(actor, result);
  }

  async organize(actorInput: Actor, id: string, body: unknown) {
    assertDocumentWritable();
    const actor = await refreshActor(actorInput);
    assertOwner(actor);
    const input = organizeResourceSchema.parse(body);
    const hash = knowledgeHash(canonical({ operation: 'resource.organize', resourceId: id, ...input }));
    const result = await runSerializedCommand(async (tx) => {
      const replay = await receiptIn(tx, actor, input.requestId, hash);
      if (replay) return replay;
      const material = await writableMaterial(tx, actor, id);
      assertExpected(material.organizationRevision, input.expectedOrganizationRevision, '整理信息已经变化，请刷新后重试');
      await assertFolder(tx, input.folderId);
      const before = await materialSnapshot(tx, material);
      const title = input.title ?? material.title;
      const folderId = input.folderId === undefined ? material.folderId : input.folderId;
      const archivedAt = input.archived === undefined ? material.archivedAt : input.archived ? material.archivedAt ?? libraryNow() : null;
      const managed = input.folderId === undefined ? material.managed : false;
      const changed = title !== material.title || folderId !== material.folderId || archivedAt !== material.archivedAt || managed !== material.managed;
      const updated = changed ? await tx.material.update({ where: { id, organizationRevision: material.organizationRevision }, data: { title, folderId, archivedAt, managed, organizationRevision: { increment: 1 }, updatedAt: libraryNow() } }) : material;
      const version = await tx.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: id, revision: material.revision } } });
      if (changed) {
        await writeMetaDocument(tx, updated, version, await tagNames(tx, id));
        await recordChange(tx, 'material', id, input.archived === true ? 'archive' : 'update', before, await materialSnapshot(tx, updated), { source: 'user', actor, requestId: input.requestId });
      }
      return storeReceipt(tx, actor, input.requestId, hash, updated, version);
    });
    publishWorkspaceChange({ kind: 'resource.organized', materialId: id, resourceId: id });
    return this.acknowledgement(actor, result);
  }

  async original(actorInput: Actor, id: string, revision: number, source = false) {
    const actor = await refreshActor(actorInput);
    const material = await readableMaterial(prisma, actor, id);
    const version = await prisma.materialVersion.findUnique({ where: { materialId_revision: { materialId: id, revision } } });
    if (!version) throw libraryError('NOT_FOUND', '资料版本不存在', 404);
    const path = source ? version.sourceOriginalPath ?? version.attachmentPath : version.attachmentPath;
    if (source && !path) throw libraryError('NOT_FOUND', '没有导入来源原件', 404);
    const format = versionFormat(material.kind, version);
    if (format === 'richdoc-v1') await referencesForVersion(prisma, actor, material.kind, version);
    if (!path && format === 'binary') throw libraryError('NOT_FOUND', '附件原件不存在', 404);
    const bytes = path ? await readKnowledgeBlob(path) : Buffer.from(format === 'richdoc-v1' ? version.content : String(versionContent(material.kind, version)), 'utf8');
    if (format === 'richdoc-v1' && source) {
      let provenance: z.infer<typeof importedVersion> | undefined;
      try { const parsed = importedVersion.safeParse(JSON.parse(version.metadata).documentImportSource?.sourceOriginal); if (parsed.success) provenance = parsed.data; } catch { /* Legacy metadata has no imported resource identity. */ }
      if (provenance) {
        const sourceResource = await readableMaterial(prisma, actor, provenance.resourceId);
        const sourceVersion = await prisma.materialVersion.findUnique({ where: { materialId_revision: { materialId: provenance.resourceId, revision: provenance.revision } } });
        if (!sourceVersion || sourceVersion.attachmentPath !== path) throw libraryError('REFERENCE_NOT_FOUND', '引用的文件版本不存在', 400);
        await referencesForVersion(prisma, actor, sourceResource.kind, sourceVersion);
      } else {
        let sourceBody: DocumentContent | undefined;
        try { sourceBody = JSON.parse(bytes.toString('utf8')) as DocumentContent; } catch { /* Imported non-JSON originals contain no product references. */ }
        if (sourceBody) await referencesFor(prisma, actor, format, sourceBody);
      }
    }
    return { bytes, fileName: version.fileName ?? `${material.title}.${format === 'richdoc-v1' ? 'json' : format === 'markdown' ? 'md' : 'txt'}`, mimeType: version.mimeType ?? (format === 'richdoc-v1' ? 'application/json' : 'text/plain') };
  }

  async impact(actorInput: Actor, id: string) {
    const actor = await refreshActor(actorInput);
    await readableMaterial(prisma, actor, id);
    const [references, taskLinks] = await Promise.all([
      prisma.resourceReference.findMany({ where: { targetResourceId: id }, take: 100 }),
      prisma.materialTaskLink.findMany({ where: { materialId: id }, take: 100, include: { task: { select: { title: true, topicId: true } } } }),
    ]);
    const sources = references.length ? await prisma.material.findMany({ where: { id: { in: references.map((ref) => ref.sourceResourceId) } } }) : [];
    const visible = new Map(sources.filter((source) => topicVisible(actor, source.topicId)).map((source) => [source.id, source]));
    return {
      references: references.filter((ref) => visible.has(ref.sourceResourceId)).map((ref) => ({ resourceId: ref.sourceResourceId, revision: ref.sourceRevision, nodeId: ref.nodeId, title: visible.get(ref.sourceResourceId)!.title })),
      taskLinks: taskLinks.filter((link) => topicVisible(actor, link.task.topicId)).map((link) => ({ taskId: link.taskId, title: link.task.title })),
      permanentDeletionAllowed: false,
    };
  }
}
