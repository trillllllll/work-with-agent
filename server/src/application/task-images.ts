import { assertDocumentWritable } from './resources/write-policy.js';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { knowledgeStorageRoot, readKnowledgeBlob, storeKnowledgeBlob } from './knowledge-blobs.js';
import { editableTask, now, type Db } from './workspace-store.js';
import { ensureTaskImageResource } from './resources/task-images.js';

const imageLimit = 8 * 1024 * 1024;

export function taskImageUrl(taskId: string, imageId: string) {
  return `/api/tasks/${taskId}/images/${imageId}`;
}

export function taskImageIds(taskId: string, description: string) {
  const ids = new Set<string>();
  const pattern = new RegExp(`/api/tasks/${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/images/([A-Za-z0-9_-]+)`, 'g');
  for (const match of description.matchAll(pattern)) ids.add(match[1]);
  return ids;
}

function imageBytes(value: string) {
  // A repeated-group Base64 regex overflows the stack on multi-megabyte strings.
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new DomainError('INVALID_IMAGE', '图片必须是有效 Base64', 400);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength > imageLimit) throw new DomainError('ATTACHMENT_TOO_LARGE', '附件不能超过 8 MiB', 413);
  return bytes;
}

function matchesMime(bytes: Buffer, mimeType: 'image/webp' | 'image/jpeg') {
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

export async function addTaskImage(taskId: string, input: { attachmentBase64: string; mimeType: 'image/webp' | 'image/jpeg' }) {
  assertDocumentWritable();
  const bytes = imageBytes(input.attachmentBase64);
  if (!matchesMime(bytes, input.mimeType)) throw new DomainError('INVALID_IMAGE', '只接受 WebP 或 JPEG 图片', 400);
  await prisma.$transaction(async (tx) => { await editableTask(tx, taskId); });
  const path = await storeKnowledgeBlob(bytes);
  const row = await prisma.$transaction(async (tx) => {
    await editableTask(tx, taskId);
    const image = await tx.taskImage.create({ data: { taskId, mimeType: input.mimeType, byteSize: bytes.byteLength, path, createdAt: now() } });
    await ensureTaskImageResource(tx, image);
    return image;
  });
  return { id: row.id, url: taskImageUrl(taskId, row.id) };
}

export async function readTaskImage(taskId: string, imageId: string) {
  const row = await prisma.taskImage.findFirst({ where: { id: imageId, taskId } });
  if (!row) {
    const alias = await prisma.resourceLegacyAlias.findUnique({ where: { sourceKind_sourceId: { sourceKind: 'task-image', sourceId: imageId } } });
    const resource = alias ? await prisma.material.findUnique({ where: { id: alias.resourceId }, include: { versions: { where: { revision: 1 }, take: 1 } } }) : null;
    const original = resource?.versions[0];
    if (resource?.sourceTaskId !== taskId || !original?.attachmentPath) throw new DomainError('NOT_FOUND', '图片不存在', 404);
    return { bytes: await readKnowledgeBlob(original.attachmentPath), mimeType: original.mimeType ?? 'application/octet-stream' };
  }
  return { bytes: await readKnowledgeBlob(row.path), mimeType: row.mimeType };
}

export function taskImageResponseHeaders(image: { bytes: Uint8Array; mimeType: string }) {
  return {
    'Content-Type': image.mimeType,
    'Content-Length': String(image.bytes.byteLength),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': 'inline',
  };
}

export async function pruneTaskImages(tx: Db, taskId: string, description: string) {
  const keep = taskImageIds(taskId, description);
  const rows = await tx.taskImage.findMany({ where: { taskId } });
  const drop = rows.filter((row) => !keep.has(row.id));
  if (drop.length) await tx.taskImage.deleteMany({ where: { id: { in: drop.map((row) => row.id) } } });
  return drop.map((row) => row.path);
}

const pendingBlobPaths: string[] = [];

/** Remember hashes to unlink only after the surrounding command transaction commits. */
export function noteUnreferencedBlobs(paths: string[]) {
  if (paths.length) pendingBlobPaths.push(...paths);
}

export function discardPendingBlobs() {
  pendingBlobPaths.length = 0;
}

export async function flushUnreferencedBlobs() {
  if (!pendingBlobPaths.length) return;
  const paths = pendingBlobPaths.splice(0);
  await releaseUnreferencedBlobs(paths);
}

export async function releaseUnreferencedBlobs(paths: string[]) {
  for (const path of new Set(paths)) {
    if (!/^[a-f0-9]{64}$/.test(path)) continue;
    const [images, materials] = await Promise.all([
      prisma.taskImage.count({ where: { path } }),
      prisma.materialVersion.count({ where: { OR: [{ attachmentPath: path }, { sourceOriginalPath: path }] } }),
    ]);
    if (images + materials > 0) continue;
    await unlink(resolve(knowledgeStorageRoot(), path)).catch(() => {});
  }
}
