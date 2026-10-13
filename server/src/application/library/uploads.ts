import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../infrastructure/prisma.js';
import type { Actor } from '../security.js';
import { libraryError, libraryNow, type LibraryDb } from './access.js';

export const uploadByteLimit = 104_857_600;
const day = 24 * 60 * 60 * 1000;

export function uploadRoot() {
  return path.resolve(process.env.LIBRARY_UPLOAD_ROOT || fileURLToPath(new URL('../../../data/library-uploads', import.meta.url)));
}

const contentKeyPattern = /^[0-9a-f-]{36}(\.[0-9a-f-]{36})?$/i;
const receiveLeaseMs = 120_000;
const renewEveryMs = 30_000;
const activeBodies = new Map<string, Readable>();

export type ReceiveReceipt = { uploadId: string; token: string; contentKey: string };

/** True when candidate stays inside root on the supplied path implementation. */
export function isContainedPath(root: string, candidate: string, pathApi: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path) {
  const relativePath = pathApi.relative(root, candidate);
  if (!relativePath || relativePath === '.') return false;
  if (pathApi.isAbsolute(relativePath)) return false;
  return !relativePath.split(pathApi.sep).includes('..');
}

export function containedUploadPath(root: string, name: string, pathApi: typeof path = path) {
  if (!contentKeyPattern.test(name)) throw libraryError('NOT_FOUND', '上传不存在', 404);
  const candidate = pathApi.resolve(root, name);
  if (!isContainedPath(root, candidate, pathApi)) throw libraryError('NOT_FOUND', '上传不存在', 404);
  return candidate;
}

export function uploadPath(id: string) {
  return containedUploadPath(uploadRoot(), id);
}

function ownerOnly(actor: Actor) {
  if (actor.kind !== 'user') throw libraryError('OWNER_REQUIRED', '只有本机用户可以上传文件', 403);
}

export async function openUpload(actor: Actor, input: { requestKey: string; fileName: string; mimeType: string; size: number }) {
  ownerOnly(actor);
  if (!Number.isInteger(input.size) || input.size < 0) throw libraryError('VALIDATION_ERROR', '文件大小无效', 400);
  if (input.size > uploadByteLimit) throw libraryError('UPLOAD_TOO_LARGE', '单个文件不能超过 100 MiB', 413);
  if (!input.requestKey || input.requestKey.length > 200) throw libraryError('VALIDATION_ERROR', '请求标识无效', 400);
  if (!input.fileName || input.fileName.length > 255) throw libraryError('VALIDATION_ERROR', '文件名无效', 400);
  if (!input.mimeType || input.mimeType.length > 150) throw libraryError('VALIDATION_ERROR', '文件类型无效', 400);
  const existing = await prisma.libraryUpload.findUnique({ where: { actorId_requestKey: { actorId: actor.id, requestKey: input.requestKey } } });
  if (existing) {
    if (existing.fileName !== input.fileName || existing.mimeType !== input.mimeType || existing.declaredSize !== input.size) throw libraryError('IDEMPOTENCY_CONFLICT', '相同请求标识不能用于不同文件');
    return existing;
  }
  const timestamp = libraryNow();
  return prisma.libraryUpload.create({ data: {
    id: randomUUID(), actorId: actor.id, requestKey: input.requestKey, fileName: input.fileName, mimeType: input.mimeType,
    declaredSize: input.size, state: 'pending', createdAt: timestamp, updatedAt: timestamp, expiresAt: new Date(Date.now() + day).toISOString(),
  } });
}

export async function readOwnUpload(actor: Actor, id: string) {
  ownerOnly(actor);
  const upload = await prisma.libraryUpload.findUnique({ where: { id } });
  if (!upload || upload.actorId !== actor.id) throw libraryError('NOT_FOUND', '上传不存在', 404);
  return upload;
}

export async function beginReceive(actor: Actor, id: string) {
  const upload = await readOwnUpload(actor, id);
  if (upload.expiresAt < libraryNow() && upload.state !== 'committed') throw libraryError('UPLOAD_EXPIRED', '上传已过期');
  if (upload.state === 'ready') return { upload, already: true as const };
  if (upload.state === 'committed') throw libraryError('UPLOAD_ALREADY_COMMITTED', '上传已经保存为资料');
  if (upload.state === 'cancelled') throw libraryError('UPLOAD_CANCELLED', '上传已取消');
  if (upload.state === 'receiving' && upload.receiveLeaseUntil && upload.receiveLeaseUntil > libraryNow()) throw libraryError('UPLOAD_IN_PROGRESS', '上传正在接收');
  const token = randomUUID();
  const contentKey = `${id}.${token}`;
  const now = libraryNow();
  const claimed = await prisma.libraryUpload.updateMany({
    where: {
      id,
      actorId: actor.id,
      OR: [
        { state: { in: ['pending', 'failed'] } },
        { state: 'receiving', receiveLeaseUntil: null },
        { state: 'receiving', receiveLeaseUntil: { lt: now } },
      ],
    },
    data: { state: 'receiving', leaseToken: token, receiveLeaseUntil: new Date(Date.now() + receiveLeaseMs).toISOString(), contentKey, actualSize: null, sha256: null, errorCode: null, updatedAt: now },
  });
  if (!claimed.count) throw libraryError('UPLOAD_IN_PROGRESS', '上传正在接收');
  const updated = await prisma.libraryUpload.findUniqueOrThrow({ where: { id } });
  return { upload: updated, already: false as const, receipt: { uploadId: id, token, contentKey } satisfies ReceiveReceipt };
}

export async function writeUploadBody(receipt: ReceiveReceipt, declaredSize: number, source: Readable) {
  await mkdir(uploadRoot(), { recursive: true });
  const file = containedUploadPath(uploadRoot(), receipt.contentKey);
  const hash = createHash('sha256');
  let size = 0;
  let tooLarge = false;
  activeBodies.set(receipt.token, source);
  const renew = setInterval(() => {
    void prisma.libraryUpload.updateMany({
      where: { id: receipt.uploadId, state: 'receiving', leaseToken: receipt.token },
      data: { receiveLeaseUntil: new Date(Date.now() + receiveLeaseMs).toISOString(), updatedAt: libraryNow() },
    }).catch(() => undefined);
  }, renewEveryMs);
  renew.unref();
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > uploadByteLimit) { tooLarge = true; callback(Object.assign(new Error('limit'), { code: 'UPLOAD_TOO_LARGE' })); return; }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, counter, createWriteStream(file, { flags: 'wx' }));
  } catch (error) {
    await rm(file, { force: true }).catch(() => undefined);
    if (tooLarge || (error as { code?: string }).code === 'UPLOAD_TOO_LARGE') throw libraryError('UPLOAD_TOO_LARGE', '单个文件不能超过 100 MiB', 413);
    if ((error as { code?: string }).code === 'UPLOAD_CANCELLED') throw libraryError('UPLOAD_CANCELLED', '上传已取消');
    throw error;
  } finally {
    clearInterval(renew);
    activeBodies.delete(receipt.token);
  }
  return { actualSize: size, sha256: hash.digest('hex'), declaredSize };
}

export async function finishReceive(actor: Actor, receipt: ReceiveReceipt, body: { actualSize: number; sha256: string }) {
  const upload = await readOwnUpload(actor, receipt.uploadId);
  const file = containedUploadPath(uploadRoot(), receipt.contentKey);
  if (body.actualSize !== upload.declaredSize) {
    const failed = await prisma.libraryUpload.updateMany({
      where: { id: receipt.uploadId, state: 'receiving', leaseToken: receipt.token },
      data: { state: 'failed', errorCode: 'UPLOAD_SIZE_MISMATCH', actualSize: body.actualSize, leaseToken: null, receiveLeaseUntil: null, updatedAt: libraryNow() },
    });
    await rm(file, { force: true }).catch(() => undefined);
    if (!failed.count) throw libraryError('UPLOAD_STALE_ATTEMPT', '上传接收已失效');
    throw libraryError('UPLOAD_SIZE_MISMATCH', '实际上传大小与声明不一致', 422);
  }
  const updated = await prisma.libraryUpload.updateMany({
    where: { id: receipt.uploadId, state: 'receiving', leaseToken: receipt.token },
    data: { state: 'ready', actualSize: body.actualSize, sha256: body.sha256, errorCode: null, leaseToken: null, receiveLeaseUntil: null, updatedAt: libraryNow() },
  });
  if (!updated.count) {
    const current = await prisma.libraryUpload.findUnique({ where: { id: receipt.uploadId } });
    if (!(current?.state === 'ready' && current.contentKey === receipt.contentKey)) await rm(file, { force: true }).catch(() => undefined);
    throw libraryError('UPLOAD_STALE_ATTEMPT', '上传接收已失效');
  }
  return prisma.libraryUpload.findUniqueOrThrow({ where: { id: receipt.uploadId } });
}

export async function failReceive(id: string, errorCode: string, token?: string) {
  await prisma.libraryUpload.updateMany({
    where: { id, state: 'receiving', ...(token ? { leaseToken: token } : {}) },
    data: { state: 'failed', errorCode, leaseToken: null, receiveLeaseUntil: null, updatedAt: libraryNow() },
  });
}

async function removeStaging(upload: { id: string; contentKey: string | null }) {
  for (const key of new Set([upload.contentKey, upload.id].filter((key): key is string => Boolean(key)))) {
    if (!contentKeyPattern.test(key)) continue;
    await rm(containedUploadPath(uploadRoot(), key), { force: true }).catch(() => undefined);
  }
}

export async function cancelUpload(actor: Actor, id: string) {
  const upload = await readOwnUpload(actor, id);
  if (upload.state === 'committed') throw libraryError('UPLOAD_ALREADY_COMMITTED', '上传已经保存为资料');
  if (upload.state === 'cancelled') return { cancelled: true };
  const token = upload.leaseToken;
  const cancelled = await prisma.libraryUpload.updateMany({
    where: { id, actorId: actor.id, state: { not: 'committed' } },
    data: { state: 'cancelled', leaseToken: null, receiveLeaseUntil: null, updatedAt: libraryNow() },
  });
  if (!cancelled.count) throw libraryError('UPLOAD_ALREADY_COMMITTED', '上传已经保存为资料');
  if (token) {
    const body = activeBodies.get(token);
    body?.destroy(Object.assign(new Error('cancelled'), { code: 'UPLOAD_CANCELLED' }));
  }
  await removeStaging(upload);
  return { cancelled: true };
}

export async function recoverInterruptedUploads() {
  await prisma.libraryUpload.updateMany({ where: { state: 'receiving' }, data: { state: 'failed', errorCode: 'UPLOAD_INTERRUPTED', leaseToken: null, receiveLeaseUntil: null, updatedAt: libraryNow() } });
}

export async function readUploadBytes(tx: LibraryDb, id: string) {
  const upload = await tx.libraryUpload.findUnique({ where: { id } });
  return readFile(containedUploadPath(uploadRoot(), upload?.contentKey || id));
}
