import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from '../test-auth.js';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { CommandService } from './commands.js';
import { KnowledgeService } from './knowledge.js';
import { knowledgeHash, knowledgeStorageRoot } from './knowledge-blobs.js';
import { ownerActor } from './security.js';

const commands = new CommandService();
const knowledge = new KnowledgeService();
let previousRoot: string | undefined;

function jpeg(payload: string) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(payload), Buffer.from([0xd9])]);
}
function webp(payload: string) {
  const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from(payload)]);
  const header = Buffer.alloc(8);
  header.write('RIFF');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
async function clean() {
  await prisma.taskImage.deleteMany();
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
async function task(title = '任务') {
  const response = await request(app).post('/api/tasks').send({ title });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { id: string; revision: number };
}

describe('task detail images', () => {
  beforeEach(async () => {
    previousRoot = process.env.KNOWLEDGE_STORAGE_ROOT;
    process.env.KNOWLEDGE_STORAGE_ROOT = resolve(process.cwd(), 'data/task-image-test-blobs');
    await clean();
  });
  afterEach(() => {
    if (previousRoot === undefined) delete process.env.KNOWLEDGE_STORAGE_ROOT;
    else process.env.KNOWLEDGE_STORAGE_ROOT = previousRoot;
  });
  afterAll(async () => {
    await clean();
    const root = resolve(process.cwd(), 'data/task-image-test-blobs');
    if (root.endsWith('task-image-test-blobs')) {
      const { rm } = await import('node:fs/promises');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stores compressed bytes outside the description and drops images the description no longer uses', async () => {
    const item = await task();
    const other = await task('另一任务');
    const kept = jpeg('TASK_IMAGE_MARKER_KEEP');
    const dropped = jpeg('TASK_IMAGE_MARKER_DROP');
    const before = await prisma.changeRecord.count();
    const uploaded = await request(app).post(`/api/tasks/${item.id}/images`).send({ attachmentBase64: kept.toString('base64'), mimeType: 'image/jpeg' });
    const removed = await request(app).post(`/api/tasks/${item.id}/images`).send({ attachmentBase64: dropped.toString('base64'), mimeType: 'image/jpeg' });
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    expect(removed.status).toBe(200);
    expect(uploaded.body.data.url).toBe(`/api/tasks/${item.id}/images/${uploaded.body.data.id}`);
    expect(JSON.stringify(uploaded.body)).not.toContain('TASK_IMAGE_MARKER_KEEP');
    expect(await prisma.changeRecord.count()).toBe(before);

    const saved = await request(app).patch(`/api/tasks/${item.id}`).send({ description: `说明\n![](${uploaded.body.data.url})\n` });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.description).toBe(`说明\n![](${uploaded.body.data.url})\n`);
    expect(await prisma.taskImage.count({ where: { taskId: item.id } })).toBe(1);

    const bytes = await request(app).get(uploaded.body.data.url);
    expect(bytes.status).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/jpeg');
    expect(bytes.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(bytes.body)).toEqual(kept);
    expect((await request(app).get(`/api/tasks/${other.id}/images/${uploaded.body.data.id}`)).status).toBe(404);
    expect((await request(app).get(removed.body.data.url)).status).toBe(404);
    await expect(readFile(resolve(knowledgeStorageRoot(), knowledgeHash(dropped)))).rejects.toThrow();
    expect(await readFile(resolve(knowledgeStorageRoot(), knowledgeHash(kept)))).toEqual(kept);

    const records = await prisma.changeRecord.findMany();
    const snapshot = JSON.stringify(records);
    expect(snapshot).not.toContain('TASK_IMAGE_MARKER_KEEP');
    expect(snapshot).not.toContain('TASK_IMAGE_MARKER_DROP');
  });

  it('rejects a non-image, an oversized file, and a trashed task', async () => {
    const item = await task();
    const fake = await request(app).post(`/api/tasks/${item.id}/images`).send({ attachmentBase64: jpeg('not-really').toString('base64'), mimeType: 'image/webp' });
    expect(fake.status).toBe(400);
    expect(fake.body.code).toBe('INVALID_IMAGE');
    const oversized = webp('x');
    const tooBig = Buffer.alloc(8 * 1024 * 1024 + 1);
    oversized.copy(tooBig);
    const rejected = await request(app).post(`/api/tasks/${item.id}/images`).send({ attachmentBase64: tooBig.toString('base64'), mimeType: 'image/webp' });
    expect(rejected.status).toBe(413);
    await request(app).delete(`/api/tasks/${item.id}`);
    const trashed = await request(app).post(`/api/tasks/${item.id}/images`).send({ attachmentBase64: jpeg('gone').toString('base64'), mimeType: 'image/jpeg' });
    expect(trashed.status).toBe(409);
  }, 30_000);

  it('keeps a blob that a material still uses after the task is permanently deleted', async () => {
    const item = await task();
    const bytes = jpeg('SHARED_WITH_MATERIAL');
    const uploaded = await request(app).post(`/api/tasks/${item.id}/images`).send({ attachmentBase64: bytes.toString('base64'), mimeType: 'image/jpeg' });
    expect(uploaded.status).toBe(200);
    const material = await commands.submit(ownerActor, { requestId: randomUUID(), commands: [{ kind: 'material.create', input: { title: '同一张图', kind: 'attachment', fileName: '图.jpg', mimeType: 'image/jpeg', attachmentBase64: bytes.toString('base64') } }] });
    expect(material.status).toBe('applied');
    await request(app).patch(`/api/tasks/${item.id}`).send({ description: `![](${uploaded.body.data.url})` });
    await request(app).delete(`/api/tasks/${item.id}`);
    const deleted = await request(app).delete(`/api/trash/tasks/${item.id}/permanent`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(await prisma.taskImage.count()).toBe(0);
    const attachment = await knowledge.attachment(ownerActor, material.results[0].id, 1);
    expect(attachment.bytes).toEqual(bytes);
    expect(await readFile(resolve(knowledgeStorageRoot(), knowledgeHash(bytes)))).toEqual(bytes);
  });
});
