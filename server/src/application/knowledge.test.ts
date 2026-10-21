import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import express from 'express';
import request from 'supertest';
import { prisma } from '../infrastructure/prisma.js';
import { CommandService, workspaceEvents } from './commands.js';
import { actorFromConnection, ownerActor, type Actor } from './security.js';
import { KnowledgeService, knowledgeStorageRoot, readLabels, registerKnowledgeCommands, takeKnowledgeSnapshot } from './knowledge.js';
import { KnowledgeGraph, registerGraphCommands } from './knowledge-graph.js';
import { OrganizationService, type OrganizationModel } from './knowledge-organizations.js';
import { ReviewService } from './reviews.js';
import { followingOccurrence, latestOccurrence, scheduledInstant } from './reviews-clock.js';
import { createKnowledgeRouter } from '../routes/knowledge.js';
import { createReviewsRouter } from '../routes/reviews.js';
import { clearAutoMemory } from './auto-memory.js';
import { clearLibraryData, clearLibraryTaxonomy } from './library/cleanup.js';

registerKnowledgeCommands();
registerGraphCommands();
const commands = new CommandService();
const knowledge = new KnowledgeService();
process.env.KNOWLEDGE_STORAGE_ROOT = resolve(process.cwd(), 'data/test-knowledge-blobs');
async function clean() {
  await clearAutoMemory(prisma);
  await clearLibraryData(prisma);
  await prisma.reviewBatch.deleteMany(); await prisma.reviewRule.deleteMany();
  await prisma.organizationRequest.deleteMany(); await prisma.workingBrief.deleteMany();
  await prisma.graphLink.deleteMany(); await prisma.entity.deleteMany();
  await prisma.memoryVersion.deleteMany(); await prisma.memory.deleteMany();
  await prisma.materialVersion.deleteMany(); await prisma.material.deleteMany();
  await clearLibraryTaxonomy(prisma);
  await prisma.proposal.deleteMany(); await prisma.requestReceipt.deleteMany(); await prisma.changeRecord.deleteMany();
  await prisma.connection.deleteMany();
  await prisma.taskTag.deleteMany(); await prisma.taskTopicAssignment.deleteMany(); await prisma.task.updateMany({ data: { parentId: null } }); await prisma.task.deleteMany(); await prisma.topic.deleteMany();
}
async function write(kind: string, input: Record<string, unknown>, targetId?: string, expectedRevision?: number) {
  const response = await commands.submit(ownerActor, { requestId: randomUUID(), commands: [{ kind, input, targetId, expectedRevision }] });
  expect(response.status).toBe('applied');
  return { ...response.results[0], changeId: response.changeId };
}
const topic = async () => (await write('topic.create', { name: '中文项目' })).id as string;
const material = (topicId: string | null, title = '来源文档', content = '项目采用 SQLite，保留中文决策。') => write('material.create', { topicId, title, content, kind: 'markdown' });
const ref = (row: { id: string; revision: number; contentHash: string }) => ({ type: 'material', id: row.id, revision: row.revision, hash: row.contentHash });
function evidenceSummaries(preview: { preview: unknown }) {
  return (preview.preview as Array<{ detail: { evidenceSummaries: Array<Record<string, unknown>> } }>)[0].detail.evidenceSummaries;
}
const api = express();
api.use(express.json());
api.use((req, _res, next) => { (req as express.Request & { actor: Actor }).actor = ownerActor; next(); });
api.use(createKnowledgeRouter());
api.use('/api/v1/reviews', createReviewsRouter());
api.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) return res.status(400).json({ data: null, error: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), code: 'VALIDATION_ERROR' });
  res.status(error.status ?? 500).json({ error: error.message, code: error.code });
});

describe('knowledge evidence and review closed loops', () => {
  beforeEach(clean);
  afterAll(async () => { await clean(); /* A dedicated, resolved test artifact directory only. */ const root = knowledgeStorageRoot(); if (root.endsWith('test-knowledge-blobs')) await rm(root, { recursive: true, force: true }); });

  it('keeps immutable material versions and propagates stale evidence without deleting confirmed memory', async () => {
    const project = await topic();
    const source = await material(project);
    const memory = await write('memory.create', { topicId: project, title: '数据库决定', content: '使用 SQLite', kind: 'decision', evidence: [ref(source)] });
    const derived = await write('memory.create', { topicId: project, title: '实现约束', content: '保持单机数据库', evidence: [{ type: 'memory', id: memory.id, revision: memory.revision }] });
    await write('material.update', { content: '改为新的数据库方案' }, source.id, 1);
    expect((await knowledge.material(ownerActor, source.id)).versions.map((row) => row.content)).toEqual(['改为新的数据库方案', source.content]);
    expect(await knowledge.memory(ownerActor, memory.id)).toMatchObject({ status: 'active', health: 'needs_review' });
    expect(await knowledge.memory(ownerActor, derived.id)).toMatchObject({ health: 'needs_review' });
    expect((await takeKnowledgeSnapshot(ownerActor, { topicId: project })).sources.filter((row) => row.type === 'memory')).toHaveLength(0);
  });

  it('rejects source/target races during common proposal confirmation and never bypasses scope', async () => {
    const project = await topic(); const source = await material(project);
    const actor: Actor = { id: 'external-test', kind: 'internal', topicIds: [project], includeInbox: false, autoActions: [], revision: 1 };
    const response = await commands.submit(actor, { requestId: 'candidate', commands: [{ kind: 'memory.create', input: { topicId: project, title: '数据库', content: 'SQLite', evidence: [ref(source)] } }] });
    expect(response.status).toBe('pending_approval'); expect(await prisma.memory.count()).toBe(0);
    await write('material.update', { content: '源文件已改' }, source.id, 1);
    await expect(commands.approve(ownerActor, response.proposalId, { requestId: 'confirm', expectedRevision: 1 })).rejects.toMatchObject({ code: 'SOURCE_STALE' });
    expect(await prisma.memory.count()).toBe(0);
    const other = await topic();
    await expect(knowledge.materials(actor, other)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(commands.submit(actor, { requestId: 'denied', commands: [{ kind: 'memory.create', input: { topicId: other, title: '越权', content: '拒绝', evidence: [ref(source)] } }] })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });

  it('creates linked material/memory in one common transaction and undoes it with monotonic history', async () => {
    const project = await topic();
    const created = await commands.submit(ownerActor, { requestId: 'linked', commands: [
      { kind: 'material.create', clientRef: 'source', input: { topicId: project, title: '证据', content: '已确认采用本地存储' } },
      { kind: 'memory.create', input: { topicId: project, title: '本地存储', content: '采用本地存储', evidence: [{ type: 'material', id: { $ref: 'source' }, revision: 1 }] } },
    ] });
    expect(created.status).toBe('applied');
    expect(created.results[1].evidence[0].id).toBe(created.results[0].id);
    await commands.submit(ownerActor, { requestId: 'undo-linked', commands: [{ kind: 'change.undo', targetId: created.changeId, input: {} }] });
    expect(await prisma.memory.findUnique({ where: { id: created.results[1].id } })).toMatchObject({ status: 'retired', revision: 2 });
    expect((await prisma.material.findUniqueOrThrow({ where: { id: created.results[0].id } })).archivedAt).toBeTruthy();
    expect(await prisma.memoryVersion.count()).toBe(2);
  });

  it('retains manual brief notes across regeneration and detects a stale note save', async () => {
    const project = await topic();
    const initial = await knowledge.brief(ownerActor, project);
    await knowledge.saveBrief(ownerActor, { topicId: project, expectedVersion: initial.revision, manualNotes: '本周只关注文档' });
    const saved = await prisma.workingBrief.findUniqueOrThrow({ where: { id: `topic:${project}` } });
    expect(await knowledge.briefNotes(ownerActor, project)).toEqual({ manualNotes: '本周只关注文档' });
    const untouched = await prisma.workingBrief.findUniqueOrThrow({ where: { id: `topic:${project}` } });
    expect(untouched).toMatchObject({ revision: saved.revision, content: saved.content, generatedAt: saved.generatedAt });
    const fresh = await topic();
    expect(await knowledge.briefNotes(ownerActor, fresh)).toEqual({ manualNotes: '' });
    expect(await prisma.workingBrief.findUnique({ where: { id: `topic:${fresh}` } })).toBeNull();
    await write('task.create', { topicId: project, title: '完善文档' });
    const regenerated = await knowledge.brief(ownerActor, project);
    expect(regenerated.manualNotes).toBe('本周只关注文档'); expect(regenerated.content).toContain('完善文档'); expect(regenerated.revision).toBe(2);
    await expect(knowledge.saveBrief(ownerActor, { topicId: project, expectedVersion: 1, manualNotes: '旧页面' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('uses deterministic Chinese literal search with history, task hits and honest pagination', async () => {
    const project = await topic();
    await material(project, '数据库 SQLite', '保持中文可检索');
    await write('task.create', { topicId: project, title: '数据库 SQLite', description: '实现中文检索' });
    const memory = await write('memory.create', { topicId: project, title: '数据库 SQLite', content: '使用字面检索' });
    const first = await knowledge.search(ownerActor, { topicId: project, q: '数据库 ｓｑｌｉｔｅ', limit: 1 });
    expect(first.total).toBe(3); expect(first.hasMore).toBe(true); expect(first.nextCursor).toBe(1);
    const repeated = await knowledge.search(ownerActor, { topicId: project, q: '数据库 ｓｑｌｉｔｅ', limit: 1 });
    expect(repeated.items).toEqual(first.items);
    await write('memory.retire', { reason: '已被替代' }, memory.id, memory.revision);
    expect((await knowledge.search(ownerActor, { topicId: project, q: '字面检索' })).total).toBe(0);
    expect((await knowledge.search(ownerActor, { topicId: project, q: '字面检索', includeHistory: true })).total).toBe(2);
  });

  it('does not write attachments during preview and preserves the byte-exact original on apply', async () => {
    const project = await topic();
    const before = await readdir(knowledgeStorageRoot()).catch(() => []);
    const input = { topicId: project, title: '原件', kind: 'attachment', attachmentBase64: Buffer.from('opaque binary\0\x01').toString('base64'), fileName: '原件.pdf', mimeType: 'application/pdf' };
    await commands.preview(ownerActor, { commands: [{ kind: 'material.create', input }] });
    expect(await readdir(knowledgeStorageRoot()).catch(() => [])).toEqual(before);
    const row = await write('material.create', input);
    expect((await knowledge.attachment(ownerActor, row.id, 1)).bytes).toEqual(Buffer.from('opaque binary\0\x01'));
    expect((await knowledge.material(ownerActor, row.id)).versions[0]).not.toHaveProperty('attachmentPath');
  });

  it('exports immutable attachment originals and blocks localhost link capture without altering evidence', async () => {
    const project = await topic();
    await write('material.create', { topicId: project, kind: 'attachment', title: '原件', fileName: '原件.bin', attachmentBase64: Buffer.from([0, 1, 2, 255]).toString('base64') });
    const bundle = await request(api).get('/export').query({ topicId: project });
    expect(bundle.status).toBe(200);
    expect(bundle.body.materials[0].versions[0].attachmentBase64).toBe('AAEC/w==');
    expect(bundle.text).not.toContain('attachmentPath');
    const link = await write('material.create', { topicId: project, kind: 'link', title: '受限本机链接', uri: 'http://127.0.0.1:3001/api/tasks' });
    const denied = await request(api).post(`/materials/${link.id}/fetch`).send({ expectedVersion: 1 });
    expect(denied.body.code).toBe('HTTP_TARGET_DENIED');
    expect((await knowledge.material(ownerActor, link.id)).revision).toBe(1);
  });

  it('filters and sorts materials, and reads the file name from the current version', async () => {
    const project = await topic();
    const task = await write('task.create', { topicId: project, title: '回填任务' });
    const text = await write('material.create', { topicId: project, kind: 'text', title: 'A 旧文本', content: '旧正文' });
    await prisma.material.update({ where: { id: text.id }, data: { createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' } });
    const attachment = await write('material.create', { topicId: project, kind: 'attachment', title: 'B 说明', taskId: task.id, fileName: '说明.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', attachmentBase64: Buffer.from('v1').toString('base64') });
    await write('material.update', { fileName: '说明-v2.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', attachmentBase64: Buffer.from('v2').toString('base64') }, attachment.id, attachment.revision);
    await prisma.material.update({ where: { id: attachment.id }, data: { createdAt: '2026-01-01T00:30:00.000Z' } });
    const archived = await write('material.create', { topicId: project, kind: 'text', title: '已归档说明', content: '归档正文' });
    await write('material.archive', { archived: true }, archived.id, archived.revision);

    const defaults = await knowledge.materials(ownerActor, project);
    expect(defaults.items.map((item) => item.title)).toEqual(['B 说明', 'A 旧文本']);
    expect(defaults.items.map((item) => item.id)).not.toContain(archived.id);
    const byTitle = await knowledge.materials(ownerActor, project, { sort: 'title', dir: 'asc' });
    expect(byTitle.items.map((item) => item.title)).toEqual(['A 旧文本', 'B 说明']);
    const linked = await knowledge.materials(ownerActor, project, { linked: 'task' });
    expect(linked.items).toHaveLength(1);
    expect(linked.items[0]).toMatchObject({ id: attachment.id, fileName: '说明-v2.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', taskTitle: '回填任务' });
    expect(linked.items[0]).not.toHaveProperty('attachmentPath');
    expect(linked.items[0]).not.toHaveProperty('attachmentBase64');
    expect((await knowledge.materials(ownerActor, project, { since: '2026-01-01T00:00:00.000Z' })).items.map((item) => item.id)).toEqual([attachment.id]);
    expect((await knowledge.materials(ownerActor, project, { since: '2026-01-01T08:00:00+08:00' })).items.map((item) => item.id)).toEqual([attachment.id]);
    expect((await knowledge.materials(ownerActor, project, { archived: 'only' })).items.map((item) => item.id)).toEqual([archived.id]);
    expect((await knowledge.materials(ownerActor, project, { kind: 'text' })).items.map((item) => item.id)).toEqual([text.id]);
    const everything = await knowledge.materials(ownerActor, project, { includeArchived: true });
    expect(everything.items).toHaveLength(3);
    expect(everything.items.map((item) => item.id)).toEqual(expect.arrayContaining([text.id, attachment.id, archived.id]));

    const listed = await request(api).get('/materials').query({ topicId: project, sort: 'title', dir: 'asc', linked: 'task' });
    expect(listed.status).toBe(200);
    expect(listed.body.data.items.map((item: { title: string }) => item.title)).toEqual(['B 说明']);
    expect(listed.body.data.items[0]).toMatchObject({ fileName: '说明-v2.docx', taskTitle: '回填任务' });
    expect(listed.text).not.toContain('attachmentPath');
    expect(listed.text).not.toContain('attachmentBase64');
    const shifted = await request(api).get(`/materials?topicId=${project}&since=${encodeURIComponent('2026-01-01T08:00:00+08:00')}`);
    expect(shifted.status).toBe(200);
    expect(shifted.body.data.items.map((item: { id: string }) => item.id)).toEqual([attachment.id]);
    const rejected = await request(api).get('/materials').query({ topicId: project, sort: 'size' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('VALIDATION_ERROR');
  });

  it('relinks a material across lists without a content version and restores links on undo', async () => {
    const project = await topic();
    const task = await write('task.create', { topicId: project, title: '对接任务' });
    const foreign = await write('task.create', { topicId: await topic(), title: '别的清单' });
    const row = await write('material.create', { topicId: project, kind: 'attachment', title: '说明', fileName: '说明.md', attachmentBase64: Buffer.from('# 标题').toString('base64') });
    const versionsBefore = await prisma.materialVersion.count({ where: { materialId: row.id } });
    const linked = await write('material.update', { taskId: task.id }, row.id, row.revision);
    expect(linked).toMatchObject({ revision: 1, organizationRevision: 2, taskId: task.id });
    expect(await prisma.materialVersion.count({ where: { materialId: row.id } })).toBe(versionsBefore);
    expect((await knowledge.materials(ownerActor, project, { linked: 'task' })).items[0]).toMatchObject({ id: row.id, taskTitle: '对接任务' });
    const titled = await write('material.update', { title: '新标题' }, row.id, linked.revision);
    expect(titled).toMatchObject({ revision: 2, taskId: task.id, title: '新标题', organizationRevision: 2 });
    const cleared = await write('material.update', { taskId: null }, row.id, titled.revision);
    expect(cleared).toMatchObject({ revision: 2, taskId: null, organizationRevision: 3 });
    expect(await prisma.materialVersion.count({ where: { materialId: row.id } })).toBe(versionsBefore + 1);
    await commands.submit(ownerActor, { requestId: randomUUID(), commands: [{ kind: 'change.undo', targetId: cleared.changeId, input: {} }] });
    const restored = await prisma.material.findUniqueOrThrow({ where: { id: row.id } });
    expect(restored).toMatchObject({ revision: 2, taskId: task.id, title: '新标题', organizationRevision: 4 });
    expect(await prisma.materialVersion.count({ where: { materialId: row.id } })).toBe(versionsBefore + 1);
    expect((await knowledge.attachment(ownerActor, row.id, restored.revision)).bytes.toString()).toBe('# 标题');
    expect((await prisma.materialTaskLink.findUniqueOrThrow({ where: { materialId_taskId: { materialId: row.id, taskId: task.id } } })).legacy).toBe(true);
    const across = await write('material.update', { taskId: foreign.id }, row.id, restored.revision);
    expect(across).toMatchObject({ revision: 2, taskId: foreign.id });
    expect(await prisma.materialTaskLink.findUnique({ where: { materialId_taskId: { materialId: row.id, taskId: task.id } } })).toBeNull();
    expect((await prisma.materialTaskLink.findUniqueOrThrow({ where: { materialId_taskId: { materialId: row.id, taskId: foreign.id } } })).legacy).toBe(true);

    const inboxTask = await write('task.create', { title: '收集任务', topicId: null });
    const note = await write('material.create', { topicId: null, kind: 'text', title: '收集材料', content: '正文' });
    const linkedNote = await write('material.update', { taskId: inboxTask.id }, note.id, note.revision);
    expect(linkedNote).toMatchObject({ taskId: inboxTask.id, revision: note.revision });
    const moved = await write('material.update', { taskId: task.id }, note.id, linkedNote.revision);
    expect(moved).toMatchObject({ taskId: task.id, revision: note.revision });
  });

  it('uses one proposal protocol for built-in and external organization and confirms exactly once', async () => {
    const project = await topic(); const source = await material(project);
    const output = { summary: '确认存储决策', commands: [{ kind: 'memory.create', input: { topicId: project, title: '持久化选择', content: '使用 SQLite', evidence: [ref(source)] } }] };
    const model: OrganizationModel = { complete: async () => ({ text: JSON.stringify(output) }) };
    const organizations = new OrganizationService(model);
    const request = await organizations.create(ownerActor, { topicId: project, purpose: '提炼决定', provider: 'builtin' });
    const generated = await organizations.generate(ownerActor, request.id);
    expect(generated.status).toBe('proposed'); expect(await prisma.memory.count()).toBe(0);
    const approved = await commands.approve(ownerActor, generated.proposalIds[0], { requestId: 'accept', expectedRevision: 1 });
    expect(approved.status).toBe('applied');
    expect(await commands.approve(ownerActor, generated.proposalIds[0], { requestId: 'accept', expectedRevision: 1 })).toEqual(approved);
    expect(await prisma.memory.count()).toBe(1);
    const external = await organizations.create(ownerActor, { topicId: project, purpose: '外部建议', provider: 'external', memoryIds: [] });
    const externalResult = await organizations.submitCandidates(ownerActor, external.id, { summary: '无需新增', commands: [] });
    expect(externalResult.status).toBe('completed');
    expect(await organizations.submitCandidates(ownerActor, external.id, { summary: '无需新增', commands: [] })).toMatchObject({ id: external.id });
  });

  it('checks material evidence again when confirming an organization task suggestion', async () => {
    const project = await topic(); const source = await material(project);
    const task = await write('task.create', { topicId: project, title: '待整理' });
    const service = new OrganizationService();
    const org = await service.create(ownerActor, { topicId: project, purpose: '改标题', provider: 'external' });
    const proposed = await service.submitCandidates(ownerActor, org.id, { summary: '建议', commands: [{ kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { title: '新标题' } }] });
    await write('material.update', { content: '来源变化' }, source.id, source.revision);
    await expect(commands.approve(ownerActor, proposed.proposalIds[0], { requestId: 'stale-task', expectedRevision: 1 })).rejects.toMatchObject({ code: 'SOURCE_STALE' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe('待整理');
  });

  it('reuses identical pending suggestions across daily and weekly organization requests', async () => {
    const project = await topic(); const source = await material(project);
    const service = new OrganizationService();
    const one = await service.create(ownerActor, { topicId: project, purpose: '每日', provider: 'external' });
    const two = await service.create(ownerActor, { topicId: project, purpose: '每周', provider: 'external' });
    const output = { summary: '建议', commands: [{ kind: 'memory.create', input: { topicId: project, title: '共用建议', content: '采用 SQLite', evidence: [ref(source)] } }] };
    const first = await service.submitCandidates(ownerActor, one.id, output);
    const second = await service.submitCandidates(ownerActor, two.id, output);
    expect(first.proposalIds).toEqual(second.proposalIds);
    expect(await prisma.proposal.count()).toBe(1);
  });

  it('does not undo an evidence version after a later confirmed memory references it', async () => {
    const project = await topic(); const source = await material(project);
    await write('memory.create', { topicId: project, title: '依赖该材料', content: '形成结论', evidence: [ref(source)] });
    await expect(commands.submit(ownerActor, { requestId: 'unsafe-undo', commands: [{ kind: 'change.undo', targetId: source.changeId, input: {} }] })).rejects.toMatchObject({ code: 'UNDO_CONFLICT' });
    expect((await prisma.material.findUniqueOrThrow({ where: { id: source.id } })).archivedAt).toBeNull();
  });

  it('keeps connection provenance, forces review despite direct-write grants, and checks revocation', async () => {
    const project = await topic(); const task = await write('task.create', { topicId: project, title: '原始任务' });
    const timestamp = new Date().toISOString();
    const connection = await prisma.connection.create({ data: { name: '外部整理', host: 'codex', tokenHash: randomUUID(), topicIds: JSON.stringify([project]), autoActions: JSON.stringify(['task.content']), createdAt: timestamp, updatedAt: timestamp } });
    const actor = actorFromConnection(connection);
    const organizations = new OrganizationService();
    const org = await organizations.create(actor, { topicId: project, purpose: '整理', provider: 'external' });
    const candidate = await organizations.submitCandidates(actor, org.id, { summary: '建议', commands: [{ kind: 'task.update', targetId: task.id, expectedRevision: 1, input: { title: '提议标题' } }] });
    expect(candidate.status).toBe('proposed');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe('原始任务');
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: candidate.proposalIds[0] } })).connectionId).toBe(connection.id);
    await prisma.connection.update({ where: { id: connection.id }, data: { status: 'revoked', revision: { increment: 1 } } });
    await expect(commands.approve(ownerActor, candidate.proposalIds[0], { requestId: 'revoked-confirm', expectedRevision: 1 })).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
  });

  it('allows task edits and material-backed memories in the same reviewed organization batch', async () => {
    const project = await topic(); const source = await material(project); const task = await write('task.create', { topicId: project, title: '原任务' });
    const organizations = new OrganizationService();
    const org = await organizations.create(ownerActor, { topicId: project, purpose: '组合整理', provider: 'external' });
    const result = await organizations.submitCandidates(ownerActor, org.id, { summary: '建议', commands: [
      { kind: 'task.update', targetId: task.id, expectedRevision: 1, input: { title: '已整理' } },
      { kind: 'memory.create', input: { topicId: project, title: '设计决定', content: '采用 SQLite', evidence: [ref(source)] } },
    ] });
    await commands.approve(ownerActor, result.proposalIds[0], { requestId: 'mixed-confirm', expectedRevision: 1 });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe('已整理');
    expect(await prisma.memory.count()).toBe(1);
  });

  it('saves a useful model-free review even when model generation fails', async () => {
    const project = await topic(); await write('task.create', { topicId: project, title: '无模型也能回顾', dueDate: '2020-01-01' });
    const model: OrganizationModel = { complete: async () => { throw new Error('模型未配置'); } };
    const reviews = new ReviewService(new OrganizationService(model));
    const rule = await reviews.createRule(ownerActor, { name: '每日回顾', topicIds: [project], provider: 'builtin' });
    expect(rule.enabled).toBe(false);
    const batch = await reviews.run(ownerActor, rule.id);
    expect(batch).toMatchObject({ status: 'partial' }); expect(batch?.content).toContain('逾期未完成：1'); expect(batch?.error).toContain('模型未配置');
    expect(await prisma.memory.count()).toBe(0); expect(await prisma.run.count()).toBe(0);
    expect((await prisma.reviewRule.findUniqueOrThrow({ where: { id: rule.id } })).coverageThrough).toBeTruthy();
  });

  it('keeps external MCP reviews manual while explicitly selected CLI reviews generate proposals', async () => {
    const project = await topic(); await material(project);
    const calls: string[] = [];
    const reviews = new ReviewService(new OrganizationService(), async (input) => { calls.push(input.provider ?? 'missing'); return { summary: '无需新增建议', commands: [] }; });
    const manual = await reviews.createRule(ownerActor, { name: '外部手动', topicIds: [project], provider: 'external' });
    const batch = await reviews.run(ownerActor, manual.id);
    expect(batch?.status).toBe('partial'); expect(calls).toEqual([]);
    expect((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: batch!.organizationIds[0] } })).status).toBe('pending');
    const automatic = await reviews.createRule(ownerActor, { name: '明确CLI', topicIds: [project], provider: 'claude' });
    expect((await reviews.run(ownerActor, automatic.id))?.status).toBe('ready'); expect(calls).toEqual(['claude']);
    expect(await prisma.run.count()).toBe(0);
  });

  it('does not silently refresh review evidence between the base report and AI request', async () => {
    const project = await topic(); const source = await material(project);
    class SourceRaceOrganizations extends OrganizationService {
      override async create(actor: Actor, input: unknown) {
        await write('material.update', { content: '报告之后变动' }, source.id, 1);
        return super.create(actor, input);
      }
    }
    let calls = 0;
    const reviews = new ReviewService(new SourceRaceOrganizations(), async () => { calls++; return { summary: '不应调用', commands: [] }; });
    const rule = await reviews.createRule(ownerActor, { name: '固定来源', topicIds: [project], provider: 'codex' });
    const batch = await reviews.run(ownerActor, rule.id);
    expect(batch).toMatchObject({ status: 'partial' }); expect(batch?.error).toContain('SOURCE_STALE'); expect(calls).toBe(0);
    const request = await prisma.organizationRequest.findUniqueOrThrow({ where: { id: batch!.organizationIds[0] } });
    expect(request.status).toBe('stale'); expect(JSON.parse(request.snapshot).sources[0].revision).toBe(1);
    expect(await prisma.proposal.count()).toBe(0);
  });

  it('coalesces offline schedules to one latest period and does not replay after restart', async () => {
    const project = await topic(); const reviews = new ReviewService();
    const rule = await reviews.createRule(ownerActor, { name: '补跑', enabled: true, topicIds: [project], frequency: 'daily', timeOfDay: '21:00', timeZone: 'Asia/Hong_Kong' });
    await prisma.reviewRule.update({ where: { id: rule.id }, data: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', coverageThrough: '2026-01-01T10:00:00.000Z' } });
    await reviews.tick(new Date('2026-01-10T15:00:00.000Z'));
    await reviews.tick(new Date('2026-01-10T15:01:00.000Z'));
    const batches = await reviews.batches(ownerActor, rule.id);
    expect(batches).toHaveLength(1); expect(batches[0].occurrenceKey).toBe('daily:2026-01-10'); expect(batches[0].content).toContain('2026-01-01T10:00:00.000Z');
    await reviews.updateRule(ownerActor, rule.id, { expectedVersion: 1, enabled: false });
    await reviews.tick(new Date('2026-01-11T15:00:00.000Z'));
    expect(await reviews.batches(ownerActor, rule.id)).toHaveLength(1);
  });

  it('publishes a terminal review event once and not again for a deduplicated period', async () => {
    const project = await topic(); const reviews = new ReviewService();
    const rule = await reviews.createRule(ownerActor, { name: '只通知新报告', topicIds: [project] });
    const events: unknown[] = [];
    const listener = (event: { kind?: string }) => { if (event.kind === 'review') events.push(event); };
    workspaceEvents.on('change', listener);
    try {
      const batch = await reviews.run(ownerActor, rule.id, { occurrenceKey: 'daily:2026-09-21' });
      await reviews.run(ownerActor, rule.id, { occurrenceKey: 'daily:2026-09-21' });
      expect(events).toEqual([{ kind: 'review', batchId: batch!.id, status: 'ready' }]);
    } finally { workspaceEvents.off('change', listener); }
  });

  it('soft-deletes a rule, keeps its batches, and rejects later runs', async () => {
    const project = await topic();
    const reviews = new ReviewService();
    const rule = await reviews.createRule(ownerActor, { name: '可删除', topicIds: [project], provider: 'none', enabled: true });
    const batch = await reviews.run(ownerActor, rule.id);
    expect(batch?.status).toBe('ready');
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    workspaceEvents.on('change', listener);
    const removed = await reviews.deleteRule(ownerActor, rule.id, { expectedVersion: rule.revision }).finally(() => workspaceEvents.off('change', listener));
    expect(removed).toMatchObject({ id: rule.id });
    expect(removed.deletedAt).toEqual(expect.any(String));
    expect(events).toEqual([{ kind: 'review-rule', ruleId: rule.id }]);
    expect(await reviews.rules(ownerActor)).toEqual([]);
    const batches = await reviews.batches(ownerActor);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ id: batch!.id, ruleName: '可删除', ruleDeleted: true });
    const before = await prisma.reviewBatch.count();
    await reviews.tick(new Date('2026-06-01T15:00:00.000Z'));
    await expect(reviews.run(ownerActor, rule.id)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(reviews.updateRule(ownerActor, rule.id, { expectedVersion: rule.revision + 1, name: '改名' })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(reviews.retry(ownerActor, batch!.id)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(reviews.deleteRule(ownerActor, rule.id, { expectedVersion: rule.revision })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(await prisma.reviewBatch.count()).toBe(before);
    const other = await reviews.createRule(ownerActor, { name: '仍在', topicIds: [project], provider: 'none' });
    await expect(reviews.deleteRule(ownerActor, other.id, { expectedVersion: other.revision + 5 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await prisma.reviewRule.findUniqueOrThrow({ where: { id: other.id } })).deletedAt).toBeNull();
    expect((await reviews.rules(ownerActor)).map((item) => item.id)).toEqual([other.id]);
  });

  it('deletes a rule through DELETE /api/v1/reviews/rules/:id', async () => {
    const project = await topic();
    const created = await request(api).post('/api/v1/reviews/rules').send({ name: '路由删除', topicIds: [project], provider: 'none' });
    expect(created.status).toBe(200);
    const id = created.body.data.id as string;
    const removed = await request(api).delete(`/api/v1/reviews/rules/${id}`).send({ expectedVersion: created.body.data.revision });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ data: { id }, error: null });
    expect(removed.body.data.deletedAt).toEqual(expect.any(String));
    const listed = await request(api).get('/api/v1/reviews/rules');
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([]);
    const missing = await request(api).delete(`/api/v1/reviews/rules/${id}`).send({ expectedVersion: created.body.data.revision });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  it('stores counts that match the report and hides them when an old snapshot has none', async () => {
    const project = await topic();
    const archived = await write('topic.create', { name: '归档清单' });
    await write('task.create', { topicId: project, title: '逾期', dueDate: '2020-01-01' });
    const blockedTask = await write('task.create', { topicId: project, title: '阻塞' });
    const doing = await write('task.update', { status: 'doing' }, blockedTask.id, blockedTask.revision);
    await write('task.update', { status: 'blocked' }, blockedTask.id, doing.revision);
    const doneTask = await write('task.create', { topicId: project, title: '完成' });
    await write('task.update', { status: 'done' }, doneTask.id, doneTask.revision);
    await write('task.create', { topicId: archived.id, title: '归档逾期', dueDate: '2020-01-01' });
    const reviews = new ReviewService();
    const rule = await reviews.createRule(ownerActor, { name: '计数', topicIds: [project, archived.id], provider: 'none' });
    await prisma.topic.update({ where: { id: archived.id }, data: { archivedAt: new Date().toISOString() } });
    const batch = await reviews.run(ownerActor, rule.id);
    const numbers = (label: string) => [...batch!.content.matchAll(new RegExp(`^- ${label}：(\\d+)$`, 'gm'))].reduce((sum, match) => sum + Number(match[1]), 0);
    expect(batch?.counts).toEqual({ added: 3, completed: 1, overdue: 1, blocked: 1 });
    expect(batch?.counts).toEqual({ added: numbers('新增'), completed: numbers('完成'), overdue: numbers('逾期未完成'), blocked: numbers('阻塞') });
    expect(batch?.content).toContain('已跳过归档清单：归档清单');
    expect(batch?.snapshot).toMatchObject({ counts: batch?.counts, timeZone: 'Asia/Hong_Kong' });
    await prisma.reviewBatch.update({ where: { id: batch!.id }, data: { snapshot: JSON.stringify({ from: '2026-01-01T00:00:00.000Z', through: '2026-01-02T00:00:00.000Z', ruleRevision: 1, sources: [], skipped: [] }) } });
    expect((await reviews.batch(ownerActor, batch!.id)).counts).toBeNull();
    expect((await reviews.batches(ownerActor, rule.id))[0].counts).toBeNull();
  });

  it('counts a completion by completedAt and ignores a later title edit', async () => {
    const project = await topic();
    const early = await write('task.create', { topicId: project, title: '早已完成' });
    const done = await write('task.update', { status: 'done' }, early.id, early.revision);
    await prisma.task.update({ where: { id: early.id }, data: { completedAt: '2020-01-01T00:00:00.000Z', completedAtEstimated: false } });
    await write('task.update', { title: '早已完成但刚改标题' }, early.id, done.revision);
    const stored = await prisma.task.findUniqueOrThrow({ where: { id: early.id } });
    expect(stored).toMatchObject({ status: 'done', completedAt: '2020-01-01T00:00:00.000Z', completedAtEstimated: false });
    const reviews = new ReviewService();
    const rule = await reviews.createRule(ownerActor, { name: '完成口径', topicIds: [project], provider: 'none' });
    const stale = await reviews.run(ownerActor, rule.id);
    const numbers = (content: string, label: string) => [...content.matchAll(new RegExp(`^- ${label}：(\\d+)$`, 'gm'))].reduce((sum, match) => sum + Number(match[1]), 0);
    expect(stale?.counts?.completed).toBe(0);
    expect(numbers(stale!.content, '完成')).toBe(0);
    const fresh = await write('task.create', { topicId: project, title: '窗口内完成' });
    await write('task.update', { status: 'done' }, fresh.id, fresh.revision);
    const current = await reviews.run(ownerActor, rule.id, { occurrenceKey: 'manual:completed-at-window', at: new Date(Date.now() + 5_000) });
    expect(current?.counts?.completed).toBe(1);
    expect(numbers(current!.content, '完成')).toBe(1);
    expect(current?.counts).toEqual({ added: numbers(current!.content, '新增'), completed: numbers(current!.content, '完成'), overdue: numbers(current!.content, '逾期未完成'), blocked: numbers(current!.content, '阻塞') });
  });

  it('counts pending proposals recorded on the organization request', async () => {
    const project = await topic();
    const task = await write('task.create', { topicId: project, title: '原始任务' });
    const withProposal = new ReviewService(new OrganizationService(), async () => ({ summary: '建议', commands: [{ kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { title: '提议标题' } }] }));
    const rule = await withProposal.createRule(ownerActor, { name: '带建议', topicIds: [project], provider: 'claude' });
    const batch = await withProposal.run(ownerActor, rule.id);
    expect(batch?.pendingProposalCount).toBe(1);
    const proposalId = JSON.parse((await prisma.organizationRequest.findUniqueOrThrow({ where: { id: batch!.organizationIds[0] } })).proposalIds)[0] as string;
    await commands.approve(ownerActor, proposalId, { requestId: 'review-proposal', expectedRevision: 1 });
    expect((await withProposal.batch(ownerActor, batch!.id)).pendingProposalCount).toBe(0);
    const empty = new ReviewService(new OrganizationService(), async () => ({ summary: '无', commands: [] }));
    const quiet = await empty.createRule(ownerActor, { name: '无建议', topicIds: [project], provider: 'codex' });
    expect((await empty.run(ownerActor, quiet.id))?.pendingProposalCount).toBe(0);
  });

  it('blocks a newly enabled built-in review until a model is configured', async () => {
    const project = await topic();
    const unconfigured = new ReviewService(new OrganizationService(), undefined, async () => false);
    await expect(unconfigured.createRule(ownerActor, { name: '未配置', topicIds: [project], provider: 'builtin', enabled: true })).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED', status: 400, message: '未配置模型服务，请先配置模型再启用内置模型回顾' });
    const paused = await unconfigured.createRule(ownerActor, { name: '暂停内置', topicIds: [project], provider: 'builtin', enabled: false });
    expect(paused.enabled).toBe(false);
    await expect(unconfigured.updateRule(ownerActor, paused.id, { expectedVersion: paused.revision, enabled: true })).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED', status: 400 });
    const plain = await unconfigured.createRule(ownerActor, { name: '基础', topicIds: [project], provider: 'none', enabled: true });
    expect(plain).toMatchObject({ enabled: true, provider: 'none' });
    const configured = new ReviewService(new OrganizationService(), undefined, async () => true);
    const enabled = await configured.createRule(ownerActor, { name: '已配置', topicIds: [project], provider: 'builtin', enabled: true });
    expect(enabled).toMatchObject({ enabled: true, provider: 'builtin' });
    const renamed = await unconfigured.updateRule(ownerActor, enabled.id, { expectedVersion: enabled.revision, name: '只改名' });
    expect(renamed).toMatchObject({ name: '只改名', enabled: true, provider: 'builtin' });
  });

  it('stores importance, labels and caller origin, and sorts active memories above history', async () => {
    const project = await topic();
    const quiet = await write('memory.create', { topicId: project, title: '普通记录', content: '默认重要度', labels: ['本机环境'] });
    const loud = await write('memory.create', { topicId: project, title: '关键决策', content: '使用 SQLite', kind: 'decision', importance: 5, labels: ['存储', '存储'] });
    expect(quiet).toMatchObject({ importance: 3, labels: ['本机环境'], origin: 'manual' });
    expect(loud.labels).toEqual(['存储']);
    const listed = await knowledge.memories(ownerActor, project);
    expect(listed.items.map((item) => item.id)).toEqual([loud.id, quiet.id]);
    expect(await prisma.entity.findMany({ where: { topicId: project }, orderBy: { name: 'asc' } })).toMatchObject([{ name: '存储' }, { name: '本机环境' }]);
    await commands.preview(ownerActor, { commands: [{ kind: 'memory.create', input: { topicId: project, title: '只预览', content: '不落库', labels: ['预览实体'] } }] });
    expect(await prisma.entity.findFirst({ where: { name: '预览实体' } })).toBeNull();
    await write('memory.retire', { reason: '先收起' }, quiet.id, quiet.revision);
    expect((await knowledge.memories(ownerActor, project)).items.map((item) => item.id)).toEqual([loud.id]);
    expect((await knowledge.memories(ownerActor, project, { status: 'history' })).items.map((item) => item.id)).toEqual([quiet.id]);
    const actor: Actor = { id: 'memory-origin', kind: 'internal', topicIds: [project], includeInbox: false, autoActions: [], revision: 1 };
    const pending = await commands.submit(actor, { requestId: 'origin-ai', commands: [{ kind: 'memory.create', input: { topicId: project, title: '外部整理', content: '由模型提议', evidence: [{ type: 'memory', id: loud.id, revision: loud.revision }] } }] });
    const approved = await commands.approve(ownerActor, pending.proposalId, { requestId: 'origin-approve', expectedRevision: 1 });
    expect(approved.results[0].origin).toBe('ai');
  });

  it('keeps fast search on titles and expands smart search by hop distance', async () => {
    const project = await topic();
    const source = await material(project, '材料甲', '正文里有火山这个词');
    const near = await write('memory.create', { topicId: project, title: '邻近记忆', content: '引用材料', evidence: [{ type: 'material', id: source.id, revision: source.revision, hash: source.contentHash }] });
    const far = await write('memory.create', { topicId: project, title: '更远记忆', content: '只引用邻近记忆', evidence: [{ type: 'memory', id: near.id, revision: near.revision }] });
    await write('memory.create', { topicId: project, title: '正文命中', content: '这里单独写到火山' });
    const graph = new KnowledgeGraph();
    expect((await graph.read(ownerActor, { topicId: project, q: '火山', mode: 'fast' })).nodes).toHaveLength(0);
    const smart = await graph.read(ownerActor, { topicId: project, q: '火山', mode: 'smart', range: 1 });
    expect(smart.nodes.map((node) => node.title).sort()).toEqual(['材料甲', '正文命中', '邻近记忆']);
    const one = await graph.read(ownerActor, { topicId: project, focusType: 'material', focusId: source.id, range: 1 });
    expect(one.nodes.map((node) => node.rawId).sort()).toEqual([source.id, near.id].sort());
    const two = await graph.read(ownerActor, { topicId: project, focusType: 'material', focusId: source.id, range: 2 });
    expect(two.nodes.map((node) => node.rawId).sort()).toEqual([source.id, near.id, far.id].sort());
    const answer = await graph.answer(ownerActor, { topicId: project, question: '火山存在于哪' }, async () => '依据 [material:' + source.id + ']');
    expect(answer.mode).toBe('model'); expect(answer.answer).toContain(source.id);
    const retrieved = await graph.answer(ownerActor, { topicId: project, question: '完全不存在的句子' }, async () => { throw new Error('未配置模型服务'); });
    expect(retrieved.mode).toBe('retrieval'); expect(retrieved.answer).toBeNull();
  });

  it('extracts wiki mentions, crystallizes three memories, and restores a renamed entity', async () => {
    const project = await topic();
    await write('memory.create', { topicId: project, title: '提到 [[SQLite]]', content: '第一种做法' });
    const graph = new KnowledgeGraph();
    expect((await graph.read(ownerActor, { topicId: project })).edges.some((edge) => edge.relation === 'mentions')).toBe(true);
    for (const title of ['甲', '乙', '丙']) await write('memory.create', { topicId: project, title, content: `${title}的原文`, labels: ['存储'] });
    await expect(write('memory.crystallize', { topicId: project, entityId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const entity = await prisma.entity.findFirstOrThrow({ where: { topicId: project, name: '存储' } });
    const crystal = await write('memory.crystallize', { topicId: project, entityId: entity.id });
    expect(crystal).toMatchObject({ kind: 'crystal', labels: ['存储'] });
    expect(crystal.evidence).toHaveLength(3); expect(crystal.content).toContain('没有另作改写');
    const again = await write('memory.crystallize', { topicId: project, entityId: entity.id });
    expect(again.reused).toBe(true); expect(await prisma.memory.count({ where: { kind: 'crystal' } })).toBe(1);
    const renamed = await write('entity.update', { name: '本地存储' }, entity.id, entity.revision);
    expect(renamed.name).toBe('本地存储');
    expect(readLabels((await prisma.memory.findFirstOrThrow({ where: { title: '甲' } })).labels)).toEqual(['本地存储']);
    await commands.submit(ownerActor, { requestId: 'undo-rename', commands: [{ kind: 'change.undo', targetId: renamed.changeId, input: {} }] });
    expect((await prisma.entity.findUniqueOrThrow({ where: { id: entity.id } })).name).toBe('存储');
    expect(readLabels((await prisma.memory.findFirstOrThrow({ where: { title: '甲' } })).labels)).toEqual(['存储']);
  });

  it('puts scoped evidence summaries on the memory preview and keeps titles out of preconditions', async () => {
    const project = (await write('topic.create', { name: '依据清单' })).id as string;
    const hidden = (await write('topic.create', { name: '隐藏清单' })).id as string;
    const task = await write('task.update', { status: 'doing' }, (await write('task.create', { topicId: project, title: '依据任务' })).id, 1);
    const source = await material(project, '依据材料', '材料正文只出现在来源里');
    const prior = await write('memory.create', { topicId: project, title: '依据记忆', content: '记忆正文只出现在来源里', evidence: [{ type: 'material', id: source.id, revision: source.revision }] });
    const secret = await material(hidden, '越权标题不应出现', '越权正文不应出现');
    const inbox = await write('task.create', { topicId: null, title: '收集箱依据' });
    const preview = await commands.preview(ownerActor, { commands: [{ kind: 'memory.create', input: { topicId: project, title: '新记忆', content: '待确认正文', evidence: [
      { type: 'task', id: task.id, revision: task.revision },
      { type: 'material', id: source.id, revision: source.revision },
      { type: 'memory', id: prior.id, revision: prior.revision },
    ] } }] });
    const summaries = evidenceSummaries(preview);
    expect(summaries).toEqual([
      { type: 'task', id: task.id, revision: task.revision, title: '依据任务', topicId: project, topicName: '依据清单', status: 'doing' },
      { type: 'material', id: source.id, revision: source.revision, title: '依据材料', topicId: project, topicName: '依据清单' },
      { type: 'memory', id: prior.id, revision: prior.revision, title: '依据记忆', topicId: project, topicName: '依据清单' },
    ]);
    for (const summary of summaries) expect(summary).not.toHaveProperty('content');
    expect(JSON.stringify(summaries)).not.toContain('材料正文只出现在来源里');
    expect(JSON.stringify(summaries)).not.toContain('记忆正文只出现在来源里');
    const inboxPreview = await commands.preview(ownerActor, { commands: [{ kind: 'memory.create', input: { topicId: null, title: '收集箱记忆', content: '挂在收集箱', evidence: [{ type: 'task', id: inbox.id, revision: inbox.revision }] } }] });
    expect(evidenceSummaries(inboxPreview)).toEqual([{ type: 'task', id: inbox.id, revision: inbox.revision, title: '收集箱依据', topicId: null, topicName: null, status: 'todo' }]);

    const timestamp = new Date().toISOString();
    const connection = await prisma.connection.create({ data: { name: '依据连接', host: 'codex', tokenHash: randomUUID(), topicIds: JSON.stringify([project]), includeInbox: true, autoActions: '[]', createdAt: timestamp, updatedAt: timestamp } });
    const actor = actorFromConnection(connection);
    await expect(commands.submit(actor, { requestId: randomUUID(), commands: [{ kind: 'memory.create', input: { topicId: project, title: '越权候选', content: '不应写入', evidence: [{ type: 'material', id: secret.id, revision: secret.revision }] } }] })).rejects.toMatchObject({ code: 'SCOPE_DENIED', message: expect.not.stringContaining('越权标题不应出现') });
    expect(await prisma.proposal.count({ where: { commands: { contains: '越权候选' } } })).toBe(0);
    expect(await prisma.memory.count({ where: { title: '越权候选' } })).toBe(0);
    await expect(commands.submit(actor, { requestId: randomUUID(), commands: [{ kind: 'memory.create', input: { topicId: project, title: '过期依据', content: '版本不对', evidence: [{ type: 'material', id: source.id, revision: source.revision + 9 }] } }] })).rejects.toMatchObject({ code: 'SOURCE_STALE' });

    const titled = await material(project, '批准前标题', '材料正文保持不变');
    const pending = await commands.submit(actor, { requestId: randomUUID(), commands: [{ kind: 'memory.create', input: { topicId: project, title: '待确认记忆', content: '确认后写入', evidence: [{ type: 'material', id: titled.id, revision: titled.revision }] } }] });
    const stored = await prisma.proposal.findUniqueOrThrow({ where: { id: pending.proposalId } });
    expect(stored.preconditions).not.toContain('批准前标题');
    expect(JSON.parse(stored.preview)[0].detail.evidenceSummaries).toEqual([{ type: 'material', id: titled.id, revision: titled.revision, title: '批准前标题', topicId: project, topicName: '依据清单' }]);
    const visible = await commands.get(actor, pending.proposalId);
    expect(visible.preview[0].detail.evidenceSummaries[0].title).toBe('批准前标题');
    await prisma.material.update({ where: { id: titled.id }, data: { title: '批准后标题' } });
    expect((await prisma.material.findUniqueOrThrow({ where: { id: titled.id } })).revision).toBe(titled.revision);
    const approved = await commands.approve(ownerActor, pending.proposalId, { requestId: randomUUID(), expectedRevision: pending.proposalRevision });
    expect(approved.status).toBe('applied');
    expect(approved.results[0].title).toBe('待确认记忆');
  });

  it('degrades retire evidence that can no longer be read and does not leak a hidden title', async () => {
    const project = (await write('topic.create', { name: '退役清单' })).id as string;
    const hidden = (await write('topic.create', { name: '退役隐藏清单' })).id as string;
    const source = await material(project, '仍可读的材料', '可见正文');
    const secret = await material(hidden, '退役越权标题', '退役越权正文');
    const memory = await write('memory.create', { topicId: project, title: '将退役', content: '仍在', evidence: [{ type: 'material', id: source.id, revision: source.revision }] });
    const preview = await commands.preview(ownerActor, { commands: [{ kind: 'memory.retire', targetId: memory.id, expectedRevision: memory.revision, input: { evidence: [
      { type: 'material', id: source.id, revision: source.revision },
      { type: 'task', id: 'missing-evidence-task', revision: 4 },
    ] } }] });
    const summaries = evidenceSummaries(preview);
    expect(summaries[0]).toMatchObject({ type: 'material', id: source.id, revision: source.revision, title: '仍可读的材料', topicId: project, topicName: '退役清单' });
    expect(summaries[0]).not.toHaveProperty('content');
    expect(summaries[0]).not.toHaveProperty('status');
    expect(summaries[1]).toEqual({ type: 'task', id: 'missing-evidence-task', revision: 4, unavailable: true });
    const timestamp = new Date().toISOString();
    const connection = await prisma.connection.create({ data: { name: '退役连接', host: 'codex', tokenHash: randomUUID(), topicIds: JSON.stringify([project]), autoActions: '[]', createdAt: timestamp, updatedAt: timestamp } });
    const hiddenPreview = await commands.preview(actorFromConnection(connection), { commands: [{ kind: 'memory.retire', targetId: memory.id, expectedRevision: memory.revision, input: { evidence: [{ type: 'material', id: secret.id, revision: secret.revision }] } }] });
    expect(evidenceSummaries(hiddenPreview)).toEqual([{ type: 'material', id: secret.id, revision: secret.revision, unavailable: true }]);
    expect(JSON.stringify(hiddenPreview.preview)).not.toContain('退役越权标题');
    expect(JSON.stringify(hiddenPreview.preview)).not.toContain('退役越权正文');
  });
});

describe('review local wall-clock scheduling', () => {
  beforeEach(clean);
  afterAll(clean);

  it('chooses the first repeated time and advances skipped DST times', () => {
    expect(scheduledInstant('2026-03-08', '02:30', 'America/New_York').toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(scheduledInstant('2026-11-01', '01:30', 'America/New_York').toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(latestOccurrence({ frequency: 'daily', timeOfDay: '01:30', timeZone: 'America/New_York', weekDay: 0 }, new Date('2026-11-01T06:15:00Z')).key).toBe('daily:2026-11-01');
  });
  it('uses the selected weekday in the rule timezone', () => {
    expect(latestOccurrence({ frequency: 'weekly', timeOfDay: '20:00', timeZone: 'Asia/Hong_Kong', weekDay: 0 }, new Date('2026-09-21T04:00:00Z'))).toMatchObject({ key: 'weekly:2026-09-20', scheduledAt: '2026-09-20T12:00:00.000Z' });
  });

  it('steps one day or one week ahead at the same local time', () => {
    expect(followingOccurrence({ frequency: 'daily', timeOfDay: '21:00', timeZone: 'Asia/Hong_Kong', weekDay: 0 }, '2026-01-10')).toEqual({ key: 'daily:2026-01-11', scheduledAt: '2026-01-11T13:00:00.000Z', localDate: '2026-01-11' });
    expect(followingOccurrence({ frequency: 'weekly', timeOfDay: '20:00', timeZone: 'Asia/Hong_Kong', weekDay: 0 }, '2026-09-20')).toEqual({ key: 'weekly:2026-09-27', scheduledAt: '2026-09-27T12:00:00.000Z', localDate: '2026-09-27' });
  });

  it('returns the next Hong Kong run, or null when paused or the schedule is invalid', async () => {
    const project = await topic();
    const reviews = new ReviewService();
    const at = new Date('2026-01-10T15:00:00.000Z');
    const schedule = { topicIds: [project], enabled: true, frequency: 'daily' as const, timeOfDay: '21:00', timeZone: 'Asia/Hong_Kong' };
    const rule = await reviews.createRule(ownerActor, { name: '补跑最近一次', ...schedule });
    await prisma.reviewRule.update({ where: { id: rule.id }, data: { updatedAt: '2026-01-01T00:00:00.000Z' } });
    const nextOf = async (id: string, moment = at) => (await reviews.rules(ownerActor, moment)).find((item) => item.id === id)?.nextRunAt;
    expect(await nextOf(rule.id)).toBe('2026-01-10T13:00:00.000Z');
    await prisma.reviewBatch.create({ data: { ruleId: rule.id, occurrenceKey: 'daily:2026-01-10', createdAt: '2026-01-10T13:00:00.000Z', updatedAt: '2026-01-10T13:00:00.000Z' } });
    expect(await nextOf(rule.id)).toBe('2026-01-11T13:00:00.000Z');
    const edited = await reviews.createRule(ownerActor, { name: '改过的规则', ...schedule });
    await prisma.reviewRule.update({ where: { id: edited.id }, data: { updatedAt: '2026-01-10T14:00:00.000Z' } });
    expect(await nextOf(edited.id)).toBe('2026-01-11T13:00:00.000Z');
    const weekly = await reviews.createRule(ownerActor, { name: '每周', topicIds: [project], enabled: true, frequency: 'weekly', timeOfDay: '20:00', timeZone: 'Asia/Hong_Kong', weekDay: 0 });
    await prisma.reviewRule.update({ where: { id: weekly.id }, data: { updatedAt: '2026-09-01T00:00:00.000Z' } });
    const weekAt = new Date('2026-09-21T04:00:00.000Z');
    expect(await nextOf(weekly.id, weekAt)).toBe('2026-09-20T12:00:00.000Z');
    await prisma.reviewBatch.create({ data: { ruleId: weekly.id, occurrenceKey: 'weekly:2026-09-20', createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:00.000Z' } });
    expect(await nextOf(weekly.id, weekAt)).toBe('2026-09-27T12:00:00.000Z');
    const paused = await reviews.createRule(ownerActor, { name: '暂停', ...schedule, enabled: false });
    expect(await nextOf(paused.id)).toBeNull();
    await prisma.reviewRule.update({ where: { id: rule.id }, data: { timeZone: 'Not/AZone' } });
    expect(await nextOf(rule.id)).toBeNull();
    expect((await reviews.rules(ownerActor, at)).some((item) => item.id === edited.id && item.nextRunAt === '2026-01-11T13:00:00.000Z')).toBe(true);
  });
});
