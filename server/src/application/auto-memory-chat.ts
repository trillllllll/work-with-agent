import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { createAutoChatMaterial } from './knowledge.js';
import { readJson, splitCodePoints, SOURCE_PART_CHARS } from './auto-memory-types.js';

export async function beginAutoMemoryTurn(input: { conversationId: string; userMessageId: string; topicId: string | null; createdAt: string }) {
  const existing = await prisma.autoMemoryTurn.findUnique({ where: { id: input.userMessageId } });
  if (existing) return existing;
  return prisma.autoMemoryTurn.create({
    data: {
      id: input.userMessageId,
      conversationId: input.conversationId,
      topicId: input.topicId,
      userMessageId: input.userMessageId,
      assistantMessageIds: '[]',
      status: 'collecting',
      materialIds: '[]',
      createdAt: input.createdAt,
    },
  });
}

export async function appendAutoMemoryAssistant(userMessageId: string, assistantMessageId: string) {
  const turn = await prisma.autoMemoryTurn.findUnique({ where: { id: userMessageId } });
  if (!turn || turn.status !== 'collecting') return;
  const ids = readJson<string[]>(turn.assistantMessageIds, []);
  if (ids.includes(assistantMessageId)) return;
  ids.push(assistantMessageId);
  await prisma.autoMemoryTurn.update({ where: { id: turn.id }, data: { assistantMessageIds: JSON.stringify(ids) } });
}

export async function completeAutoMemoryTurn(userMessageId: string, completedAt: string) {
  await prisma.autoMemoryTurn.updateMany({ where: { id: userMessageId, status: 'collecting' }, data: { status: 'completed', completedAt } });
}

export async function failAutoMemoryTurn(userMessageId: string, completedAt: string) {
  await prisma.autoMemoryTurn.updateMany({ where: { id: userMessageId, status: 'collecting' }, data: { status: 'failed', completedAt } });
}

/** Leftover collecting rows belong to a process that did not finish the turn. */
export async function failCollectingTurns(completedAt: string) {
  await prisma.autoMemoryTurn.updateMany({ where: { status: 'collecting' }, data: { status: 'failed', completedAt } });
}

function excerptText(user: string, assistants: string[]) {
  const parts = [`用户\n\n${user}`];
  for (const content of assistants) parts.push(`助手\n\n${content}`);
  return parts.join('\n\n');
}

/** Archive completed turns that do not yet have excerpt materials. Idempotent for the same turn. */
export async function archiveCompletedTurns() {
  const turns = await prisma.autoMemoryTurn.findMany({ where: { status: 'completed', materialIds: '[]' }, orderBy: { createdAt: 'asc' } });
  for (const turn of turns) {
    const user = await prisma.message.findUnique({ where: { id: turn.userMessageId } });
    if (!user || user.role !== 'user') {
      await prisma.autoMemoryTurn.update({ where: { id: turn.id }, data: { status: 'failed' } });
      continue;
    }
    const assistantIds = readJson<string[]>(turn.assistantMessageIds, []);
    const assistants: string[] = [];
    const messageIds = [user.id];
    for (const id of assistantIds) {
      const message = await prisma.message.findUnique({ where: { id } });
      if (!message || message.role !== 'assistant' || message.status !== 'completed') continue;
      assistants.push(message.content);
      messageIds.push(message.id);
    }
    const text = excerptText(user.content, assistants);
    if (!text.trim()) {
      await prisma.autoMemoryTurn.update({ where: { id: turn.id }, data: { status: 'failed' } });
      continue;
    }
    const segments = splitCodePoints(text, SOURCE_PART_CHARS);
    const materialIds: string[] = [];
    try {
      for (let part = 0; part < segments.length; part += 1) {
        const materialId = `auto-chat:${turn.userMessageId}:${part}`;
        await createAutoChatMaterial({
          materialId,
          topicId: turn.topicId,
          title: `聊天摘录 · ${turn.userMessageId} · ${part + 1}`,
          content: segments[part],
          metadata: {
            provider: 'builtin',
            sessionId: turn.conversationId,
            messageIds,
            completeness: 'excerpt',
            autoMemoryTurnId: turn.id,
            part,
            partCount: segments.length,
          },
        });
        materialIds.push(materialId);
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'TOPIC_ARCHIVED') continue;
      throw error;
    }
    const saved = await prisma.autoMemoryTurn.updateMany({ where: { id: turn.id, materialIds: '[]' }, data: { materialIds: JSON.stringify(materialIds) } });
    if (!saved.count) {
      const current = await prisma.autoMemoryTurn.findUnique({ where: { id: turn.id } });
      const stored = current ? readJson<string[]>(current.materialIds, []) : [];
      if (stored.length && stored.every((id) => materialIds.includes(id))) continue;
    }
  }
}
