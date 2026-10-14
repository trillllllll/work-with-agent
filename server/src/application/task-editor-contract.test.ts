import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from '../test-auth.js';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { CommandService } from './commands.js';
import { ownerActor } from './security.js';

const commands = new CommandService();

async function clean() {
  await prisma.materialChunk.deleteMany();
  await prisma.materialExtraction.deleteMany();
  await prisma.materialTaskLink.deleteMany();
  await prisma.materialVersion.deleteMany();
  await prisma.material.deleteMany();
  await prisma.requestReceipt.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.changeRecord.deleteMany();
  await prisma.taskTag.deleteMany();
  await prisma.taskTopicAssignment.deleteMany();
  await prisma.task.updateMany({ data: { parentId: null } });
  await prisma.task.deleteMany();
  await prisma.topic.deleteMany();
}

async function makeTask(title: string, body: Record<string, unknown> = {}) {
  const response = await request(app).post('/api/tasks').send({ title, ...body });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { id: string; revision: number; status: string; title: string; description: string };
}

async function makeMaterial(title: string) {
  const result = await commands.submit(ownerActor, { requestId: randomUUID(), commands: [{ kind: 'material.create', input: { title, kind: 'text', content: `# ${title}\n正文` } }] });
  expect(result.status).toBe('applied');
  const row = await prisma.material.findUnique({ where: { id: result.results[0].id } });
  expect(row).not.toBeNull();
  return { id: row!.id, revision: row!.revision, organizationRevision: row!.organizationRevision, title: row!.title };
}

function citation(materialId: string, label: string) {
  return `[${label.replace(/\\/g, '\\\\').replace(/[[\]]/g, (ch) => `\\${ch}`)}](wwa-material:${encodeURIComponent(materialId)})`;
}

afterAll(async () => { await clean(); await prisma.$disconnect(); });

describe('task text auto-save contract', () => {
  beforeEach(clean);

  it('纯文字更新子任务不触碰父任务，也不要求关联变更确认', async () => {
    const parent = await makeTask('父任务');
    const child = await makeTask('子任务', { parentId: parent.id });
    const childRow = await prisma.task.findUnique({ where: { id: child.id } });
    const parentRow = await prisma.task.findUnique({ where: { id: parent.id } });

    const response = await request(app).patch(`/api/tasks/${child.id}`).send({ description: '子任务的新正文' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.code).not.toBe('PREVIEW_REQUIRED');

    const nextChild = await prisma.task.findUnique({ where: { id: child.id } });
    const nextParent = await prisma.task.findUnique({ where: { id: parent.id } });
    expect(nextChild!.revision).toBe(childRow!.revision + 1);
    expect(nextChild!.description).toBe('子任务的新正文');
    expect(nextParent!.revision).toBe(parentRow!.revision);
    expect(nextParent!.status).toBe(parentRow!.status);
    expect(response.body.meta.affectedTaskIds).toEqual([child.id]);
    expect(response.body.meta.affectedTaskIds).not.toContain(parent.id);
  });

  it('纯文字更新与现值相同时不增加 revision，也不新增变更记录', async () => {
    const item = await makeTask('稳定任务');
    await request(app).patch(`/api/tasks/${item.id}`).send({ description: '相同正文' });
    const row = await prisma.task.findUnique({ where: { id: item.id } });
    const changes = await prisma.changeRecord.count();
    const again = await request(app).patch(`/api/tasks/${item.id}`).send({ description: '相同正文' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await prisma.task.findUnique({ where: { id: item.id } })).toMatchObject({ revision: row!.revision });
    expect(await prisma.changeRecord.count()).toBe(changes);
  });

  it('完成仍有未完成子任务的父任务时保留确认规则', async () => {
    const parent = await makeTask('确认父任务');
    await makeTask('未完成子任务', { parentId: parent.id });
    const response = await request(app).patch(`/api/tasks/${parent.id}`).send({ status: 'done' });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe('SUBTASKS_INCOMPLETE');
    // 带确认的完成仍走关联变更预览。
    const confirmed = await request(app).patch(`/api/tasks/${parent.id}`).send({ status: 'done', completeChildren: true });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(await prisma.task.findUnique({ where: { id: parent.id } })).toMatchObject({ status: 'done' });
  });

  it('同一 requestId 与 body 的重试返回原结果：revision 与变更记录只增加一次', async () => {
    const item = await makeTask('幂等任务');
    const requestId = randomUUID();
    const row = await prisma.task.findUnique({ where: { id: item.id } });
    const first = await request(app).patch(`/api/tasks/${item.id}`).set('X-Request-ID', requestId).send({ expectedRevision: item.revision, description: '第一次写入' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const afterFirst = await prisma.task.findUnique({ where: { id: item.id } });
    const changesFirst = await prisma.changeRecord.count({ where: { entityId: item.id, operation: 'update' } });

    // 响应丢失后的重试：同 ID 同 body。
    const retry = await request(app).patch(`/api/tasks/${item.id}`).set('X-Request-ID', requestId).send({ expectedRevision: item.revision, description: '第一次写入' });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.data.description).toBe('第一次写入');
    expect(await prisma.task.findUnique({ where: { id: item.id } })).toMatchObject({ revision: afterFirst!.revision });
    expect(row!.revision).toBe(afterFirst!.revision - 1);
    expect(await prisma.changeRecord.count({ where: { entityId: item.id, operation: 'update' } })).toBe(changesFirst);

    // 同 ID 不同 body 被拒绝。
    const clash = await request(app).patch(`/api/tasks/${item.id}`).set('X-Request-ID', requestId).send({ expectedRevision: item.revision, description: '别的内容' });
    expect(clash.status).toBe(409);
  });
});

describe('whole-description material references', () => {
  beforeEach(clean);

  it('整篇正文引用：revision 只加一次、正文逐字相等、materialTaskLink 存在', async () => {
    const item = await makeTask('引用任务');
    const material = await makeMaterial('资料甲');
    const description = `开头\n\n${citation(material.id, material.title)} 结尾`;
    const result = await commands.submit(ownerActor, {
      requestId: randomUUID(),
      commands: [{
        kind: 'task.reference_materials',
        targetId: item.id,
        expectedRevision: item.revision,
        input: {
          materialIds: [material.id],
          description,
          expectedMaterialRevisions: { [material.id]: material.revision },
          expectedOrganizationRevisions: { [material.id]: material.organizationRevision },
        },
      }],
    });
    expect(result.status).toBe('applied');
    const taskRow = await prisma.task.findUnique({ where: { id: item.id } });
    expect(taskRow!.revision).toBe(item.revision + 1);
    expect(taskRow!.description).toBe(description);
    expect(await prisma.materialTaskLink.count({ where: { materialId: material.id, taskId: item.id } })).toBe(1);
    expect(result.results[0]).toMatchObject({ id: item.id, revision: item.revision + 1, description });
  });

  it('预期版本不匹配时正文和关联都不变', async () => {
    const item = await makeTask('版本守卫');
    const material = await makeMaterial('资料乙');
    const description = `${citation(material.id, material.title)}`;
    const attempt = commands.submit(ownerActor, {
      requestId: randomUUID(),
      commands: [{
        kind: 'task.reference_materials',
        targetId: item.id,
        expectedRevision: item.revision,
        input: {
          materialIds: [material.id],
          description,
          expectedMaterialRevisions: { [material.id]: material.revision + 5 },
          expectedOrganizationRevisions: { [material.id]: material.organizationRevision },
        },
      }],
    });
    await expect(attempt).rejects.toThrow();
    expect(await prisma.task.findUnique({ where: { id: item.id } })).toMatchObject({ revision: item.revision, description: '' });
    expect(await prisma.materialTaskLink.count({ where: { materialId: material.id, taskId: item.id } })).toBe(0);
  });

  it('所选资料未出现在正文或混传两种输入时请求失败且数据库无变化', async () => {
    const item = await makeTask('校验任务');
    const material = await makeMaterial('资料丙');
    const missing = await commands.submit(ownerActor, {
      requestId: randomUUID(),
      commands: [{
        kind: 'task.reference_materials',
        targetId: item.id,
        expectedRevision: item.revision,
        input: {
          materialIds: [material.id],
          description: '正文里没有引用',
          expectedMaterialRevisions: { [material.id]: material.revision },
          expectedOrganizationRevisions: { [material.id]: material.organizationRevision },
        },
      }],
    }).catch((error) => error);
    expect(missing).toBeInstanceOf(Error);
    expect(await prisma.task.findUnique({ where: { id: item.id } })).toMatchObject({ revision: item.revision, description: '' });

    const mixed = await request(app).post('/api/v1/commands').send({
      requestId: randomUUID(),
      commands: [{
        kind: 'task.reference_materials',
        targetId: item.id,
        expectedRevision: item.revision,
        input: {
          materialIds: [material.id],
          from: 0,
          to: 0,
          description: '混传',
          expectedMaterialRevisions: { [material.id]: material.revision },
          expectedOrganizationRevisions: { [material.id]: material.organizationRevision },
        },
      }],
    });
    expect(mixed.status, JSON.stringify(mixed.body)).toBeGreaterThanOrEqual(400);
    expect(await prisma.task.findUnique({ where: { id: item.id } })).toMatchObject({ revision: item.revision, description: '' });
    expect(await prisma.materialTaskLink.count({ where: { taskId: item.id } })).toBe(0);
  });

  it('旧 from/to 范围引用继续可用', async () => {
    const item = await makeTask('旧调用方');
    const material = await makeMaterial('资料丁');
    const result = await commands.submit(ownerActor, {
      requestId: randomUUID(),
      commands: [{
        kind: 'task.reference_materials',
        targetId: item.id,
        expectedRevision: item.revision,
        input: {
          materialIds: [material.id],
          from: 0,
          to: 0,
          expectedMaterialRevisions: { [material.id]: material.revision },
          expectedOrganizationRevisions: { [material.id]: material.organizationRevision },
        },
      }],
    });
    expect(result.status).toBe('applied');
    const taskRow = await prisma.task.findUnique({ where: { id: item.id } });
    expect(taskRow!.description).toBe(`${citation(material.id, material.title)}`);
    expect(await prisma.materialTaskLink.count({ where: { materialId: material.id, taskId: item.id } })).toBe(1);
  });
});
