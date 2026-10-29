import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { prisma } from '../../infrastructure/prisma.js';
import { ownerSession } from '../../test-auth.js';
import { ownerActor, type Actor } from '../security.js';
import { knowledgeHash, storeKnowledgeBlob } from '../knowledge-blobs.js';
import { ResourceService } from './service.js';
import { migrateDocumentResources } from './migrate.js';
import { CommandService } from '../commands.js';
import { addTaskImage, readTaskImage, pruneTaskImages } from '../task-images.js';
import { LibraryService } from '../library/service.js';
import { readResourceDocument } from './agent-read.js';

if (!process.env.DATABASE_URL?.includes('/tmp/')) throw new Error('Resource contract tests require an explicit /tmp/ database');
const service = new ResourceService();
const originalRoot = process.env.KNOWLEDGE_STORAGE_ROOT;
let directory: string;
let auth: Awaited<ReturnType<typeof ownerSession>>;
const richdoc = (text: string, extra: object[] = []) => ({ schemaVersion: 1, blocks: [{ id: 'intro', kind: 'paragraph', text: [{ text }] }, ...extra] });
const create = (content: unknown = richdoc('支付方案')) => service.create(ownerActor, { requestId: randomUUID(), title: '资源合同', format: 'richdoc-v1', schemaVersion: 1, content });

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dovun-resource-blobs-'));
  process.env.KNOWLEDGE_STORAGE_ROOT = directory;
  auth = await ownerSession(app);
});
afterAll(async () => {
  if (originalRoot === undefined) delete process.env.KNOWLEDGE_STORAGE_ROOT; else process.env.KNOWLEDGE_STORAGE_ROOT = originalRoot;
  await rm(directory, { force: true, recursive: true });
});

describe('document resource authority', () => {
  it('creates format conversions as new resources with exact, authorized source provenance', async () => {
    const source = await create(richdoc('来源第一版'));
    await service.save(ownerActor, source.id, { requestId: randomUUID(), expectedRevision: 1, format: 'richdoc-v1', content: richdoc('来源第二版') });
    const input = { requestId: randomUUID(), title: '转换副本', format: 'markdown', content: '来源第一版', conversionSource: { resourceId: source.id, revision: 1 } };
    const converted = await service.create(ownerActor, input);
    expect(converted.id).not.toBe(source.id);
    expect(converted.conversionSource).toEqual({ resourceId: source.id, revision: 1, format: 'richdoc-v1', contentHash: source.contentHash });
    expect((await service.create(ownerActor, input)).id).toBe(converted.id);
    expect((await service.read(ownerActor, source.id)).revision).toBe(2);
    const saved = await service.save(ownerActor, converted.id, { requestId: randomUUID(), expectedRevision: 1, format: 'markdown', content: '编辑转换副本' });
    expect(saved.conversionSource).toEqual(converted.conversionSource);
    await expect(service.create(ownerActor, { ...input, requestId: randomUUID(), conversionSource: { resourceId: source.id, revision: 99 } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const restricted: Actor = { id: 'limited-conversion-reader', kind: 'internal', topicIds: [], includeInbox: true, autoActions: [], revision: 1 };
    const topic = await prisma.topic.create({ data: { name: '转换来源受限' } });
    await prisma.material.update({ where: { id: source.id }, data: { topicId: topic.id } });
    expect((await service.read(restricted, converted.id)).conversionSource).toBeNull();
    const commands = new CommandService();
    const { requestId: _requestId, ...commandInput } = input;
    await expect(commands.submit(restricted, { requestId: randomUUID(), commands: [{ kind: 'resource.create', input: commandInput }] })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });

  it('replays identical creates and rejects changed payload without a second document', async () => {
    const requestId = randomUUID();
    const input = { requestId, title: '稳定创建', format: 'text', schemaVersion: null, content: '原文' };
    const [first, retry] = await Promise.all([service.create(ownerActor, input), service.create(ownerActor, input)]);
    expect(first.id).toBe(retry.id);
    expect(await service.receipt(ownerActor, requestId)).toMatchObject({ resourceId: first.id, revision: 1 });
    await expect(service.create(ownerActor, { ...input, content: '不同内容' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await prisma.materialVersion.count({ where: { materialId: first.id } })).toBe(1);
  });

  it('detects simultaneous edits, keeps old versions and does not version unchanged content', async () => {
    const created = await create();
    const pending = { requestId: randomUUID(), expectedRevision: 1, format: 'richdoc-v1', schemaVersion: 1, content: richdoc('电脑改动') };
    const saved = await service.save(ownerActor, created.id, pending);
    expect(saved.revision).toBe(2);
    expect((await service.save(ownerActor, created.id, pending)).revision).toBe(2);
    await expect(service.save(ownerActor, created.id, { ...pending, requestId: randomUUID(), content: richdoc('手机改动') })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { currentRevision: 2 } });
    const unchanged = await service.save(ownerActor, created.id, { ...pending, requestId: randomUUID(), expectedRevision: 2 });
    expect(unchanged.revision).toBe(2);
    expect((await service.read(ownerActor, created.id, 1)).content).toEqual(richdoc('支付方案'));
    expect((await service.read(ownerActor, created.id, 1)).readOnly).toBe(true);
  });

  it('commits exact-version references atomically and keeps historical references', async () => {
    const target = await service.create(ownerActor, { requestId: randomUUID(), title: '附件', format: 'text', content: '附件 v1' });
    const source = await create(richdoc('正文', [{ id: 'attachment', kind: 'file', target: { resourceId: target.id, revision: 1 }, label: '证据' }]));
    await service.save(ownerActor, target.id, { requestId: randomUUID(), expectedRevision: 1, format: 'text', content: '附件 v2' });
    expect((await service.read(ownerActor, source.id)).references).toEqual([{ nodeId: 'attachment', resourceId: target.id, revision: 1, accessible: true }]);
    await expect(service.save(ownerActor, source.id, { requestId: randomUUID(), expectedRevision: 1, format: 'richdoc-v1', schemaVersion: 1, content: richdoc('坏引用', [{ id: 'missing', kind: 'file', target: { resourceId: target.id, revision: 99 } }]) })).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
    expect((await service.read(ownerActor, source.id)).revision).toBe(1);
    await service.save(ownerActor, source.id, { requestId: randomUUID(), expectedRevision: 1, format: 'richdoc-v1', schemaVersion: 1, content: richdoc('移除引用') });
    expect((await service.impact(ownerActor, target.id)).references).toHaveLength(1);
  });

  it('rejects upload placeholders, hashes, unsupported nodes and schema before persistence', async () => {
    await expect(create(richdoc('正文', [{ id: 'upload', kind: 'upload', url: 'blob:local' }]))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
    await expect(create({ schemaVersion: 2, blocks: [] })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
    await expect(service.create(ownerActor, { requestId: randomUUID(), title: '校验', format: 'text', content: '正文', contentHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'CONTENT_HASH_MISMATCH' });
    const created = await create();
    const unsupported = JSON.stringify({ schemaVersion: 2, blocks: [{ kind: 'future', privateValue: 'preserve' }] });
    await prisma.materialVersion.update({ where: { materialId_revision: { materialId: created.id, revision: 1 } }, data: { content: unsupported, schemaVersion: 2 } });
    const read = await service.read(ownerActor, created.id);
    expect(read.readOnly).toBe(true);
    expect(read.content).toEqual(JSON.parse(unsupported));
    await expect(service.save(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 1, format: 'richdoc-v1', schemaVersion: 1, content: richdoc('不能覆盖') })).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT_WRITE' });
  });

  it('renames, moves and archives without new content versions', async () => {
    const created = await create();
    const renamed = await service.organize(ownerActor, created.id, { requestId: randomUUID(), expectedOrganizationRevision: 1, title: '改名' });
    expect(renamed).toMatchObject({ revision: 1, organizationRevision: 2, title: '改名' });
    const archived = await service.organize(ownerActor, created.id, { requestId: randomUUID(), expectedOrganizationRevision: 2, archived: true });
    expect(archived).toMatchObject({ revision: 1, organizationRevision: 3, readOnly: true });
    expect(await prisma.materialVersion.count({ where: { materialId: created.id } })).toBe(1);
  });

  it('blocks legacy rich-document writes and returns marked text projection', async () => {
    const created = await create();
    const old = await request(app).get(`/api/v1/knowledge/materials/${created.id}`).set('Cookie', auth.cookie);
    expect(old.status).toBe(200);
    expect(old.body.data.versions[0]).toMatchObject({ content: '支付方案', format: 'richdoc-v1', readOnlyProjection: true });
    const write = await request(app).post('/api/v1/commands').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf).send({ requestId: randomUUID(), commands: [{ kind: 'material.update', targetId: created.id, expectedRevision: 1, input: { content: '投影覆盖' } }] });
    expect(write.status).toBe(409);
    expect(write.body.code).toBe('UNSUPPORTED_FORMAT_WRITE');
    const rename = await request(app).post('/api/v1/commands').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf).send({ requestId: randomUUID(), commands: [{ kind: 'material.update', targetId: created.id, expectedRevision: 1, input: { title: '兼容改名' } }] });
    expect(rename.status).toBe(200);
    expect((await service.read(ownerActor, created.id)).revision).toBe(1);
  });

  it('does not widen scope through folders, receipts, reads or direct external writes', async () => {
    const created = await create();
    const restricted: Actor = { id: 'limited-resource-reader', kind: 'internal', topicIds: [], includeInbox: false, autoActions: [], revision: 1 };
    await expect(service.read(restricted, created.id)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(service.original(restricted, created.id, 1)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(service.receipt(restricted, created.requestId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.create({ ...restricted, includeInbox: true }, { requestId: randomUUID(), title: '外部直接写', format: 'text', content: '禁止' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps imported source bytes while edited original downloads use the new body', async () => {
    const original = Buffer.from('# 来源原件\r\n');
    const path = await storeKnowledgeBlob(original);
    const now = new Date().toISOString();
    const legacy = await prisma.material.create({ data: { kind: 'markdown', title: '导入', createdAt: now, updatedAt: now, versions: { create: { revision: 1, content: original.toString(), contentHash: 'legacy-hash-do-not-rewrite', attachmentPath: path, fileName: '导入.md', mimeType: 'text/markdown', createdAt: now } } } });
    await service.save(ownerActor, legacy.id, { requestId: randomUUID(), expectedRevision: 1, format: 'markdown', content: '# 更新版本\n' });
    expect((await service.original(ownerActor, legacy.id, 2)).bytes.toString()).toBe('# 更新版本\n');
    expect((await service.original(ownerActor, legacy.id, 2, true)).bytes.equals(original)).toBe(true);
    expect((await service.read(ownerActor, legacy.id, 1)).contentHash).toBe('legacy-hash-do-not-rewrite');
    expect((await service.read(ownerActor, legacy.id, 2)).contentHash).toBe(knowledgeHash('# 更新版本\n'));
    await migrateDocumentResources(prisma);
    expect((await migrateDocumentResources(prisma))?.annotatedVersions).toBe(0);
    expect((await service.read(ownerActor, legacy.id, 1)).contentHash).toBe('legacy-hash-do-not-rewrite');
  });

  it('keeps AI changes pending and rejects a changed base at approval', async () => {
    const created = await create();
    const commands = new CommandService();
    const ai: Actor = { id: 'resource-test-ai', kind: 'internal', topicIds: 'all', includeInbox: true, autoActions: [], revision: 1 };
    const proposed = await commands.submit(ai, { requestId: randomUUID(), commands: [{ kind: 'resource.save', targetId: created.id, expectedRevision: 1, input: { format: 'richdoc-v1', schemaVersion: 1, content: richdoc('AI 候选') } }] });
    expect(proposed.status).toBe('pending_approval');
    expect((await service.read(ownerActor, created.id)).revision).toBe(1);
    await commands.approve(ownerActor, proposed.proposalId!, { requestId: randomUUID(), expectedRevision: 1 });
    expect((await service.read(ownerActor, created.id)).content).toEqual(richdoc('AI 候选'));
    const stale = await commands.submit(ai, { requestId: randomUUID(), commands: [{ kind: 'resource.save', targetId: created.id, expectedRevision: 2, input: { format: 'richdoc-v1', schemaVersion: 1, content: richdoc('旧候选') } }] });
    await service.save(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 2, format: 'richdoc-v1', schemaVersion: 1, content: richdoc('手机新稿') });
    await expect(commands.approve(ownerActor, stale.proposalId!, { requestId: randomUUID(), expectedRevision: 1 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await service.read(ownerActor, created.id)).content).toEqual(richdoc('手机新稿'));
  });

  it('preserves migrated task image URLs after pruning and follows current task access on move', async () => {
    const one = await prisma.topic.create({ data: { name: '图片初始清单' } });
    const two = await prisma.topic.create({ data: { name: '图片移动清单' } });
    const task = await prisma.task.create({ data: { title: '图片任务', topicId: one.id } });
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('migration-image')]);
    const image = await addTaskImage(task.id, { attachmentBase64: bytes.toString('base64'), mimeType: 'image/jpeg' });
    const alias = await prisma.resourceLegacyAlias.findUniqueOrThrow({ where: { sourceKind_sourceId: { sourceKind: 'task-image', sourceId: image.id } } });
    const reader: Actor = { id: 'image-resource-reader', kind: 'internal', topicIds: [one.id], includeInbox: false, autoActions: [], revision: 1 };
    expect((await service.original(reader, alias.resourceId, 1)).bytes).toEqual(bytes);
    await prisma.$transaction((tx) => pruneTaskImages(tx, task.id, ''));
    expect((await readTaskImage(task.id, image.id)).bytes).toEqual(bytes);
    await prisma.task.update({ where: { id: task.id }, data: { topicId: two.id } });
    expect((await prisma.material.findUniqueOrThrow({ where: { id: alias.resourceId } })).topicId).toBe(two.id);
    await expect(service.original(reader, alias.resourceId, 1)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect((await service.original({ ...reader, topicIds: [two.id] }, alias.resourceId, 1)).bytes).toEqual(bytes);
    expect((await new LibraryService().materials(ownerActor, {})).items.some((row) => row.id === alias.resourceId)).toBe(false);
  });

  it('retains legacy supplement and original BOM/line endings without changing evidence hash', async () => {
    const bytes = Buffer.from('\ufeff# 原始 Markdown\r\n');
    const path = await storeKnowledgeBlob(bytes);
    const now = new Date().toISOString();
    const original = await prisma.material.create({ data: { title: '混合旧状态', kind: 'attachment', createdAt: now, updatedAt: now, versions: { create: { revision: 1, content: '旧资料补充说明', contentHash: 'legacy-evidence-hash', attachmentPath: path, mimeType: 'text/markdown', fileName: 'mixed.md', createdAt: now } } } });
    await migrateDocumentResources(prisma);
    expect(await service.read(ownerActor, original.id)).toMatchObject({ format: 'markdown', content: bytes.toString('utf8'), supplementalContent: '旧资料补充说明', contentHash: 'legacy-evidence-hash' });
    const row = await prisma.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: original.id, revision: 1 } } });
    expect(row.content).toBe('旧资料补充说明');
    expect((await service.original(ownerActor, original.id, 1)).bytes).toEqual(bytes);
  });

  it('rebuilds exact references on undo and atomically rejects revoked task-image access', async () => {
    const task = await prisma.task.create({ data: { title: '撤销引用权限' } });
    const image = await addTaskImage(task.id, { attachmentBase64: Buffer.from([0xff, 0xd8, 0xff, 0, 1]).toString('base64'), mimeType: 'image/jpeg' });
    const alias = await prisma.resourceLegacyAlias.findUniqueOrThrow({ where: { sourceKind_sourceId: { sourceKind: 'task-image', sourceId: image.id } } });
    const body = richdoc('含图', [{ id: 'picture', kind: 'image', target: { resourceId: alias.resourceId, revision: 1 }, alt: '原图' }]);
    const created = await create(body);
    const requestId = randomUUID();
    await service.save(ownerActor, created.id, { requestId, expectedRevision: 1, format: 'richdoc-v1', content: richdoc('移除图片') });
    const change = await prisma.changeRecord.findFirstOrThrow({ where: { requestId, entityId: created.id } });
    await new CommandService().submit(ownerActor, { requestId: randomUUID(), commands: [{ kind: 'change.undo', targetId: change.id, input: {} }] });
    expect(await service.read(ownerActor, created.id)).toMatchObject({ revision: 3, content: body, references: [{ nodeId: 'picture', resourceId: alias.resourceId, revision: 1, accessible: true }] });
    const removedRequest = randomUUID();
    await service.save(ownerActor, created.id, { requestId: removedRequest, expectedRevision: 3, format: 'richdoc-v1', content: richdoc('再次移除') });
    const removed = await prisma.changeRecord.findFirstOrThrow({ where: { requestId: removedRequest, entityId: created.id } });
    await prisma.task.update({ where: { id: task.id }, data: { deletedAt: new Date().toISOString() } });
    await expect(new CommandService().submit(ownerActor, { requestId: randomUUID(), commands: [{ kind: 'change.undo', targetId: removed.id, input: {} }] })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect((await service.read(ownerActor, created.id)).revision).toBe(4);
    expect(await prisma.resourceReference.count({ where: { sourceResourceId: created.id, sourceRevision: 5 } })).toBe(0);
  });

  it('redacts restricted attachment labels and refuses an unredacted original download', async () => {
    const visible = await prisma.topic.create({ data: { name: '文档范围' } });
    const privateTopic = await prisma.topic.create({ data: { name: '私有附件范围' } });
    const target = await service.create(ownerActor, { requestId: randomUUID(), title: '隐藏文件名', format: 'text', content: '隐藏原文', topicId: privateTopic.id });
    const body = richdoc('公开正文', [{ id: 'private-file', kind: 'file', target: { resourceId: target.id, revision: 1 }, label: '隐藏标签' }]);
    const created = await service.create(ownerActor, { requestId: randomUUID(), title: '可见文档', format: 'richdoc-v1', content: body, topicId: visible.id });
    const reader: Actor = { id: 'scoped-label-reader', kind: 'internal', topicIds: [visible.id], includeInbox: false, autoActions: [], revision: 1 };
    const document = await service.read(reader, created.id);
    expect(document).toMatchObject({ readOnly: true, references: [{ accessible: false }] });
    expect(JSON.stringify(document)).not.toContain('隐藏标签');
    await expect(service.original(reader, created.id, 1)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect((await service.original(ownerActor, created.id, 1)).bytes.toString()).toContain('隐藏标签');
  });

  it('imports new identities with current original, source original and supplement kept together', async () => {
    const fixture = async (bytes: Buffer, name: string) => {
      const path = await storeKnowledgeBlob(bytes);
      const now = new Date().toISOString();
      return prisma.material.create({ data: { title: name, kind: 'attachment', managed: true, createdAt: now, updatedAt: now, versions: { create: { revision: 1, format: 'binary', content: '', contentHash: knowledgeHash(bytes), attachmentPath: path, fileName: name, mimeType: 'application/octet-stream', createdAt: now } } } });
    };
    const current = await fixture(Buffer.from('# 当前\r\n'), 'current.md');
    const original = await fixture(Buffer.from('# 初始\n'), 'source.md');
    const input = { requestId: randomUUID(), title: '导入完整关系', format: 'markdown', content: '# 当前\r\n', importSource: { original: { resourceId: current.id, revision: 1 }, sourceOriginal: { resourceId: original.id, revision: 1 }, supplementalContent: '独立说明' } };
    const imported = await service.create(ownerActor, input);
    expect(imported).toMatchObject({ format: 'markdown', supplementalContent: '独立说明', hasSourceOriginal: true, readOnly: false });
    expect(imported.id).not.toBe(current.id);
    expect((await service.create(ownerActor, input)).id).toBe(imported.id);
    expect((await service.original(ownerActor, imported.id, 1)).bytes.toString()).toBe('# 当前\r\n');
    expect((await service.original(ownerActor, imported.id, 1, true)).bytes.toString()).toBe('# 初始\n');
    const binary = await service.create(ownerActor, { ...input, requestId: randomUUID(), format: 'binary', content: '旧附件说明' });
    expect(binary).toMatchObject({ format: 'binary', content: '旧附件说明', readOnly: true, capabilities: { edit: false } });
    await expect(service.create(ownerActor, { requestId: randomUUID(), title: '缺失原件', format: 'binary', content: '' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
    await expect(service.create(ownerActor, { ...input, requestId: randomUUID(), content: '正文不符' })).rejects.toMatchObject({ code: 'IMPORT_BODY_MISMATCH' });
  });

  it('restores binary snapshots with original provenance, stable receipts and revision conflicts', async () => {
    const now = new Date().toISOString();
    const firstPath = await storeKnowledgeBlob(Buffer.from([0, 1, 2, 3]));
    const secondPath = await storeKnowledgeBlob(Buffer.from([4, 5, 6]));
    const binary = await prisma.material.create({ data: { title: '二进制历史', kind: 'attachment', revision: 2, createdAt: now, updatedAt: now, versions: { create: [
      { revision: 1, format: 'binary', content: 'v1备注', supplementalContent: '说明', contentHash: 'historical-binary-evidence', attachmentPath: firstPath, sourceOriginalPath: firstPath, fileName: 'first.pdf', mimeType: 'application/pdf', createdAt: now },
      { revision: 2, format: 'binary', content: 'v2备注', contentHash: 'second-binary-evidence', attachmentPath: secondPath, fileName: 'second.pdf', mimeType: 'application/pdf', createdAt: now },
    ] } } });
    const input = { requestId: randomUUID(), expectedRevision: 2, sourceRevision: 1 };
    const restored = await service.restore(ownerActor, binary.id, input);
    expect(restored).toMatchObject({ revision: 3, content: 'v1备注', contentHash: 'historical-binary-evidence', supplementalContent: '说明', hasSourceOriginal: true, readOnly: true });
    expect((await service.restore(ownerActor, binary.id, input)).revision).toBe(3);
    expect((await service.original(ownerActor, binary.id, 3)).bytes).toEqual(Buffer.from([0, 1, 2, 3]));
    await expect(service.restore(ownerActor, binary.id, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { currentRevision: 3 } });
    await expect(service.restore(ownerActor, binary.id, { ...input, sourceRevision: 2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await prisma.materialVersion.count({ where: { materialId: binary.id } })).toBe(3);
  });

  it('restores rich references and rejects a restored source whose task image was revoked', async () => {
    const task = await prisma.task.create({ data: { title: '恢复图片任务' } });
    const image = await addTaskImage(task.id, { attachmentBase64: Buffer.from([0xff, 0xd8, 0xff, 4]).toString('base64'), mimeType: 'image/jpeg' });
    const alias = await prisma.resourceLegacyAlias.findUniqueOrThrow({ where: { sourceKind_sourceId: { sourceKind: 'task-image', sourceId: image.id } } });
    const body = richdoc('恢复来源', [{ id: 'restore-image', kind: 'image', target: { resourceId: alias.resourceId, revision: 1 } }]);
    const created = await create(body);
    await service.save(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 1, format: 'richdoc-v1', content: richdoc('无图') });
    const restored = await service.restore(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 2, sourceRevision: 1 });
    expect(restored).toMatchObject({ revision: 3, content: body, references: [{ nodeId: 'restore-image', revision: 1, accessible: true }] });
    await prisma.task.update({ where: { id: task.id }, data: { deletedAt: new Date().toISOString() } });
    await expect(service.restore(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 3, sourceRevision: 1 })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect((await service.read(ownerActor, created.id)).revision).toBe(3);
  });

  it('keeps Markdown relative mappings fixed without rewriting source and versions mapping-only edits', async () => {
    const file = await service.create(ownerActor, { requestId: randomUUID(), title: '相对原件', format: 'text', content: 'exact bytes' });
    const relativeReferences = [{ path: '../assets/picture.png', resourceId: file.id, revision: 1 }];
    const content = '# 原文\r\n![图](../assets/picture.png)\r\n';
    const created = await service.create(ownerActor, { requestId: randomUUID(), title: '相对图片', format: 'markdown', content, relativeReferences });
    expect(created).toMatchObject({ revision: 1, content, relativeReferences: [{ ...relativeReferences[0], accessible: true }] });
    const saved = await service.save(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 1, format: 'markdown', content: content + '更新' });
    expect(saved.relativeReferences).toHaveLength(1);
    const cleared = await service.save(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 2, format: 'markdown', content: content + '更新', relativeReferences: [] });
    expect(cleared).toMatchObject({ revision: 3, relativeReferences: [] });
    const restored = await service.restore(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 3, sourceRevision: 1 });
    expect(restored).toMatchObject({ revision: 4, content, relativeReferences: [{ ...relativeReferences[0], accessible: true }] });
    await expect(service.create(ownerActor, { requestId: randomUUID(), title: '非法路径', format: 'markdown', content, relativeReferences: [{ ...relativeReferences[0], path: '/absolute.png' }] })).rejects.toBeTruthy();
    await expect(service.save(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 4, format: 'markdown', content, relativeReferences: [{ ...relativeReferences[0], revision: 99 }] })).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
    expect((await service.read(ownerActor, created.id)).revision).toBe(4);
  });

  it('reads every product-schema source slice losslessly without refreshing its pinned revision', async () => {
    const body = richdoc('长正文😀'.repeat(10000));
    const created = await create(body);
    const parts: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await readResourceDocument(ownerActor, { materialId: created.id, revision: 1, cursor, limit: 12001 });
      expect(page).toMatchObject({ revision: 1, format: 'richdoc-v1', contentEncoding: 'product-json' });
      expect(page.content.length).toBeLessThanOrEqual(12001);
      parts.push(page.content);
      cursor = page.nextCursor ?? undefined;
      if (parts.length === 1) await service.save(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 1, format: 'richdoc-v1', content: richdoc('后续正文') });
    } while (cursor);
    expect(parts.length).toBeGreaterThan(1);
    expect(JSON.parse(parts.join(''))).toEqual(body);
  });

  it('keeps compatibility reads and receipts while pausing resource and legacy publication', async () => {
    const created = await create();
    const saved = await service.save(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 1, format: 'richdoc-v1', content: richdoc('暂停前正文') });
    const change = await prisma.changeRecord.findFirstOrThrow({ where: { requestId: saved.requestId } });
    const before = process.env.DOVUN_DOCUMENT_READ_ONLY;
    process.env.DOVUN_DOCUMENT_READ_ONLY = '1';
    try {
      expect(await service.read(ownerActor, created.id)).toMatchObject({ content: richdoc('暂停前正文'), writesPaused: true, readOnly: true, capabilities: { read: true, edit: false, download: true } });
      expect((await service.original(ownerActor, created.id, 1)).bytes.toString()).toContain('支付方案');
      expect((await service.receipt(ownerActor, saved.requestId)).revision).toBe(2);
      const old = await request(app).get(`/api/v1/knowledge/materials/${created.id}`).set('Cookie', auth.cookie);
      expect(old.body.data.versions[0]).toMatchObject({ content: '暂停前正文', readOnlyProjection: true });
      await expect(service.create(ownerActor, { requestId: randomUUID(), title: '暂停创建', format: 'text', content: '' })).rejects.toMatchObject({ code: 'DOCUMENT_READ_ONLY' });
      await expect(service.save(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 2, format: 'richdoc-v1', content: richdoc('不能写入') })).rejects.toMatchObject({ code: 'DOCUMENT_READ_ONLY' });
      await expect(service.restore(ownerActor, created.id, { requestId: randomUUID(), expectedRevision: 2, sourceRevision: 1 })).rejects.toMatchObject({ code: 'DOCUMENT_READ_ONLY' });
      await expect(service.organize(ownerActor, created.id, { requestId: randomUUID(), expectedOrganizationRevision: 1, title: '暂停改名' })).rejects.toMatchObject({ code: 'DOCUMENT_READ_ONLY' });
      for (const command of [
        { kind: 'material.update', targetId: created.id, expectedRevision: 2, input: { title: '旧改名' } },
        { kind: 'material.create', input: { uploadId: randomUUID(), duplicateAction: 'create', topicId: null, folderId: null, taskIds: [] } },
        { kind: 'material.organize', targetId: created.id, expectedRevision: 2, input: { expectedOrganizationRevision: 1, folderId: null } },
        { kind: 'libraryFolder.create', input: { parentId: null, name: '暂停目录' } },
        { kind: 'change.undo', targetId: change.id, input: {} },
      ]) await expect(new CommandService().submit(ownerActor, { requestId: randomUUID(), commands: [command] })).rejects.toMatchObject({ code: 'DOCUMENT_READ_ONLY' });
      expect((await service.read(ownerActor, created.id)).revision).toBe(2);
    } finally {
      if (before === undefined) delete process.env.DOVUN_DOCUMENT_READ_ONLY; else process.env.DOVUN_DOCUMENT_READ_ONLY = before;
    }
  });

  it('retains imported source JSON as an authorized independent original after remapping old identities', async () => {
    const bytes = Buffer.from(JSON.stringify(richdoc('原导出文档', [{ id: 'old-file', kind: 'file', target: { resourceId: 'old-workspace-only-id', revision: 7 } }])));
    const path = await storeKnowledgeBlob(bytes);
    const now = new Date().toISOString();
    const source = await prisma.material.create({ data: { title: '原始JSON来源', kind: 'attachment', managed: true, createdAt: now, updatedAt: now, versions: { create: { revision: 1, format: 'binary', content: '', contentHash: knowledgeHash(bytes), attachmentPath: path, fileName: 'source.json', mimeType: 'application/json', createdAt: now } } } });
    const imported = await service.create(ownerActor, { requestId: randomUUID(), title: '新身份文档', format: 'richdoc-v1', content: richdoc('独立原件'), managed: true, importSource: { sourceOriginal: { resourceId: source.id, revision: 1 } } });
    expect((await service.original(ownerActor, imported.id, 1, true)).bytes).toEqual(bytes);
    await service.save(ownerActor, imported.id, { requestId: randomUUID(), expectedRevision: 1, format: 'richdoc-v1', content: richdoc('编辑之后') });
    expect((await service.original(ownerActor, imported.id, 2, true)).bytes).toEqual(bytes);
    expect((await new LibraryService().materials(ownerActor, {})).items.some((entry) => entry.id === imported.id)).toBe(false);
    await service.organize(ownerActor, imported.id, { requestId: randomUUID(), expectedOrganizationRevision: 1, folderId: null });
    expect((await service.read(ownerActor, imported.id)).managed).toBe(false);
  });
});
