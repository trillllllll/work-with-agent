import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../infrastructure/prisma.js';
import { ownerActor } from './security.js';
import { ownerSession } from '../test-auth.js';
import { rehearseSameNameLibraryMigration } from './library/migration-rehearsal.js';
import { beginReceive, cancelUpload, finishReceive, isContainedPath } from './library/uploads.js';
import { runLibraryWorkerOnce } from './library/worker.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (databaseUrl.includes('agent-studio')) throw new Error('资料修复测试不能使用开发数据库');

const scratch = mkdtempSync(join(tmpdir(), 'wwa-library-repair-'));
let previousKnowledge: string | undefined;
let previousUpload: string | undefined;

beforeAll(() => {
  previousKnowledge = process.env.KNOWLEDGE_STORAGE_ROOT;
  previousUpload = process.env.LIBRARY_UPLOAD_ROOT;
  process.env.KNOWLEDGE_STORAGE_ROOT = join(scratch, 'blobs');
  process.env.LIBRARY_UPLOAD_ROOT = join(scratch, 'uploads');
});

afterAll(async () => {
  if (previousKnowledge === undefined) delete process.env.KNOWLEDGE_STORAGE_ROOT;
  else process.env.KNOWLEDGE_STORAGE_ROOT = previousKnowledge;
  if (previousUpload === undefined) delete process.env.LIBRARY_UPLOAD_ROOT;
  else process.env.LIBRARY_UPLOAD_ROOT = previousUpload;
  await rm(scratch, { recursive: true, force: true });
});

function sse(text: string) {
  const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function api(method: 'get' | 'post' | 'put' | 'delete', pathName: string, body?: unknown) {
  const session = await ownerSession(app);
  let req = request(app)[method](pathName).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
  if (typeof body === 'string' || (typeof body === 'object' && body !== null)) req = req.send(body);
  return req;
}

async function command(kind: string, input: Record<string, unknown>, targetId?: string, expectedRevision?: number) {
  const response = await api('post', '/api/v1/commands', {
    requestId: randomUUID(),
    commands: [{ kind, input, targetId, expectedRevision }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.status).toBe('applied');
  return { result: response.body.data.results[0], changeId: response.body.data.changeId as string };
}

async function detail(id: string) {
  const response = await api('get', `/api/v1/library/materials/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

async function drain(materialIds: string[]) {
  await prisma.materialExtraction.updateMany({ where: { materialId: { in: materialIds } }, data: { nextAttemptAt: '1970-01-01T00:00:00.000Z' } });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const pending = await prisma.materialExtraction.count({ where: { materialId: { in: materialIds }, status: { in: ['queued', 'running'] } } });
    if (!pending) return;
    await runLibraryWorkerOnce();
  }
  const rows = await prisma.materialExtraction.findMany({ where: { materialId: { in: materialIds } }, select: { materialId: true, status: true, errorCode: true } });
  throw new Error(`解析没有完成 ${JSON.stringify(rows)}`);
}

async function holdOtherExtractions<T>(keepIds: string[], run: () => Promise<T>) {
  const paused = await prisma.materialExtraction.findMany({
    where: { status: { in: ['queued', 'running'] }, materialId: { notIn: keepIds } },
    select: { id: true, nextAttemptAt: true },
  });
  if (paused.length) await prisma.materialExtraction.updateMany({ where: { id: { in: paused.map((row) => row.id) } }, data: { nextAttemptAt: '2999-01-01T00:00:00.000Z' } });
  try { return await run(); }
  finally {
    for (const row of paused) await prisma.materialExtraction.update({ where: { id: row.id }, data: { nextAttemptAt: row.nextAttemptAt } });
  }
}

async function pdfBytes(page1: string, page2: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage();
  first.drawText(page1, { x: 40, y: 720, size: 12, font });
  const second = doc.addPage();
  second.drawText(page2, { x: 40, y: 720, size: 12, font });
  return Buffer.from(await doc.save());
}

it('带任务条件的正文搜索返回 200，并且搜索行带有完整摘要', async () => {
  const token = randomUUID().slice(0, 8);
  const phrase = `正文独有词${token}`;
  const topic = await command('topic.create', { name: `检索清单${token}` });
  const listed = await command('task.create', { title: '清单任务', topicId: topic.result.id });
  const inbox = await command('task.create', { title: '收集箱任务', topicId: null });
  const listedMaterial = await command('material.create', { topicId: topic.result.id, kind: 'text', title: `清单资料${token}`, content: `${phrase}清单正文` });
  const inboxMaterial = await command('material.create', { topicId: null, kind: 'text', title: `收集箱资料${token}`, content: `${phrase}收集箱正文` });
  for (const [material, task] of [[listedMaterial, listed], [inboxMaterial, inbox]] as const) {
    const current = await detail(material.result.id);
    await command('material.links', {
      expectedOrganizationRevision: current.organizationRevision,
      addTaskIds: [task.result.id],
      removeTaskIds: [],
      removeInlineReferences: false,
      expectedTaskRevisions: {},
    }, material.result.id, current.revision);
  }
  await drain([listedMaterial.result.id, inboxMaterial.result.id]);
  const cases = [
    { taskId: listed.result.id, materialId: listedMaterial.result.id },
    { taskTopicId: topic.result.id, materialId: listedMaterial.result.id },
    { taskTopicId: 'inbox', materialId: inboxMaterial.result.id },
  ];
  for (const filters of cases) {
    const response = await api('get', `/api/v1/library/search?q=${encodeURIComponent(phrase)}&${new URLSearchParams(filters.taskId ? { taskId: filters.taskId } : { taskTopicId: filters.taskTopicId! })}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.error).toBeNull();
    const item = response.body.data.items.find((row: { id: string }) => row.id === filters.materialId);
    expect(item, JSON.stringify(response.body.data)).toMatchObject({
      id: filters.materialId,
      title: expect.any(String),
      organizationRevision: expect.any(Number),
      linkedTaskCount: expect.any(Number),
      score: expect.any(Number),
    });
    expect(Array.isArray(item.tags)).toBe(true);
    expect(item.hits.length).toBeGreaterThan(0);
    expect(item.hits[0]).toMatchObject({ chunkId: expect.any(String), revision: expect.any(Number), snippet: expect.any(String) });
  }
  const listedPage = await api('get', '/api/v1/library/materials?limit=40');
  expect(listedPage.status).toBe(200);
  expect(listedPage.body.error).toBeNull();
  expect(listedPage.body.data.total).toEqual(expect.any(Number));
  expect(listedPage.body.data.nextCursor).toBe(listedPage.body.data.total > 40 ? 40 : null);
  expect(listedPage.body.data.items[0]).toMatchObject({ score: null, hits: [] });
}, 180_000);

it('无权连接不能通过重新解析预览读到资料标题', async () => {
  const token = randomUUID().slice(0, 8);
  const hidden = await command('topic.create', { name: `隐藏清单${token}` });
  const title = `REVIEW_SECRET_TITLE_${token}`;
  const secret = await command('material.create', { topicId: hidden.result.id, kind: 'text', title, content: `机密正文${token}` });
  const session = await ownerSession(app);
  const connection = await request(app).post('/api/v1/connections').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: `无权连接${token}`, host: 'codex', topicIds: [], includeInbox: false, autoActions: [] });
  expect(connection.status, JSON.stringify(connection.body)).toBe(200);
  const proposalCountBefore = await prisma.proposal.count();
  const response = await request(app)
    .post('/api/v1/commands/preview')
    .set('Authorization', `Bearer ${connection.body.data.token}`)
    .send({ commands: [{ kind: 'material.reextract', targetId: secret.result.id, expectedRevision: secret.result.revision, input: {} }] });
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('SCOPE_DENIED');
  expect(JSON.stringify(response.body)).not.toContain(title);
  expect(JSON.stringify(response.body)).not.toContain(`机密正文${token}`);
  expect(await prisma.proposal.count()).toBe(proposalCountBefore);
});

it('取消后的迟到完成不能把上传恢复成 ready', async () => {
  const opened = await api('post', '/api/v1/library/uploads', { requestKey: randomUUID(), fileName: '取消竞态.txt', mimeType: 'text/plain', size: 4 });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const started = await beginReceive(ownerActor, opened.body.data.id);
  expect(started.receipt).toBeTruthy();
  await expect(beginReceive(ownerActor, opened.body.data.id)).rejects.toMatchObject({ code: 'UPLOAD_IN_PROGRESS' });
  await cancelUpload(ownerActor, opened.body.data.id);
  await expect(finishReceive(ownerActor, started.receipt!, { actualSize: 4, sha256: 'ab'.repeat(32) })).rejects.toMatchObject({ code: 'UPLOAD_STALE_ATTEMPT' });
  expect((await prisma.libraryUpload.findUniqueOrThrow({ where: { id: opened.body.data.id } })).state).toBe('cancelled');
});

it('真实上传流被取消后，结束请求不能把状态写回 ready', async () => {
  const bytes = Buffer.from('repair-upload-stream-body');
  const opened = await api('post', '/api/v1/library/uploads', { requestKey: randomUUID(), fileName: '流取消.txt', mimeType: 'text/plain', size: bytes.length });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const uploadId = opened.body.data.id as string;
  const session = await ownerSession(app);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port, method: 'PUT', path: `/api/v1/library/uploads/${uploadId}/content`,
        headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
      }, (res) => { res.resume(); res.on('end', () => undefined); });
      req.on('error', () => undefined);
      req.write(bytes.subarray(0, 1));
      void (async () => {
        let receiving = false;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const row = await prisma.libraryUpload.findUnique({ where: { id: uploadId } });
          if (row?.state === 'receiving') { receiving = true; break; }
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
        expect(receiving).toBe(true);
        const cancelled = await request(app).delete(`/api/v1/library/uploads/${uploadId}`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
        expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
        req.end(bytes.subarray(1));
        await new Promise((resolveWait) => setTimeout(resolveWait, 300));
        resolve();
      })().catch(reject);
    });
    expect((await prisma.libraryUpload.findUniqueOrThrow({ where: { id: uploadId } })).state).toBe('cancelled');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('解除关联并移除正文引用后可以一次撤销回来', async () => {
  const token = randomUUID().slice(0, 8);
  const task = await command('task.create', { title: `引用撤销${token}` });
  const material = await command('material.create', { topicId: null, kind: 'text', title: `可引用资料${token}`, content: '引用撤销正文' });
  const taskRow = await prisma.task.findUniqueOrThrow({ where: { id: task.result.id } });
  const materialRow = await detail(material.result.id);
  await command('task.reference_materials', {
    materialIds: [material.result.id],
    from: taskRow.description.length,
    to: taskRow.description.length,
    expectedMaterialRevisions: { [material.result.id]: materialRow.revision },
    expectedOrganizationRevisions: { [material.result.id]: materialRow.organizationRevision },
  }, task.result.id, taskRow.revision);
  const beforeTask = await prisma.task.findUniqueOrThrow({ where: { id: task.result.id } });
  const beforeMaterial = await prisma.material.findUniqueOrThrow({ where: { id: material.result.id } });
  const current = await detail(material.result.id);
  const removal = await command('material.links', {
    expectedOrganizationRevision: current.organizationRevision,
    addTaskIds: [],
    removeTaskIds: [task.result.id],
    removeInlineReferences: true,
    expectedTaskRevisions: { [task.result.id]: beforeTask.revision },
  }, material.result.id, current.revision);
  const undo = await api('post', `/api/changes/${removal.changeId}/undo`);
  expect(undo.status, JSON.stringify(undo.body)).toBe(200);
  const afterTask = await prisma.task.findUniqueOrThrow({ where: { id: task.result.id } });
  expect(afterTask.description).toBe(beforeTask.description);
  expect(await prisma.materialTaskLink.findUnique({ where: { materialId_taskId: { materialId: material.result.id, taskId: task.result.id } } })).not.toBeNull();
  expect(afterTask.revision).toBe(beforeTask.revision + 2);
  expect((await prisma.material.findUniqueOrThrow({ where: { id: material.result.id } })).organizationRevision).toBe(beforeMaterial.organizationRevision + 2);
});

it('三个同名清单、长名称和全角名称迁移后仍然唯一，且不移动后来的整理', async () => {
  const sameName = await rehearseSameNameLibraryMigration();
  const migratedFolderNames = sameName.identicalNames;
  expect(new Set(migratedFolderNames).size).toBe(3);
  expect([...migratedFolderNames, ...sameName.longNames, ...sameName.nfkcNames].every((name) => Array.from(name).length <= 80)).toBe(true);
  expect(new Set(sameName.longNames).size).toBe(2);
  expect(new Set(sameName.nfkcNames).size).toBe(2);
  expect(sameName.nfkcNames[1]).toContain(createHash('sha256').update('nfkc-b').digest('hex').slice(0, 12));
  expect(sameName.report.materialCountAfter).toBe(sameName.report.materialCountBefore);
  expect(sameName.report.versionCountAfter).toBe(sameName.report.versionCountBefore);
  expect(sameName.secondRun).toBeNull();
  expect(sameName.renamedName).toBe('用户后来整理的文件夹');
  expect(sameName.materialFolderId).toBeNull();
}, 180_000);

it('无附件原文接口返回完整正文，无权读取不会泄露', async () => {
  const token = randomUUID().slice(0, 8);
  const content = `${'原文段落'.repeat(400)}${token}`;
  const created = await command('material.create', { topicId: null, kind: 'text', title: `原文资料${token}`, content });
  await drain([created.result.id]);
  const session = await ownerSession(app);
  const source = await request(app).get(`/api/v1/library/materials/${created.result.id}/versions/1/source`).set('Cookie', session.cookie).buffer(true);
  expect(source.status, JSON.stringify(source.body)).toBe(200);
  expect(source.headers['content-type']).toContain('text/plain');
  expect(source.text).toBe(content);
  const page = await api('get', `/api/v1/library/materials/${created.result.id}/content?revision=1&limit=1`);
  expect(page.status).toBe(200);
  expect(page.body.data.items[0].text.length).toBeLessThan(content.length);
  expect(page.body.data.nextCursor).not.toBeNull();
  const hidden = await command('topic.create', { name: `原文隐藏${token}` });
  const secret = `原文机密${token}`;
  const deniedMaterial = await command('material.create', { topicId: hidden.result.id, kind: 'text', title: `原文标题${token}`, content: secret });
  const connection = await request(app).post('/api/v1/connections').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: `原文连接${token}`, host: 'codex', topicIds: [], includeInbox: false, autoActions: [] });
  const denied = await request(app).get(`/api/v1/library/materials/${deniedMaterial.result.id}/versions/1/source`).set('Authorization', `Bearer ${connection.body.data.token}`);
  expect(denied.status).toBe(403);
  expect(JSON.stringify(denied.body)).not.toContain(secret);
}, 180_000);

it('上传提交响应丢失后，相同意图重试不会创建第二份资料', async () => {
  const token = randomUUID().slice(0, 8);
  const bytes = Buffer.from(`retry-body-${token}`);
  const session = await ownerSession(app);
  const initialized = await api('post', '/api/v1/library/uploads', { requestKey: randomUUID(), fileName: `重试${token}.txt`, mimeType: 'text/plain', size: bytes.length });
  expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
  const uploaded = await request(app).put(`/api/v1/library/uploads/${initialized.body.data.id}/content`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('Content-Type', 'application/octet-stream').send(bytes);
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
  const input = { uploadId: initialized.body.data.id, duplicateAction: 'create', topicId: null, folderId: null, taskIds: [] as string[] };
  const first = await command('material.create', input);
  const beforeVersions = await prisma.materialVersion.count({ where: { materialId: first.result.id } });
  const second = await command('material.create', input);
  expect(second.result.id).toBe(first.result.id);
  expect(await prisma.materialVersion.count({ where: { materialId: first.result.id } })).toBe(beforeVersions);
  const task = await command('task.create', { title: `另一意图${token}` });
  const conflict = await api('post', '/api/v1/commands', {
    requestId: randomUUID(),
    commands: [{ kind: 'material.create', input: { ...input, taskIds: [task.result.id] } }],
  });
  expect(conflict.status).toBe(409);
  expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  expect(await prisma.material.count({ where: { id: first.result.id } })).toBe(1);
});

it('Windows 路径只接受上传根目录内部的文件', () => {
  const root = 'C:\\library-uploads';
  expect(isContainedPath(root, 'C:\\library-uploads\\file.txt', path.win32)).toBe(true);
  expect(isContainedPath(root, 'C:\\library-uploads\\..\\secret.txt', path.win32)).toBe(false);
  expect(isContainedPath(root, 'C:\\library-uploads-evil\\file.txt', path.win32)).toBe(false);
  expect(isContainedPath(root, 'D:\\library-uploads\\file.txt', path.win32)).toBe(false);
});

it('检索故障返回 SEARCH_UNAVAILABLE，相同请求键不能换成另一个问题', async () => {
  const previous = await prisma.appSetting.findUnique({ where: { id: 'default' } });
  const now = new Date().toISOString();
  await prisma.appSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', openaiBaseUrl: 'http://mock-openai/v1', openaiApiKey: 'test-key', openaiModel: 'test-model', createdAt: now, updatedAt: now },
    update: { openaiBaseUrl: 'http://mock-openai/v1', openaiApiKey: 'test-key', openaiModel: 'test-model', updatedAt: now },
  });
  vi.stubGlobal('fetch', vi.fn(async () => sse('{"queries":["正文独有词"]}')));
  await prisma.$executeRawUnsafe('ALTER TABLE "LibrarySearchPosting" RENAME TO "LibrarySearchPosting_hidden"');
  try {
    const failed = await api('post', '/api/v1/library/answers', { requestKey: randomUUID(), question: '资料里有没有正文独有词', filters: {} });
    expect(failed.status, JSON.stringify(failed.body)).toBe(503);
    expect(failed.body.code).toBe('SEARCH_UNAVAILABLE');
    expect(JSON.stringify(failed.body)).not.toContain('insufficient');
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "LibrarySearchPosting_hidden" RENAME TO "LibrarySearchPosting"');
    vi.unstubAllGlobals();
    if (previous) await prisma.appSetting.update({ where: { id: 'default' }, data: { openaiBaseUrl: previous.openaiBaseUrl, openaiApiKey: previous.openaiApiKey, openaiModel: previous.openaiModel, updatedAt: previous.updatedAt } });
    else await prisma.appSetting.delete({ where: { id: 'default' } }).catch(() => undefined);
  }
  const key = randomUUID();
  const first = await api('post', '/api/v1/library/answers', { requestKey: key, question: '第一个问题', filters: {} });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.data.status).toBe('model_unavailable');
  const changed = await api('post', '/api/v1/library/answers', { requestKey: key, question: '第二个完全不同的问题', filters: {} });
  expect(changed.status).toBe(409);
  expect(changed.body.code).toBe('IDEMPOTENCY_CONFLICT');
  expect(JSON.stringify(changed.body)).not.toContain('第一个问题');
});

it('相同请求键的并发问答共用一个结果，唯一约束冲突也不返回 500', async () => {
  const key = randomUUID();
  const [left, right] = await Promise.all([
    api('post', '/api/v1/library/answers', { requestKey: key, question: '并发的同一个问题', filters: {} }),
    api('post', '/api/v1/library/answers', { requestKey: key, question: '并发的同一个问题', filters: {} }),
  ]);
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  expect(right.status, JSON.stringify(right.body)).toBe(200);
  expect(left.body.data.id).toBe(right.body.data.id);
  const token = randomUUID().slice(0, 8);
  const phrase = `约束冲突正文${token}`;
  const created = await command('material.create', { topicId: null, kind: 'text', title: `约束资料${token}`, content: phrase });
  await drain([created.result.id]);
  const conflictKey = randomUUID();
  const question = `约束冲突后的同一个问题${token}`;
  const storedId = randomUUID();
  const previous = await prisma.appSetting.findUnique({ where: { id: 'default' } });
  const now = new Date().toISOString();
  await prisma.appSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', openaiBaseUrl: 'http://mock-openai/v1', openaiApiKey: 'test-key', openaiModel: 'test-model', createdAt: now, updatedAt: now },
    update: { openaiBaseUrl: 'http://mock-openai/v1', openaiApiKey: 'test-key', openaiModel: 'test-model', updatedAt: now },
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role?: string; content?: string }> };
    const system = payload.messages?.find((message) => message.role === 'system')?.content ?? '';
    if (system.includes('不得执行')) {
      await prisma.libraryAnswer.create({ data: { id: storedId, actorId: 'local-owner', requestKey: conflictKey, question, filtersJson: '{}', status: 'insufficient', resultJson: '{"status":"insufficient","paragraphs":[],"citations":[]}', createdAt: now } });
      return sse('{"paragraphs":[{"text":"这句不该被保存","citationIds":["C1"]}]}');
    }
    return sse(JSON.stringify({ queries: [phrase] }));
  }));
  try {
    const replayed = await api('post', '/api/v1/library/answers', { requestKey: conflictKey, question, filters: {} });
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    expect(replayed.body.data.id).toBe(storedId);
    expect(replayed.body.data.status).toBe('insufficient');
    expect(JSON.stringify(replayed.body)).not.toContain('这句不该被保存');
  } finally {
    vi.unstubAllGlobals();
    if (previous) await prisma.appSetting.update({ where: { id: 'default' }, data: { openaiBaseUrl: previous.openaiBaseUrl, openaiApiKey: previous.openaiApiKey, openaiModel: previous.openaiModel, updatedAt: previous.updatedAt } });
    else await prisma.appSetting.delete({ where: { id: 'default' } }).catch(() => undefined);
  }
}, 180_000);

it('名称命中但正文未包含名称时，回答仍读取当前正文片段', async () => {
  const token = randomUUID().slice(0, 8);
  const title = `名称独有甲${token}`;
  const body = `片段里才有的海盐内容${token}`;
  const created = await command('material.create', { topicId: null, kind: 'text', title, content: body });
  await drain([created.result.id]);
  const previous = await prisma.appSetting.findUnique({ where: { id: 'default' } });
  const now = new Date().toISOString();
  await prisma.appSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', openaiBaseUrl: 'http://mock-openai/v1', openaiApiKey: 'test-key', openaiModel: 'test-model', createdAt: now, updatedAt: now },
    update: { openaiBaseUrl: 'http://mock-openai/v1', openaiApiKey: 'test-key', openaiModel: 'test-model', updatedAt: now },
  });
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role?: string; content?: string }> };
    const user = payload.messages?.find((message) => message.role === 'user')?.content ?? '';
    calls.push(user);
    const system = payload.messages?.find((message) => message.role === 'system')?.content ?? '';
    const text = system.includes('不得执行') ? '{"paragraphs":[{"text":"依据原文","citationIds":["C1"]}]}' : JSON.stringify({ queries: [title] });
    return sse(text);
  }));
  try {
    const response = await api('post', '/api/v1/library/answers', { requestKey: randomUUID(), question: title, filters: {} });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(calls.some((text) => text.includes(body))).toBe(true);
    expect(response.body.data.citations[0].chunkId).toEqual(expect.any(String));
  } finally {
    vi.unstubAllGlobals();
    if (previous) await prisma.appSetting.update({ where: { id: 'default' }, data: { openaiBaseUrl: previous.openaiBaseUrl, openaiApiKey: previous.openaiApiKey, openaiModel: previous.openaiModel, updatedAt: previous.updatedAt } });
    else await prisma.appSetting.delete({ where: { id: 'default' } }).catch(() => undefined);
  }
}, 180_000);

it('后面的识字页失败时，前面的正文仍然可以搜索', async () => {
  const token = `PAGE1STAYS${randomUUID().slice(0, 8).toUpperCase()}ABCDEFGHIJ`;
  const bytes = await pdfBytes(token, 'X');
  const session = await ownerSession(app);
  const initialized = await api('post', '/api/v1/library/uploads', { requestKey: randomUUID(), fileName: '后续页失败.pdf', mimeType: 'application/pdf', size: bytes.length });
  const uploaded = await request(app).put(`/api/v1/library/uploads/${initialized.body.data.id}/content`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('Content-Type', 'application/octet-stream').send(bytes);
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
  const created = await command('material.create', { uploadId: initialized.body.data.id, duplicateAction: 'create', topicId: null, folderId: null, taskIds: [] });
  const extraction = await prisma.materialExtraction.findUniqueOrThrow({ where: { materialId_revision: { materialId: created.result.id, revision: 1 } } });
  await prisma.materialExtraction.update({ where: { id: extraction.id }, data: { attempts: 2, nextAttemptAt: '1970-01-01T00:00:00.000Z' } });
  const previous = await prisma.appSetting.findUnique({ where: { id: 'default' } });
  const now = new Date().toISOString();
  await prisma.appSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', openaiBaseUrl: 'http://mock-openai/v1', openaiApiKey: 'test-key', openaiModel: 'test-model', createdAt: now, updatedAt: now },
    update: { openaiBaseUrl: 'http://mock-openai/v1', openaiApiKey: 'test-key', openaiModel: 'test-model', updatedAt: now },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 500 })));
  try {
    await holdOtherExtractions([created.result.id], async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const row = await prisma.materialExtraction.findUniqueOrThrow({ where: { id: extraction.id } });
        if (row.status !== 'queued' && row.status !== 'running') return;
        await runLibraryWorkerOnce();
      }
    });
  } finally {
    vi.unstubAllGlobals();
    if (previous) await prisma.appSetting.update({ where: { id: 'default' }, data: { openaiBaseUrl: previous.openaiBaseUrl, openaiApiKey: previous.openaiApiKey, openaiModel: previous.openaiModel, updatedAt: previous.updatedAt } });
    else await prisma.appSetting.delete({ where: { id: 'default' } }).catch(() => undefined);
  }
  const saved = await detail(created.result.id);
  expect(saved.extraction.status).toBe('partial');
  expect(saved.extraction.errors.length).toBeGreaterThan(0);
  const found = await api('get', `/api/v1/library/search?q=${encodeURIComponent(token)}`);
  expect(found.status, JSON.stringify(found.body)).toBe(200);
  expect(found.body.data.items.map((item: { id: string }) => item.id)).toContain(created.result.id);
}, 180_000);

it('解析过程抛错后服务仍能响应，并且该任务进入失败状态', async () => {
  const token = randomUUID().slice(0, 8);
  const created = await command('material.create', { topicId: null, kind: 'text', title: `解析崩溃${token}`, content: `崩溃正文${token}` });
  const extraction = await prisma.materialExtraction.findUniqueOrThrow({ where: { materialId_revision: { materialId: created.result.id, revision: 1 } } });
  await prisma.materialExtraction.update({ where: { id: extraction.id }, data: { nextAttemptAt: '1970-01-01T00:00:00.000Z' } });
  const lookup = vi.spyOn(prisma.materialVersion, 'findUnique').mockRejectedValueOnce(new Error('解析进程崩溃'));
  try {
    const outcome = await holdOtherExtractions([created.result.id], () => runLibraryWorkerOnce());
    expect(outcome).toMatchObject({ claimed: true, failed: true });
  } finally {
    lookup.mockRestore();
  }
  const row = await prisma.materialExtraction.findUniqueOrThrow({ where: { id: extraction.id } });
  expect(row.status).toBe('failed');
  expect(row.errorCode).toBe('PARSE_FAILED');
  expect(JSON.parse(row.errorsJson)[0].code).toBe('PARSE_FAILED');
  const health = await api('get', '/api/v1/library/materials?limit=1');
  expect(health.status).toBe(200);
  expect(health.body.error).toBeNull();
});
