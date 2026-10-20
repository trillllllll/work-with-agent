import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { prisma } from './infrastructure/prisma.js';
import { sha256 } from './application/auto-memory-types.js';
import { CommandService } from './application/commands.js';
import { OrchestrationService, pauseOrchestration } from './application/orchestration/service.js';
import { internalActor, learningActor, ownerActor, type Actor } from './application/security.js';

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
    const memoryReceipt = receipts.find((receipt) => receipt.actorId === 'orchestration-learning' && receipt.requestId.startsWith(`orch-learning:${project.id}:`));
    const skillReceipt = receipts.find((receipt) => receipt.actorId === 'orchestration-learning' && receipt.requestId.startsWith(`orch-learning-skill:${project.id}:`));
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
    const memory = await prisma.proposal.findFirstOrThrow({ where: { actorId: 'orchestration-learning', commands: { contains: made[2].task.id } } });
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

  it('does not submit again when a receipt already exists under the previous actor id', async () => {
    const { topic, project } = await fixture('旧收据');
    const keyHash = sha256('pause:git_write_denied');
    const createdAt = now();
    await prisma.requestReceipt.create({ data: { actorId: internalActor.id, requestId: `orch-learning:${project.id}:${keyHash}`, requestHash: 'legacy-memory', response: JSON.stringify({ result: { proposalId: 'legacy-memory', status: 'pending_approval' } }), createdAt } });
    await prisma.requestReceipt.create({ data: { actorId: ownerActor.id, requestId: `orch-learning-skill:${project.id}:${keyHash}`, requestHash: 'legacy-skill', response: JSON.stringify({ result: { proposalId: 'legacy-skill', status: 'pending_approval' } }), createdAt } });
    const made = [];
    for (const title of ['一', '二', '三']) made.push(await round(project.id, topic.id, title, 'running'));
    await pauseOrchestration(made[0].row.id, 'git_write_denied', 'locked');
    await pauseOrchestration(made[1].row.id, 'git_write_denied', 'locked');
    await pauseOrchestration(made[2].row.id, 'git_write_denied', 'locked');
    const receipts = await prisma.requestReceipt.findMany({ where: { requestId: { contains: project.id } } });
    expect(receipts.map((receipt) => receipt.actorId).sort()).toEqual([internalActor.id, ownerActor.id].sort());
    expect(await prisma.proposal.count({ where: { commands: { contains: made[2].task.id } } })).toBe(0);
    expect(await prisma.orchestrationEvent.count({ where: { orchestrationId: { in: made.map((item) => item.row.id) }, type: { in: ['learning_suggested', 'learning_suggestion_failed'] } } })).toBe(0);
  });

  it('still submits the missing half when only the old memory receipt exists', async () => {
    const { topic, project } = await fixture('只留旧记忆收据');
    const keyHash = sha256('pause:final_unsatisfied');
    await prisma.requestReceipt.create({ data: { actorId: internalActor.id, requestId: `orch-learning:${project.id}:${keyHash}`, requestHash: 'legacy-memory', response: JSON.stringify({ result: { proposalId: 'legacy-memory-only', status: 'pending_approval' } }), createdAt: now() } });
    const made = [];
    for (const title of ['一', '二', '三']) made.push(await round(project.id, topic.id, title, 'running'));
    await pauseOrchestration(made[0].row.id, 'final_unsatisfied', 'missed');
    await pauseOrchestration(made[1].row.id, 'final_unsatisfied', 'missed');
    await pauseOrchestration(made[2].row.id, 'final_unsatisfied', 'missed');
    const receipts = await prisma.requestReceipt.findMany({ where: { requestId: { contains: project.id } } });
    expect(receipts).toHaveLength(2);
    expect(receipts.find((receipt) => receipt.requestId.startsWith(`orch-learning:${project.id}:`))?.actorId).toBe(internalActor.id);
    const skillReceipt = receipts.find((receipt) => receipt.requestId.startsWith(`orch-learning-skill:${project.id}:`));
    expect(skillReceipt?.actorId).toBe(learningActor.id);
    expect(JSON.parse(skillReceipt!.response).result.status).toBe('pending_approval');
    expect(await prisma.proposal.count({ where: { actorId: learningActor.id, commands: { contains: made[2].task.id } } })).toBe(0);
    expect(await prisma.orchestrationEvent.count({ where: { orchestrationId: made[2].row.id, type: 'learning_suggestion_failed' } })).toBe(0);
  });

  it('lets the owner approve a learning skill proposal and writes the skill', async () => {
    const { topic, project } = await fixture('确认学习技能');
    const made = [];
    for (const title of ['一', '二', '三']) made.push(await round(project.id, topic.id, title, 'running'));
    await pauseOrchestration(made[0].row.id, 'merge_conflict_unresolved', 'conflict');
    await pauseOrchestration(made[1].row.id, 'merge_conflict_unresolved', 'conflict');
    await pauseOrchestration(made[2].row.id, 'merge_conflict_unresolved', 'conflict');
    const skillReceipt = await prisma.requestReceipt.findFirstOrThrow({ where: { actorId: learningActor.id, requestId: { startsWith: `orch-learning-skill:${project.id}:` } } });
    const proposal = await prisma.proposal.findUniqueOrThrow({ where: { id: JSON.parse(skillReceipt.response).result.proposalId } });
    expect(proposal.actorId).toBe('orchestration-learning');
    expect(proposal.status).toBe('pending');
    const skillName = JSON.parse(proposal.commands)[0].input.name as string;
    let skillId = '';
    try {
      const approved = await new CommandService().approve(ownerActor, proposal.id, { requestId: `orch-learning-approve:${proposal.id}`, expectedRevision: proposal.revision });
      expect(approved.status).toBe('applied');
      const skill = await prisma.skill.findFirstOrThrow({ where: { name: skillName, deletedAt: null } });
      skillId = skill.id;
      expect(skill.enabled).toBe(true);
      expect(skill.origin).toBe('assistant');
      expect((await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('executed');
    } finally {
      if (skillId) {
        await prisma.changeRecord.deleteMany({ where: { entityType: 'skill', entityId: skillId } });
        await prisma.skillVersion.deleteMany({ where: { skillId } });
        await prisma.skill.deleteMany({ where: { id: skillId } });
      }
    }
  });

  it('forbids the learning actor from other owner-only commands and forbids a different internal actor from creating skills', async () => {
    const commands = new CommandService();
    const tagName = `学习不得建标签-${randomUUID()}`;
    await expect(commands.submit(learningActor, { requestId: randomUUID(), commands: [{ kind: 'tag.create', input: { name: tagName } }] })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(commands.submit(learningActor, { requestId: randomUUID(), commands: [{ kind: 'task.permanent_delete', targetId: 'missing-task', expectedRevision: 1, input: {} }] })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await prisma.tag.count({ where: { name: tagName } })).toBe(0);
    const imposter: Actor = { id: 'not-orchestration-learning', kind: 'internal', topicIds: 'all', includeInbox: true, autoActions: [], revision: 1 };
    const skillName = `imposter-skill-${randomUUID()}`;
    await expect(commands.submit(imposter, { requestId: randomUUID(), commands: [{ kind: 'skill.create', input: { name: skillName, description: '不应该写入', instructions: '不要执行这条技能' } }] })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await prisma.skill.count({ where: { name: skillName } })).toBe(0);
    expect(await prisma.proposal.count({ where: { actorId: imposter.id } })).toBe(0);
  });
});
