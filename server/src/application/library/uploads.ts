import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
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
  return resolve(process.env.LIBRARY_UPLOAD_ROOT || fileURLToPath(new URL('../../../data/library-uploads', import.meta.url)));
}

export function uploadPath(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw libraryError('NOT_FOUND', '上传不存在', 404);
  const root = uploadRoot();
  const path = resolve(root, id);
  if (!path.startsWith(`${root}/`)) throw libraryError('NOT_FOUND', '上传不存在', 404);
  return path;
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
  const updated = await prisma.libraryUpload.update({ where: { id }, data: { state: 'receiving', errorCode: null, updatedAt: libraryNow() } });
  return { upload: updated, already: false as const };
}

export async function writeUploadBody(id: string, declaredSize: number, source: Readable) {
  await mkdir(uploadRoot(), { recursive: true });
  const hash = createHash('sha256');
  let size = 0;
  let tooLarge = false;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > uploadByteLimit) { tooLarge = true; callback(Object.assign(new Error('limit'), { code: 'UPLOAD_TOO_LARGE' })); return; }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, counter, createWriteStream(uploadPath(id), { flags: 'w' }));
  } catch (error) {
    await rm(uploadPath(id), { force: true }).catch(() => undefined);
    if (tooLarge || (error as { code?: string }).code === 'UPLOAD_TOO_LARGE') throw libraryError('UPLOAD_TOO_LARGE', '单个文件不能超过 100 MiB', 413);
    throw error;
  }
  return { actualSize: size, sha256: hash.digest('hex'), declaredSize };
}

export async function finishReceive(actor: Actor, id: string, body: { actualSize: number; sha256: string }) {
  const upload = await readOwnUpload(actor, id);
  if (upload.state === 'ready' && upload.sha256) return upload;
  if (body.actualSize !== upload.declaredSize) {
    await prisma.libraryUpload.update({ where: { id }, data: { state: 'failed', errorCode: 'UPLOAD_SIZE_MISMATCH', actualSize: body.actualSize, updatedAt: libraryNow() } });
    await rm(uploadPath(id), { force: true }).catch(() => undefined);
    throw libraryError('UPLOAD_SIZE_MISMATCH', '实际上传大小与声明不一致', 422);
  }
  return prisma.libraryUpload.update({ where: { id }, data: { state: 'ready', actualSize: body.actualSize, sha256: body.sha256, errorCode: null, updatedAt: libraryNow() } });
}

export async function failReceive(id: string, errorCode: string) {
  await prisma.libraryUpload.updateMany({ where: { id, state: { in: ['pending', 'receiving'] } }, data: { state: 'failed', errorCode, updatedAt: libraryNow() } });
}

export async function cancelUpload(actor: Actor, id: string) {
  const upload = await readOwnUpload(actor, id);
  if (upload.state === 'committed') throw libraryError('UPLOAD_ALREADY_COMMITTED', '上传已经保存为资料');
  if (upload.state === 'cancelled') return { cancelled: true };
  await prisma.libraryUpload.update({ where: { id }, data: { state: 'cancelled', updatedAt: libraryNow() } });
  await rm(uploadPath(id), { force: true }).catch(() => undefined);
  return { cancelled: true };
}

export async function recoverInterruptedUploads() {
  await prisma.libraryUpload.updateMany({ where: { state: 'receiving' }, data: { state: 'failed', errorCode: 'UPLOAD_INTERRUPTED', leaseToken: null, updatedAt: libraryNow() } });
}

export async function readUploadBytes(tx: LibraryDb, id: string) {
  return readFile(uploadPath(id));
}
