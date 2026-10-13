import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../commands.js';
import { knowledgeHash, readKnowledgeBlob, storeKnowledgeBlob } from '../knowledge-blobs.js';
import { recordChange, type MutationContext } from '../workspace-store.js';
import type { Actor } from '../security.js';
import type { Material } from '@prisma/client';
import { assertWritableTopic, libraryError, libraryNow, writableMaterial, type LibraryDb } from './access.js';
import { writeMetaDocument, tagNames } from './index-docs.js';
import { addManualLinks, applyLegacyPointer, materialSnapshot, queueExtraction } from './links.js';
import { readUploadBytes } from './uploads.js';

export const uploadMaterialInput = z.object({
  uploadId: z.string().min(1),
  duplicateAction: z.enum(['create', 'reuse']),
  reuseMaterialId: z.string().min(1).optional(),
  topicId: z.string().min(1).nullable(),
  folderId: z.string().min(1).nullable(),
  taskIds: z.array(z.string().min(1)).default([]),
}).strict();

export function isUploadCreate(input: unknown) {
  return Boolean(input && typeof input === 'object' && 'uploadId' in input);
}

const contentKeys = ['title', 'content', 'uri', 'metadata', 'attachmentBase64', 'fileName', 'mimeType'] as const;

export function isTaskOnlyUpdate(input: Record<string, unknown>) {
  return Object.prototype.hasOwnProperty.call(input, 'taskId') && contentKeys.every((key) => input[key] === undefined);
}

export function uploadPresentation(fileName: string, mimeType: string) {
  const dot = fileName.lastIndexOf('.');
  const extension = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  const bare = (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
  const title = (bare || fileName).slice(0, 300);
  const markdown = extension === 'md' || extension === 'markdown' || mimeType === 'text/markdown';
  const text = !markdown && (['txt', 'csv', 'json', 'log'].includes(extension) || mimeType.startsWith('text/'));
  const kind = markdown ? 'markdown' as const : text ? 'text' as const : 'attachment' as const;
  return { title, kind, extension };
}

export async function afterMaterialVersion(tx: LibraryDb, material: Material) {
  const version = await tx.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: material.id, revision: material.revision } } });
  let missing = false;
  if (version.attachmentPath) {
    try { await readKnowledgeBlob(version.attachmentPath); }
    catch { missing = true; }
  }
  await queueExtraction(tx, material.id, version.revision, missing ? 'failed' : 'queued', missing ? 'MISSING_BLOB' : null, libraryNow());
  await writeMetaDocument(tx, material, version, await tagNames(tx, material.id));
  return version;
}

export async function applyTaskPointer(tx: LibraryDb, actor: Actor, material: Material, taskId: string | null, context: MutationContext) {
  const before = await materialSnapshot(tx, material);
  const changed = await applyLegacyPointer(tx, material, taskId, actor);
  if (!changed) return material;
  const updated = await tx.material.update({ where: { id: material.id }, data: { taskId, organizationRevision: { increment: 1 }, updatedAt: libraryNow() } });
  await recordChange(tx, 'material', material.id, 'update', before, await materialSnapshot(tx, updated), context);
  return updated;
}

async function assertFolder(tx: LibraryDb, folderId: string | null) {
  if (!folderId) return;
  if (!await tx.libraryFolder.findUnique({ where: { id: folderId } })) throw libraryError('NOT_FOUND', '文件夹不存在', 404);
}

type UploadCommitResult = { id: string; revision: number; organizationRevision: number };

function commitHash(intent: unknown) {
  return createHash('sha256').update(canonical(intent)).digest('hex');
}

async function replayCommit(tx: LibraryDb, upload: { commitRequestHash: string | null; commitResultJson: string | null; materialId: string | null }, hash: string) {
  if (!upload.commitRequestHash) {
    if (!upload.materialId) throw libraryError('UPLOAD_ALREADY_COMMITTED', '上传已经保存为资料');
    return tx.material.findUniqueOrThrow({ where: { id: upload.materialId } });
  }
  if (upload.commitRequestHash !== hash) throw libraryError('IDEMPOTENCY_CONFLICT', '相同上传不能用于不同提交');
  const stored = JSON.parse(upload.commitResultJson ?? '{}') as UploadCommitResult;
  return tx.material.findUniqueOrThrow({ where: { id: stored.id } });
}

function commitData(hash: string, result: UploadCommitResult, timestamp: string) {
  return { state: 'committed' as const, materialId: result.id, resultRevision: result.revision, commitRequestHash: hash, commitResultJson: JSON.stringify(result), updatedAt: timestamp };
}

export async function createMaterialFromUpload(tx: LibraryDb, actor: Actor, input: {
  uploadId: string;
  duplicateAction: 'create' | 'reuse';
  reuseMaterialId?: string;
  topicId: string | null;
  folderId: string | null;
  taskIds: string[];
}, context: MutationContext) {
  const upload = await tx.libraryUpload.findUnique({ where: { id: input.uploadId } });
  if (!upload || upload.actorId !== actor.id) throw libraryError('NOT_FOUND', '上传不存在', 404);
  const hash = commitHash({
    operation: 'create', uploadId: input.uploadId, duplicateAction: input.duplicateAction, reuseMaterialId: input.reuseMaterialId ?? null,
    topicId: input.topicId, folderId: input.folderId, taskIds: [...new Set(input.taskIds)].sort(),
  });
  if (upload.state === 'committed') return replayCommit(tx, upload, hash);
  if (upload.expiresAt < libraryNow()) throw libraryError('UPLOAD_EXPIRED', '上传已过期');
  if (upload.state !== 'ready' || !upload.sha256) throw libraryError('UPLOAD_NOT_READY', '文件尚未上传完成', 409);
  await assertWritableTopic(tx, actor, input.topicId);
  await assertFolder(tx, input.folderId);
  const timestamp = libraryNow();
  if (input.duplicateAction === 'reuse') {
    if (!input.reuseMaterialId) throw libraryError('REUSE_TARGET_REQUIRED', '复用已有资料时必须指定资料', 400);
    const material = await writableMaterial(tx, actor, input.reuseMaterialId);
    const version = await tx.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: material.id, revision: material.revision } } });
    if (version.attachmentPath !== upload.sha256) throw libraryError('UPLOAD_HASH_MISMATCH', '已有资料的原件与上传文件不同');
    const before = await materialSnapshot(tx, material);
    const changed = await addManualLinks(tx, material.id, input.taskIds, actor);
    const saved = changed ? await (await import('./links.js')).bumpOrganization(tx, material, context, before) : material;
    if (!context.preview) await tx.libraryUpload.update({ where: { id: upload.id }, data: commitData(hash, { id: saved.id, revision: saved.revision, organizationRevision: saved.organizationRevision }, timestamp) });
    return saved;
  }
  const bytes = context.preview ? null : await readUploadBytes(tx, upload.id);
  if (bytes && knowledgeHash(bytes) !== upload.sha256) throw libraryError('UPLOAD_CORRUPT', '上传内容校验失败');
  const attachmentPath = bytes ? await storeKnowledgeBlob(bytes) : upload.sha256;
  const presentation = uploadPresentation(upload.fileName, upload.mimeType);
  let content = '';
  if (bytes && (presentation.kind === 'text' || presentation.kind === 'markdown')) {
    const text = bytes.toString('utf8');
    if (!text.includes('\u0000')) content = text;
  }
  const material = await tx.material.create({ data: {
    id: context.entityId ?? upload.id, topicId: input.topicId, folderId: input.folderId, taskId: null,
    kind: presentation.kind, title: presentation.title, createdAt: timestamp, updatedAt: timestamp,
  } });
  await tx.materialVersion.create({ data: {
    materialId: material.id, revision: material.revision, content, contentHash: knowledgeHash(`${content}\0${attachmentPath}`),
    metadata: '{}', attachmentPath, fileName: upload.fileName, mimeType: upload.mimeType, createdAt: timestamp,
  } });
  await addManualLinks(tx, material.id, input.taskIds, actor);
  await afterMaterialVersion(tx, material);
  if (!context.preview) await tx.libraryUpload.update({ where: { id: upload.id }, data: commitData(hash, { id: material.id, revision: material.revision, organizationRevision: material.organizationRevision }, timestamp) });
  const after = await materialSnapshot(tx, material);
  await recordChange(tx, 'material', material.id, 'create', null, after, context);
  return material;
}

export async function replaceMaterialFromUpload(tx: LibraryDb, actor: Actor, materialId: string, expectedRevision: number | undefined, uploadId: string, context: MutationContext) {
  const upload = await tx.libraryUpload.findUnique({ where: { id: uploadId } });
  if (!upload || upload.actorId !== actor.id) throw libraryError('NOT_FOUND', '上传不存在', 404);
  const hash = commitHash({ operation: 'replace', uploadId, materialId, expectedRevision: expectedRevision ?? 0 });
  if (upload.state === 'committed') return replayCommit(tx, upload, hash);
  const material = await writableMaterial(tx, actor, materialId);
  const { assertExpected } = await import('./access.js');
  assertExpected(material.revision, expectedRevision);
  if (upload.state !== 'ready' || !upload.sha256) throw libraryError('UPLOAD_NOT_READY', '文件尚未上传完成', 409);
  const before = await materialSnapshot(tx, material);
  const previous = await tx.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: material.id, revision: material.revision } } });
  const bytes = context.preview ? null : await readUploadBytes(tx, upload.id);
  if (bytes && knowledgeHash(bytes) !== upload.sha256) throw libraryError('UPLOAD_CORRUPT', '上传内容校验失败');
  const attachmentPath = bytes ? await storeKnowledgeBlob(bytes) : upload.sha256;
  const presentation = uploadPresentation(upload.fileName, upload.mimeType);
  let content = previous.content;
  if (bytes && (presentation.kind === 'text' || presentation.kind === 'markdown')) {
    const text = bytes.toString('utf8');
    if (!text.includes('\u0000')) content = text;
  }
  const timestamp = libraryNow();
  const updated = await tx.material.update({ where: { id: material.id, revision: material.revision }, data: { title: presentation.title, kind: presentation.kind, revision: { increment: 1 }, updatedAt: timestamp } });
  await tx.materialVersion.create({ data: {
    materialId: material.id, revision: updated.revision, content, contentHash: knowledgeHash(`${content}\0${attachmentPath}`),
    metadata: previous.metadata, attachmentPath, fileName: upload.fileName, mimeType: upload.mimeType, createdAt: timestamp,
  } });
  await afterMaterialVersion(tx, updated);
  if (!context.preview) await tx.libraryUpload.update({ where: { id: upload.id }, data: commitData(hash, { id: updated.id, revision: updated.revision, organizationRevision: updated.organizationRevision }, timestamp) });
  await recordChange(tx, 'material', material.id, 'update', before, await materialSnapshot(tx, updated), context);
  return updated;
}
