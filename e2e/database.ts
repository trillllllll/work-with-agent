import { PrismaClient } from '@prisma/client';

export const e2eDatabase = new PrismaClient({ datasourceUrl: 'file:../../e2e/.data/agent-studio-e2e.db' });

export async function resetE2eDatabase() {
  await e2eDatabase.changeRecord.deleteMany();
  await e2eDatabase.approval.deleteMany();
  await e2eDatabase.message.deleteMany();
  await e2eDatabase.conversation.deleteMany();
  await e2eDatabase.task.deleteMany();
  await e2eDatabase.topic.deleteMany();
  await e2eDatabase.appSetting.deleteMany();
}
