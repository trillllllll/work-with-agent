import type { Prisma, PrismaClient } from '@prisma/client';
import { DomainError } from '../../domain/task.js';
import { assertTopicAccess, type Actor } from '../security.js';

export type LibraryDb = Prisma.TransactionClient | PrismaClient;
export const libraryNow = () => new Date().toISOString();
export const libraryError = (code: string, message: string, status = 409) => new DomainError(code, message, status);

export function topicVisible(actor: Actor, topicId: string | null) {
  if (topicId === null) return actor.includeInbox;
  return actor.topicIds === 'all' || actor.topicIds.includes(topicId);
}

export async function assertWritableTopic(tx: LibraryDb, actor: Actor, topicId: string | null) {
  assertTopicAccess(actor, topicId);
  if (!topicId) return null;
  const topic = await tx.topic.findUnique({ where: { id: topicId } });
  if (!topic) throw libraryError('NOT_FOUND', '清单不存在', 404);
  if (topic.archivedAt) throw libraryError('TOPIC_ARCHIVED', '已归档清单不能修改');
  return topic;
}

export async function readableMaterial(tx: LibraryDb, actor: Actor, id: string) {
  const material = await tx.material.findUnique({ where: { id } });
  if (!material) throw libraryError('NOT_FOUND', '资料不存在', 404);
  if (!topicVisible(actor, material.topicId)) throw libraryError('SCOPE_DENIED', '资料不在授权范围内', 403);
  return material;
}

export async function writableMaterial(tx: LibraryDb, actor: Actor, id: string) {
  const material = await readableMaterial(tx, actor, id);
  await assertWritableTopic(tx, actor, material.topicId);
  return material;
}

export function assertExpected(actual: number, expected: number | undefined, message = '内容已经变化，请刷新后重试') {
  if (!Number.isInteger(expected) || actual !== expected) throw libraryError('VERSION_CONFLICT', message);
}
