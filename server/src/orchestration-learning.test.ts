import { afterAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import { OrchestrationService, pauseOrchestration } from './application/orchestration/service.js';

void app;

const now = () => new Date().toISOString();
const orchIds: string[] = [];
const taskIds: string[] = [];
const topicIds: string[] = [];
const projectIds: string[] = [];

async function fixture(name: string) {
  const topic = await prisma.topic.create({ data: { name, createdAt: now(), updatedAt: now() } });
  topicIds.push(topic.id);
  const project = await prisma.project.create({ data: { name, createdAt: now(), updatedAt: now() } });
  projectIds.push(project.id);
  return { topic, project };
}

async function round(projectId: string, topicId: string | null, title: string, status: string) {
  const task = await prisma.task.create({ data: { title, topicId, createdAt: now(), updatedAt: now() } });
  taskIds.push(task.id);
  const row = await prisma.orchestration.create({ data: { taskId: task.id, round: 1, status, projectId, integrationBranch: `orch/${task.id.slice(-8)}-r1`, createdAt: now(), updatedAt: now() } });
  orchIds.push(row.id);
  return { task, row };
}

afterAll(async () => {
  const receipts = await prisma.requestReceipt.findMany({ where: { requestId: { startsWith: 'orch-learning' } } });
  const proposalIds = receipts.map((receipt) => {
    try { return (JSON.parse(receipt.response) as { result?: { proposalId?: string } }).result?.proposalId ?? null; } catch { return null; }
  }).filter((id): id is string => !!id);
  if (proposalIds.length) await prisma.memorySuggestionKey.deleteMany({ where: { proposalId: { in: proposalIds } } });
  await prisma.requestReceipt.deleteMany({ where: { requestId: { startsWith: 'orch-learning' } } });
  if (proposalIds.length) await prisma.proposal.deleteMany({ where: { id: { in: proposalIds } } });
  const skills = await prisma.skill.findMany({ where: { name: { startsWith: 'dispatch-checklist-' } }, select: { id: true } });
  if (skills.length) {
    await prisma.skillVersion.deleteMany({ where: { skillId: { in: skills.map((skill) => skill.id) } } });
    await prisma.skill.deleteMany({ where: { id: { in: skills.map((skill) => skill.id) } } });
  }
  await prisma.orchestrationEvent.deleteMany({ where: { orchestrationId: { in: orchIds } } });
  await prisma.orchestration.deleteMany({ where: { id: { in: orchIds } } });
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
});

describe('orchestration learning suggestions', () => {
  it('creates one pending memory proposal and one pending skill proposal on the third pause, and none on the fourth', async () => {
    const { topic, project } = await fixture('反复合入失败');
    const made = [];
    for (const title of ['第一次', '第二次', '第三次']) made.push(await round(project.id, topic.id, title, 'running'));
    await prisma.task.update({ where: { id: made[2].task.id }, data: { revision: 5 } });
    await pauseOrchestration(made[0].row.id, 'merge_tests_failed', 'npm test failed');
    await pauseOrchestration(made[1].row.id, 'merge_tests_failed', 'npm test failed again');
    expect(await prisma.requestReceipt.count({ where: { requestId: { contains: project.id } } })).toBe(0);
    await pauseOrchestration(made[2].row.id, 'merge_tests_failed', 'npm test failed third');
    const receipts = await prisma.requestReceipt.findMany({ where: { requestId: { contains: project.id } } });
    expect(receipts).toHaveLength(2);
    const memoryReceipt = receipts.find((receipt) => receipt.actorId === 'builtin-agent' && receipt.requestId.startsWith('orch-learning:'));
    const skillReceipt = receipts.find((receipt) => receipt.actorId === 'local-owner' && receipt.requestId.startsWith('orch-learning-skill:'));
    expect(memoryReceipt).toBeTruthy();
    expect(skillReceipt).toBeTruthy();
    expect(JSON.parse(skillReceipt!.response).result.status).toBe('pending_approval');
    expect(JSON.parse(memoryReceipt!.response).result.status).toBe('pending_approval');
    expect(await prisma.skill.count({ where: { name: { startsWith: 'dispatch-checklist-' } } })).toBe(0);
    const memory = await prisma.proposal.findUniqueOrThrow({ where: { id: JSON.parse(memoryReceipt!.response).result.proposalId } });
    expect(memory.status).toBe('pending');
    const command = JSON.parse(memory.commands)[0];
    expect(command.kind).toBe('memory.create');
    expect(command.input.kind).toBe('learning');
    expect(command.input.importance).toBe(3);
    expect(command.input.labels).toEqual(['orchestration']);
    expect(command.input.evidence).toEqual([{ type: 'task', id: made[2].task.id, revision: 5 }]);
    expect(command.input.title).toContain('合入测试失败');
    expect(command.input.content).toContain('有 3 轮');
    expect(command.input.content).toContain('第三次');
    const suggested = await prisma.orchestrationEvent.findMany({ where: { orchestrationId: made[2].row.id, type: 'learning_suggested' } });
    expect(suggested).toHaveLength(1);
    expect(JSON.parse(suggested[0].payload)).toMatchObject({ key: 'pause:merge_tests_failed', count: 3 });
    const fourth = await round(project.id, topic.id, '第四次', 'running');
    await pauseOrchestration(fourth.row.id, 'merge_tests_failed', 'npm test failed fourth');
    expect(await prisma.requestReceipt.count({ where: { requestId: { contains: project.id } } })).toBe(2);
    expect(await prisma.orchestrationEvent.count({ where: { orchestrationId: { in: [...made.map((item) => item.row.id), fourth.row.id] }, type: 'learning_suggested' } })).toBe(1);
    expect(await prisma.orchestrationEvent.count({ where: { orchestrationId: { in: [...made.map((item) => item.row.id), fourth.row.id] }, type: 'learning_suggestion_failed' } })).toBe(0);
    expect(JSON.parse((await prisma.proposal.findUniqueOrThrow({ where: { id: memory.id } })).commands)[0].input.content).toContain('有 3 轮');
  });

  it('does not learn from rate limits or a user pause', async () => {
    const { topic, project } = await fixture('限流不学习');
    const ids: string[] = [];
    for (const title of ['A', 'B', 'C']) {
      const made = await round(project.id, topic.id, title, 'running');
      ids.push(made.row.id);
      await pauseOrchestration(made.row.id, 'rate_limited', 'slow down');
    }
    const user = await round(project.id, topic.id, '用户暂停', 'running');
    ids.push(user.row.id);
    await new OrchestrationService().pause(user.row.id);
    expect(await prisma.requestReceipt.count({ where: { requestId: { contains: project.id } } })).toBe(0);
    expect(await prisma.orchestrationEvent.count({ where: { orchestrationId: { in: ids }, type: { in: ['learning_suggested', 'learning_suggestion_failed'] } } })).toBe(0);
    const paused = await prisma.orchestrationEvent.findFirstOrThrow({ where: { orchestrationId: user.row.id, type: 'paused' } });
    expect(JSON.parse(paused.payload).reason).toBe('user_paused');
  });

  it('treats normalized rejection reasons as the same signal', async () => {
    const { topic, project } = await fixture('打回归一');
    const service = new OrchestrationService();
    const reasons = ['Hello\u3000World', '  hello   world  ', 'ＨＥＬＬＯ\u3000ＷＯＲＬＤ'];
    const made = [];
    for (const [index, reason] of reasons.entries()) {
      const item = await round(project.id, topic.id, `打回${index}`, 'awaiting_acceptance');
      made.push(item);
      if (index === 2) await prisma.task.update({ where: { id: item.task.id }, data: { revision: 4 } });
      if (index === 0) await expect(service.reject(item.row.id, {})).rejects.toMatchObject({ code: 'REASON_REQUIRED', status: 400 });
      await service.reject(item.row.id, { reason });
    }
    const receipts = await prisma.requestReceipt.findMany({ where: { requestId: { contains: project.id } } });
    expect(receipts).toHaveLength(2);
    const memory = await prisma.proposal.findFirstOrThrow({ where: { actorId: 'builtin-agent', commands: { contains: made[2].task.id } } });
    expect(JSON.parse(memory.commands)[0].input.evidence).toEqual([{ type: 'task', id: made[2].task.id, revision: 4 }]);
    expect(JSON.parse(memory.commands)[0].input.content).toContain('hello world');
    const again = await round(project.id, topic.id, '再打回', 'awaiting_acceptance');
    await service.reject(again.row.id, { reason: 'hello    world' });
    expect(await prisma.requestReceipt.count({ where: { requestId: { contains: project.id } } })).toBe(2);
    expect(await prisma.skill.count({ where: { name: { contains: project.id.slice(0, 4) } } })).toBe(0);
    expect(await prisma.orchestrationEvent.count({ where: { orchestrationId: { in: [...made.map((item) => item.row.id), again.row.id] }, type: 'learning_suggestion_failed' } })).toBe(0);
  });

  it('does not throw when creating the suggestion fails', async () => {
    const { topic, project } = await fixture('建议失败');
    const made = [];
    for (const title of ['A', 'B', 'C']) made.push(await round(project.id, topic.id, title, 'running'));
    await pauseOrchestration(made[0].row.id, 'develop_failed', 'once');
    await pauseOrchestration(made[1].row.id, 'develop_failed', 'twice');
    await prisma.topic.update({ where: { id: topic.id }, data: { archivedAt: now() } });
    await expect(pauseOrchestration(made[2].row.id, 'develop_failed', 'third')).resolves.toMatchObject({ status: 'paused' });
    const failed = await prisma.orchestrationEvent.findMany({ where: { orchestrationId: made[2].row.id, type: 'learning_suggestion_failed' } });
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0].payload).error).toContain('已归档');
    expect(await prisma.proposal.count({ where: { commands: { contains: made[2].task.id } } })).toBe(0);
    expect((await prisma.orchestration.findUniqueOrThrow({ where: { id: made[2].row.id } })).status).toBe('paused');
  });
});
