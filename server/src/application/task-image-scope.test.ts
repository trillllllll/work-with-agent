import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Response as AgentResponse } from 'superagent';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { CommandService } from './commands.js';
import { ownerActor } from './security.js';
import ownerRequest, { ownerSession } from '../test-auth.js';

const commands = new CommandService();
const taskIds: string[] = [];
const topicIds: string[] = [];
const connectionIds: string[] = [];
const materialIds: string[] = [];
const storageRoot = resolve(process.cwd(), 'data/task-image-scope-blobs');
let previousRoot: string | undefined;

function jpeg(payload: string) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(payload), Buffer.from([0xd9])]);
}
function binaryParser(res: AgentResponse, callback: (error: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}
async function removeMaterial(id: string) {
  await prisma.librarySearchPosting.deleteMany({ where: { materialId: id } });
  await prisma.librarySearchDocument.deleteMany({ where: { materialId: id } });
  await prisma.materialChunk.deleteMany({ where: { extraction: { materialId: id } } });
  await prisma.materialExtraction.deleteMany({ where: { materialId: id } });
  await prisma.materialTag.deleteMany({ where: { materialId: id } });
  await prisma.materialTaskLink.deleteMany({ where: { materialId: id } });
  await prisma.materialVersion.deleteMany({ where: { materialId: id } });
  await prisma.material.deleteMany({ where: { id } });
}

describe('scoped task image reads', () => {
  beforeAll(() => {
    previousRoot = process.env.KNOWLEDGE_STORAGE_ROOT;
    process.env.KNOWLEDGE_STORAGE_ROOT = storageRoot;
  });
  afterAll(async () => {
    for (const id of materialIds) await removeMaterial(id);
    if (taskIds.length) {
      await prisma.taskImage.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskTag.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskTopicAssignment.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.updateMany({ where: { id: { in: taskIds } }, data: { parentId: null } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }
    if (topicIds.length) await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
    if (connectionIds.length) await prisma.connection.deleteMany({ where: { id: { in: connectionIds } } });
    if (previousRoot === undefined) delete process.env.KNOWLEDGE_STORAGE_ROOT;
    else process.env.KNOWLEDGE_STORAGE_ROOT = previousRoot;
    if (storageRoot.endsWith('task-image-scope-blobs')) await rm(storageRoot, { recursive: true, force: true });
  });

  it('serves an image to a granted connection and refuses tasks outside the grant', async () => {
    const visibleTopic = await ownerRequest(app).post('/api/topics').send({ name: '可见清单' });
    const hiddenTopic = await ownerRequest(app).post('/api/topics').send({ name: '保密清单' });
    expect(visibleTopic.status, JSON.stringify(visibleTopic.body)).toBe(200);
    expect(hiddenTopic.status, JSON.stringify(hiddenTopic.body)).toBe(200);
    topicIds.push(visibleTopic.body.data.id, hiddenTopic.body.data.id);
    const visibleTask = await ownerRequest(app).post('/api/tasks').send({ title: '可见任务', topicId: visibleTopic.body.data.id });
    const hiddenTask = await ownerRequest(app).post('/api/tasks').send({ title: '保密任务', topicId: hiddenTopic.body.data.id });
    expect(visibleTask.status, JSON.stringify(visibleTask.body)).toBe(200);
    expect(hiddenTask.status, JSON.stringify(hiddenTask.body)).toBe(200);
    taskIds.push(visibleTask.body.data.id, hiddenTask.body.data.id);
    const bytes = jpeg('SCOPED_IMAGE');
    const uploaded = await ownerRequest(app).post(`/api/tasks/${visibleTask.body.data.id}/images`).send({ attachmentBase64: bytes.toString('base64'), mimeType: 'image/jpeg' });
    const hiddenUpload = await ownerRequest(app).post(`/api/tasks/${hiddenTask.body.data.id}/images`).send({ attachmentBase64: jpeg('HIDDEN_IMAGE').toString('base64'), mimeType: 'image/jpeg' });
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    expect(hiddenUpload.status, JSON.stringify(hiddenUpload.body)).toBe(200);
    const session = await ownerSession(app);
    const connection = await request(app).post('/api/v1/connections').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: '图片连接', host: 'codex', topicIds: [visibleTopic.body.data.id], includeInbox: false, autoActions: [] });
    expect(connection.status, JSON.stringify(connection.body)).toBe(200);
    connectionIds.push(connection.body.data.id);
    const token = connection.body.data.token as string;
    const path = `/api/v1/tasks/${visibleTask.body.data.id}/images/${uploaded.body.data.id}`;
    expect((await request(app).get(path)).status).toBe(401);
    const allowed = await request(app).get(path).set('Authorization', `Bearer ${token}`).buffer(true).parse(binaryParser);
    expect(allowed.status).toBe(200);
    expect(allowed.headers['content-type']).toBe('image/jpeg');
    expect(allowed.headers['content-length']).toBe(String(bytes.byteLength));
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['cache-control']).toBe('private, no-store');
    expect(allowed.headers['content-disposition']).toBe('inline');
    expect(allowed.body).toEqual(bytes);
    const outside = await request(app).get(`/api/v1/tasks/${hiddenTask.body.data.id}/images/${hiddenUpload.body.data.id}`).set('Authorization', `Bearer ${token}`);
    expect(outside.status).toBe(403);
    expect(JSON.stringify(outside.body)).not.toContain('HIDDEN_IMAGE');
    expect((await request(app).get(`/api/tasks/${visibleTask.body.data.id}/images/${uploaded.body.data.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect((await request(app).get(`/api/v1/tasks/${visibleTask.body.data.id}/images/missing-image`).set('Authorization', `Bearer ${token}`)).status).toBe(404);
    expect((await request(app).get('/api/v1/tasks/missing-task/images/missing-image').set('Authorization', `Bearer ${token}`)).status).toBe(404);
    expect((await ownerRequest(app).delete(`/api/tasks/${visibleTask.body.data.id}`)).status).toBe(200);
    expect((await request(app).get(path).set('Authorization', `Bearer ${token}`)).status).toBe(404);

    const text = Buffer.from('材料正文');
    const material = await commands.submit(ownerActor, { requestId: randomUUID(), commands: [{ kind: 'material.create', input: { topicId: visibleTopic.body.data.id, title: '说明', kind: 'attachment', fileName: '说明.txt', mimeType: 'text/plain', attachmentBase64: text.toString('base64') } }] });
    expect(material.status).toBe('applied');
    const materialId = material.results[0].id as string;
    materialIds.push(materialId);
    const download = await request(app).get(`/api/v1/knowledge/materials/${materialId}/versions/1/attachment`).set('Authorization', `Bearer ${token}`).buffer(true).parse(binaryParser);
    expect(download.status, JSON.stringify(download.body)).toBe(200);
    expect(download.headers['content-type']).toMatch(/application\/octet-stream/);
    expect(download.headers['x-dovun-mime-type']).toBe('text/plain');
    expect(download.body).toEqual(text);
    const hiddenMaterial = await commands.submit(ownerActor, { requestId: randomUUID(), commands: [{ kind: 'material.create', input: { topicId: hiddenTopic.body.data.id, title: '保密说明', kind: 'attachment', fileName: 'secret.txt', mimeType: 'text/plain', attachmentBase64: Buffer.from('secret-bytes').toString('base64') } }] });
    expect(hiddenMaterial.status).toBe('applied');
    materialIds.push(hiddenMaterial.results[0].id);
    expect((await request(app).get(`/api/v1/knowledge/materials/${hiddenMaterial.results[0].id}/versions/1/attachment`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });
});
