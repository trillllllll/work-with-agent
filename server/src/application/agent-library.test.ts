import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentService } from '../agent.js';
import { prisma } from '../infrastructure/prisma.js';
import { validateLibraryArguments } from './agent-library.js';
import { ApprovalService } from './approval.js';
import { CommandService } from './commands.js';
import { formatSystemPrompt } from './conversation.js';
import { registerKnowledgeCommands } from './knowledge.js';
import { registerLibraryCommands } from './library/commands.js';
import { ownerActor } from './security.js';
import { ToolService } from './tool-registry.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (databaseUrl.includes('agent-studio')) throw new Error('资料工具测试不能使用开发数据库');

const previousKnowledge = process.env.KNOWLEDGE_STORAGE_ROOT;
const previousUpload = process.env.LIBRARY_UPLOAD_ROOT;
const scratch = mkdtempSync(join(tmpdir(), 'wwa-library-tool-'));
const token = randomUUID().slice(0, 8);
const secret = `库工具体密正文${token}`;
const title = `库工具文本${token}`;
const folderName = `待确认夹${token}`;
const question = `资料工具没有模型时怎么回答${token}`;

registerKnowledgeCommands();
registerLibraryCommands();

const commands = new CommandService();
const approvals = new ApprovalService();
const agent = new AgentService();
const tools = new ToolService();
const materialIds: string[] = [];
const taskIds: string[] = [];
const folderIds: string[] = [];
const approvalIds: string[] = [];
const proposalIds: string[] = [];

async function apply(kind: string, input: Record<string, unknown>) {
  const response = await commands.submit(ownerActor, { requestId: randomUUID(), commands: [{ kind, input }] });
  expect(response.status).toBe('applied');
  return response.results[0] as { id: string; revision: number; organizationRevision?: number };
}

async function removeCreated() {
  if (materialIds.length) {
    await prisma.librarySearchPosting.deleteMany({ where: { materialId: { in: materialIds } } });
    await prisma.librarySearchDocument.deleteMany({ where: { materialId: { in: materialIds } } });
    const extractions = await prisma.materialExtraction.findMany({ where: { materialId: { in: materialIds } }, select: { id: true } });
    if (extractions.length) await prisma.materialChunk.deleteMany({ where: { extractionId: { in: extractions.map((row) => row.id) } } });
    await prisma.materialExtraction.deleteMany({ where: { materialId: { in: materialIds } } });
    await prisma.materialTag.deleteMany({ where: { materialId: { in: materialIds } } });
    await prisma.materialTaskLink.deleteMany({ where: { materialId: { in: materialIds } } });
    await prisma.materialVersion.deleteMany({ where: { materialId: { in: materialIds } } });
    await prisma.material.deleteMany({ where: { id: { in: materialIds } } });
  }
  if (folderIds.length) await prisma.libraryFolder.deleteMany({ where: { id: { in: folderIds } } });
  await prisma.libraryAnswer.deleteMany({ where: { question } });
  if (approvalIds.length) await prisma.approval.deleteMany({ where: { id: { in: approvalIds } } });
  if (proposalIds.length) await prisma.proposal.deleteMany({ where: { id: { in: proposalIds } } });
  const receipts = approvalIds.map((id) => `approval:${id}`);
  if (receipts.length) await prisma.requestReceipt.deleteMany({ where: { requestId: { in: receipts } } });
  const entityIds = [...materialIds, ...taskIds, ...folderIds];
  if (entityIds.length) await prisma.changeRecord.deleteMany({ where: { entityId: { in: entityIds } } });
  if (taskIds.length) await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
}

describe('in-app library tool', () => {
  let materialId = '';
  let taskId = '';

  beforeAll(async () => {
    process.env.KNOWLEDGE_STORAGE_ROOT = join(scratch, 'blobs');
    process.env.LIBRARY_UPLOAD_ROOT = join(scratch, 'uploads');
    const material = await apply('material.create', { topicId: null, kind: 'text', title, content: secret });
    materialId = material.id;
    materialIds.push(material.id);
    const task = await apply('task.create', { title: `库工具任务${token}` });
    taskId = task.id;
    taskIds.push(task.id);
  });

  afterAll(async () => {
    await removeCreated();
    if (previousKnowledge === undefined) delete process.env.KNOWLEDGE_STORAGE_ROOT;
    else process.env.KNOWLEDGE_STORAGE_ROOT = previousKnowledge;
    if (previousUpload === undefined) delete process.env.LIBRARY_UPLOAD_ROOT;
    else process.env.LIBRARY_UPLOAD_ROOT = previousUpload;
    await rm(scratch, { recursive: true, force: true });
  });

  it('rejects an unknown action, a bad link, and a write that omits the revision', () => {
    expect(validateLibraryArguments({ action: 'replace' })).toBe('未知动作');
    expect(validateLibraryArguments({ action: 'links', materialId: 'm1' })).toContain('revision');
    expect(validateLibraryArguments({ action: 'create', kind: 'link', title: '外链', uri: 'ftp://files.example/a' })).toBe('链接资料需要网址');
    expect(validateLibraryArguments({ action: 'folders', extra: true })).toContain('未知参数');
    expect(tools.isReadOnly('library', { action: 'list' })).toBe(true);
    expect(tools.isReadOnly('library', { action: 'search' })).toBe(true);
    expect(tools.isReadOnly('library', { action: 'ask' })).toBe(true);
    expect(tools.isReadOnly('library', { action: 'links' })).toBe(false);
    expect(tools.validate({ name: 'library', arguments: { action: 'replace' } })).toContain('action');
    expect(tools.validate({ name: 'library', arguments: { action: 'content', materialId: 'm1', revision: 1, limit: 41 } })).toContain('40');
    expect(formatSystemPrompt({}, [])).toContain('项目资料用 library');
  });

  it('returns titles and versions without the stored body', async () => {
    const listed = await tools.execute({ name: 'library', arguments: { action: 'list', limit: 40 } }, { source: 'agent' });
    expect(listed.success).toBe(true);
    const listedJson = JSON.stringify(listed.data);
    expect(listedJson).toContain(title);
    expect(listedJson).not.toContain(secret);
    const read = await tools.execute({ name: 'library', arguments: { action: 'read', materialId } }, { source: 'agent' });
    expect(read.success).toBe(true);
    expect(read.data).toMatchObject({ id: materialId, title, revision: 1, organizationRevision: 1, extraction: { status: 'queued' } });
    expect(JSON.stringify(read.data)).not.toContain(secret);
    const page = await tools.execute({ name: 'library', arguments: { action: 'content', materialId, revision: 1 } }, { source: 'agent' });
    expect(JSON.stringify(page)).not.toContain(secret);
    if (page.success) expect((page.data as { items: unknown[] }).items.length).toBeLessThanOrEqual(40);
  });

  it('keeps links pending until approval, and undo only runs when approved', async () => {
    const args = { action: 'links', materialId, revision: 1, organizationRevision: 1, addTaskIds: [taskId], removeTaskIds: [], removeInlineReferences: false };
    const blocked = await tools.execute({ name: 'library', arguments: args }, { source: 'agent' });
    expect(blocked).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' });
    expect(await prisma.materialTaskLink.count({ where: { materialId, taskId } })).toBe(0);

    const rejected = await approvals.create({ name: 'library', id: `call-reject-${token}`, arguments: args });
    approvalIds.push(rejected.id);
    const rejectedLink = JSON.parse(rejected.result ?? '{}') as { proposalId?: string };
    expect(rejectedLink.proposalId).toBeTruthy();
    proposalIds.push(rejectedLink.proposalId!);
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: rejectedLink.proposalId } })).status).toBe('pending');
    await approvals.preview(rejected.id);
    expect(await prisma.materialTaskLink.count({ where: { materialId, taskId } })).toBe(0);
    await agent.reject(rejected.id);
    expect(await prisma.materialTaskLink.count({ where: { materialId, taskId } })).toBe(0);
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: rejected.id } })).status).toBe('rejected');

    const pending = await approvals.create({ name: 'library', id: `call-approve-${token}`, arguments: args });
    approvalIds.push(pending.id);
    const pendingLink = JSON.parse(pending.result ?? '{}') as { proposalId?: string; proposalRevision?: number };
    proposalIds.push(pendingLink.proposalId!);
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: pendingLink.proposalId } })).actorId).toBe('builtin-agent');
    expect(await prisma.materialTaskLink.count({ where: { materialId, taskId } })).toBe(0);
    const applied = await agent.approve(pending.id);
    expect(applied.result.success).toBe(true);
    expect(await prisma.materialTaskLink.findUnique({ where: { materialId_taskId: { materialId, taskId } } })).toBeTruthy();
    const change = await prisma.changeRecord.findFirstOrThrow({ where: { entityType: 'material', entityId: materialId, operation: 'update', undoneAt: null }, orderBy: { createdAt: 'desc' } });

    const declinedUndo = await approvals.create({ name: 'library', id: `call-undo-no-${token}`, arguments: { action: 'undo', changeId: change.id } });
    approvalIds.push(declinedUndo.id);
    expect(JSON.parse(declinedUndo.result ?? '{}')).toMatchObject({ undoChangeId: change.id });
    await expect(approvals.preview(declinedUndo.id)).rejects.toMatchObject({ status: 400 });
    await agent.reject(declinedUndo.id);
    expect(await prisma.materialTaskLink.findUnique({ where: { materialId_taskId: { materialId, taskId } } })).toBeTruthy();
    expect((await prisma.changeRecord.findUniqueOrThrow({ where: { id: change.id } })).undoneAt).toBeNull();

    const acceptedUndo = await approvals.create({ name: 'library', id: `call-undo-yes-${token}`, arguments: { action: 'undo', changeId: change.id } });
    approvalIds.push(acceptedUndo.id);
    const undone = await agent.approve(acceptedUndo.id);
    expect(undone.result.success).toBe(true);
    expect(await prisma.materialTaskLink.findUnique({ where: { materialId_taskId: { materialId, taskId } } })).toBeNull();
    expect((await prisma.changeRecord.findUniqueOrThrow({ where: { id: change.id } })).undoneAt).toBeTruthy();
  });

  it('holds a folder until the owner approves the stored proposal', async () => {
    const created = await approvals.create({ name: 'library', id: `call-folder-${token}`, arguments: { action: 'folder_create', parentId: null, name: folderName } });
    approvalIds.push(created.id);
    const stored = JSON.parse(created.result ?? '{}') as { proposalId?: string };
    proposalIds.push(stored.proposalId!);
    const proposal = await prisma.proposal.findUniqueOrThrow({ where: { id: stored.proposalId } });
    expect(proposal.actorId).toBe(ownerActor.id);
    expect(proposal.status).toBe('pending');
    expect(await prisma.libraryFolder.findFirst({ where: { name: folderName } })).toBeNull();
    await agent.approve(created.id);
    const folder = await prisma.libraryFolder.findFirstOrThrow({ where: { name: folderName } });
    folderIds.push(folder.id);
  });

  it('says the model is unavailable instead of failing the turn', async () => {
    const setting = await prisma.appSetting.findUnique({ where: { id: 'default' } });
    if (setting) await prisma.appSetting.update({ where: { id: 'default' }, data: { openaiBaseUrl: '', openaiModel: '', openaiApiKey: '' } });
    try {
      const answer = await tools.execute({ name: 'library', arguments: { action: 'ask', question } }, { source: 'agent' });
      expect(answer).toEqual({ success: true, data: { status: 'model_unavailable', message: '模型不可用', paragraphs: [], citations: [] } });
    } finally {
      if (setting) await prisma.appSetting.update({ where: { id: 'default' }, data: { openaiBaseUrl: setting.openaiBaseUrl, openaiModel: setting.openaiModel, openaiApiKey: setting.openaiApiKey } });
    }
  });
});
