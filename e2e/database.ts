import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

export const e2eDatabase = new PrismaClient({ datasourceUrl: process.env.E2E_DATABASE_URL ?? 'file:../../e2e/.data/agent-studio-e2e.db' });

export async function resetE2eDatabase() {
  await e2eDatabase.planTimeBand.deleteMany();
  // 学习域：先动态后节点再地图，遵守外键顺序。
  await e2eDatabase.learningActivity.deleteMany();
  await e2eDatabase.learningNode.updateMany({ data: { parentId: null } });
  await e2eDatabase.learningNode.deleteMany();
  await e2eDatabase.learningMap.deleteMany();
  for (const name of ['worktreeCleanup', 'orchestrationEvent', 'nodeJob', 'orchestrationStep', 'orchestration', 'projectBinding', 'projectLocation', 'project', 'agentNode', 'memorySuggestionKey', 'autoMemoryJob', 'autoMemorySource', 'autoMemoryTurn', 'autoMemoryScope', 'librarySearchPosting', 'librarySearchNormMap', 'librarySearchDocument', 'materialChunk', 'materialExtraction', 'materialTag', 'materialTaskLink', 'libraryAnswer', 'libraryUpload', 'codeApplication', 'handoffReview', 'artifact', 'runEvent', 'run', 'handoff', 'reviewBatch', 'reviewRule', 'organizationRequest', 'workingBrief', 'graphLink', 'entity', 'memoryVersion', 'memory', 'materialVersion', 'material', 'requestReceipt', 'proposal', 'connection'] as const) await e2eDatabase[name].deleteMany();
  const folders = await e2eDatabase.libraryFolder.findMany({ select: { id: true, parentId: true } });
  const pending = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  while (pending.size) {
    const leaves = [...pending].filter(([id]) => ![...pending.values()].includes(id)).map(([id]) => id);
    if (!leaves.length) break;
    await e2eDatabase.libraryFolder.deleteMany({ where: { id: { in: leaves } } });
    for (const id of leaves) pending.delete(id);
  }
  await e2eDatabase.libraryTag.deleteMany();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const token = 'wwa-e2e-owner-session';
  await e2eDatabase.localSession.upsert({ where: { id: 'e2e-owner' }, create: { id: 'e2e-owner', tokenHash: hash(token), csrfHash: hash(hash(`csrf:${token}`)), expiresAt: '2099-01-01T00:00:00.000Z', createdAt: new Date().toISOString() }, update: {} });
  await e2eDatabase.changeRecord.deleteMany();
  await e2eDatabase.approval.deleteMany();
  await e2eDatabase.skillVersion.deleteMany();
  await e2eDatabase.skill.deleteMany();
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
