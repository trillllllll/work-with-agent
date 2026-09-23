import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

export const e2eDatabase = new PrismaClient({ datasourceUrl: 'file:../../e2e/.data/agent-studio-e2e.db' });

export async function resetE2eDatabase() {
  for (const name of ['codeApplication', 'handoffReview', 'artifact', 'runEvent', 'run', 'handoff', 'reviewBatch', 'reviewRule', 'organizationRequest', 'workingBrief', 'graphLink', 'entity', 'memoryVersion', 'memory', 'materialVersion', 'material', 'requestReceipt', 'proposal', 'connection'] as const) await e2eDatabase[name].deleteMany();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const token = 'wwa-e2e-owner-session';
  await e2eDatabase.localSession.upsert({ where: { id: 'e2e-owner' }, create: { id: 'e2e-owner', tokenHash: hash(token), csrfHash: hash(hash(`csrf:${token}`)), expiresAt: '2099-01-01T00:00:00.000Z', createdAt: new Date().toISOString() }, update: {} });
  await e2eDatabase.changeRecord.deleteMany();
  await e2eDatabase.approval.deleteMany();
  await e2eDatabase.message.deleteMany();
  await e2eDatabase.conversation.deleteMany();
  await e2eDatabase.taskTag.deleteMany();
  await e2eDatabase.taskTopicAssignment.deleteMany();
  await e2eDatabase.task.updateMany({ data: { parentId: null } });
  await e2eDatabase.task.deleteMany();
  await e2eDatabase.tag.deleteMany();
  await e2eDatabase.topic.deleteMany();
  await e2eDatabase.appSetting.deleteMany();
}
