import { afterAll, afterEach } from 'vitest';
import supertest from 'supertest';

// Approving a proposal resumes the run after the response. Let it finish, then
// pause anything still queued so it cannot write into the next test.
// Import prisma lazily: some suites point DATABASE_URL at a scratch file in beforeAll.
afterEach(async () => {
  const { prisma } = await import('../src/infrastructure/prisma.js');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const active = await prisma.agentRun.count({ where: { state: { in: ['queued', 'running'] } } });
    if (!active) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const stuck = await prisma.agentRun.findMany({ where: { state: { in: ['queued', 'running'] } }, select: { id: true } });
  if (!stuck.length) return;
  const now = new Date().toISOString();
  const ids = stuck.map((run) => run.id);
  await prisma.agentRun.updateMany({ where: { id: { in: ids } }, data: { state: 'paused', pauseReason: 'interrupted', leaseToken: null, leaseExpiresAt: null, updatedAt: now } });
  await prisma.conversation.updateMany({ where: { activeRunId: { in: ids } }, data: { activeRunId: null, updatedAt: now } });
});

afterAll(async () => {
  await supertest.closeSharedServers();
});
