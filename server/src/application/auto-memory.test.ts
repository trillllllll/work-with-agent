import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { prisma } from '../infrastructure/prisma.js';
import { CommandService } from './commands.js';
import { KnowledgeService, knowledgeHash, registerKnowledgeCommands } from './knowledge.js';
import { registerGraphCommands } from './knowledge-graph.js';
import { OrganizationService, type OrganizationModel } from './knowledge-organizations.js';
import { ownerActor, type Actor } from './security.js';
import { createKnowledgeRouter } from '../routes/knowledge.js';
import { AutoMemoryCrash, AutoMemoryService, clearAutoMemory } from './auto-memory.js';
import { appendAutoMemoryAssistant, archiveCompletedTurns, beginAutoMemoryTurn, completeAutoMemoryTurn, failAutoMemoryTurn } from './auto-memory-chat.js';
import { assertSingleMemoryScope } from './auto-memory-suggestions.js';
import { AUTO_MEMORY_SYSTEM_PROMPT, scopeKey, type FrozenSnapshot } from './auto-memory-types.js';
import { clearLibraryData, clearLibraryTaxonomy } from './library/cleanup.js';
import { rehearseAutoMemoryMigration } from './auto-memory-migration.js';
import { DomainError } from '../domain/task.js';

registerKnowledgeCommands();
registerGraphCommands();
const commands = new CommandService();
const knowledge = new KnowledgeService();
let nowMs = Date.parse('2026-10-15T00:00:00.000Z');
let configured = true;

class FakeModel implements OrganizationModel {
  calls: Array<Array<{ role: 'system' | 'user'; content: string }>> = [];
  impl: OrganizationModel['complete'] = async (messages) => ({ text: JSON.stringify(candidateFrom(snapshotOf(messages))) });
  async complete(messages: Array<{ role: 'system' | 'user'; content: string }>, _signal?: AbortSignal) {
    this.calls.push(messages);
    return this.impl(messages, _signal);
  }
}

const model = new FakeModel();
let service = newService();

function newService(extra: { afterOutputSaved?: () => Promise<void> } = {}) {
  return new AutoMemoryService({ now: () => new Date(nowMs), model, hasModelConfig: async () => configured, ...extra });
}
function snapshotOf(messages: Array<{ role: string; content: string }>) {
  return JSON.parse(messages[1].content) as FrozenSnapshot;
}
function candidateFrom(snapshot: FrozenSnapshot, patch: Record<string, unknown> = {}) {
  const source = snapshot.sources[0];
  return {
    summary: '提炼',
    candidates: [{
      action: 'create', targetId: null, expectedRevision: null, kind: 'fact', title: '已确认事实', content: '来源中的稳定事实',
      reason: '资料写明了这一点', importance: 3, labels: ['来源'],
      evidence: [{ type: source.sourceType, id: source.sourceId, revision: source.revision, hash: source.evidenceHash }],
      ...patch,
    }],
  };
}
function emptyOutput() {
  return { text: JSON.stringify({ summary: '没有值得记忆的内容', candidates: [] }) };
}
async function clean() {
  await clearAutoMemory(prisma);
  await clearLibraryData(prisma);
  await prisma.reviewBatch.deleteMany();
  await prisma.reviewRule.deleteMany();
  await prisma.organizationRequest.deleteMany();
  await prisma.workingBrief.deleteMany();
  await prisma.graphLink.deleteMany();
  await prisma.entity.deleteMany();
  await prisma.memoryVersion.deleteMany();
  await prisma.memory.deleteMany();
  await prisma.materialVersion.deleteMany();
  await prisma.material.deleteMany();
  await clearLibraryTaxonomy(prisma);
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.requestReceipt.deleteMany();
  await prisma.changeRecord.deleteMany();
  await prisma.connection.deleteMany();
  await prisma.taskTag.deleteMany();
  await prisma.taskTopicAssignment.deleteMany();
  await prisma.task.updateMany({ data: { parentId: null } });
  await prisma.task.deleteMany();
  await prisma.topic.deleteMany();
}
async function write(kind: string, input: Record<string, unknown>, targetId?: string, expectedRevision?: number) {
  const response = await commands.submit(ownerActor, { requestId: randomUUID(), commands: [{ kind, input, targetId, expectedRevision }] });
  expect(response.status).toBe('applied');
  return response.results[0] as { id: string; revision: number; contentHash?: string; changeId?: string };
}
const topic = async (name = '中文项目') => (await write('topic.create', { name })).id;
async function approveExistingProposal(proposal: { id: string; revision: number }) {
  return commands.approve(ownerActor, proposal.id, { requestId: randomUUID(), expectedRevision: proposal.revision });
}
async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

describe('auto memory distillation', () => {
  beforeEach(async () => {
    await clean();
    nowMs = Date.parse('2026-10-15T00:00:00.000Z');
    configured = true;
    model.calls = [];
    model.impl = async (messages) => ({ text: JSON.stringify(candidateFrom(snapshotOf(messages))) });
    service = newService();
  });
  afterAll(clean);

  it('keeps committed sources scheduled when a later source scan fails, then resumes idempotently', async () => {
    const topicId = await topic();
    const first = await write('material.create', { topicId, title: '第一份', content: '第一份事实', kind: 'text' });
    const second = await write('material.create', { topicId, title: '第二份', content: '第二份事实', kind: 'text' });
    const scanner = service as unknown as { prepareMaterial: (...args: unknown[]) => Promise<unknown> };
    const prepare = scanner.prepareMaterial.bind(service);
    let calls = 0;
    const spy = vi.spyOn(scanner, 'prepareMaterial').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('injected scan interruption');
      return prepare(...args);
    });
    try {
      await expect(service.scan()).rejects.toThrow('injected scan interruption');
      expect(await prisma.autoMemorySource.count({ where: { scopeKey: scopeKey(topicId), available: true } })).toBe(1);
      expect(await prisma.autoMemoryScope.findUniqueOrThrow({ where: { id: scopeKey(topicId) } })).toMatchObject({ dirtySince: new Date(nowMs).toISOString(), dueAt: new Date(nowMs + 60_000).toISOString() });
    } finally { spy.mockRestore(); }
    await service.scan();
    await service.scan();
    const sources = await prisma.autoMemorySource.findMany({ where: { scopeKey: scopeKey(topicId), available: true } });
    expect(sources.map((row) => row.sourceId).sort()).toEqual([first.id, second.id].sort());
    expect(sources.map((row) => row.revision)).toEqual([1, 1]);
  });

  it('backfills an enabled scope, proposes once, and writes memory only after approval', async () => {
    const topicId = await topic();
    await write('material.create', { topicId, title: '来源文档', content: '项目采用 SQLite，保留中文决策。', kind: 'markdown' });
    await service.scan();
    expect((await service.state(topicId)).enabled).toBe(true);
    expect((await service.state(topicId)).pendingSourceCount).toBe(1);
    await service.tick();
    expect(model.calls).toHaveLength(0);
    nowMs += 60_000;
    await service.tick();
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0][0].content).toBe(AUTO_MEMORY_SYSTEM_PROMPT);
    expect(await prisma.memory.count({ where: { topicId } })).toBe(0);
    expect((await service.state(topicId)).pendingProposalCount).toBe(1);
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(model.calls).toHaveLength(1);
    expect((await service.state(topicId)).pendingProposalCount).toBe(1);
    const proposal = (await service.proposals(topicId)).items[0];
    await approveExistingProposal(proposal);
    const savedMemory = await prisma.memory.findFirstOrThrow({ where: { topicId } });
    expect(await prisma.memory.count({ where: { topicId } })).toBe(1);
    expect(await prisma.memoryVersion.count({ where: { memoryId: savedMemory.id } })).toBe(1);
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(model.calls).toHaveLength(1);
  });

  it('waits through changes inside 60 seconds and runs once after the quiet period', async () => {
    const topicId = await topic();
    const source = await write('material.create', { topicId, title: '来源', content: '第一版', kind: 'text' });
    const start = nowMs;
    await service.scan();
    nowMs = start + 30_000;
    await write('material.update', { content: '第二版' }, source.id, source.revision);
    await service.scan();
    nowMs = start + 60_000;
    await service.tick();
    expect(model.calls).toHaveLength(0);
    nowMs = start + 90_000;
    await service.tick();
    expect(model.calls).toHaveLength(1);
  });

  it('claims a scope by five minutes even while edits continue', async () => {
    const topicId = await topic();
    const source = await write('material.create', { topicId, title: '来源', content: '起始', kind: 'text' });
    const start = nowMs;
    await service.scan();
    let revision = source.revision;
    for (let elapsed = 30_000; elapsed <= 270_000; elapsed += 30_000) {
      nowMs = start + elapsed;
      const updated = await write('material.update', { content: `版本${elapsed}` }, source.id, revision);
      revision = updated.revision;
      await service.scan();
    }
    nowMs = start + 299_000;
    await service.tick();
    expect(model.calls).toHaveLength(0);
    nowMs = start + 300_000;
    await service.tick();
    expect(model.calls).toHaveLength(1);
  });

  it('runs one model call at a time and gives the next due scope a later turn', async () => {
    const topicA = await topic('清单A');
    await write('material.create', { topicId: topicA, title: 'A', content: '资料A', kind: 'text' });
    await service.scan();
    nowMs += 1_000;
    const topicB = await topic('清单B');
    await write('material.create', { topicId: topicB, title: 'B', content: '资料B', kind: 'text' });
    await service.scan();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.impl = async (messages) => { await gate; return { text: JSON.stringify(candidateFrom(snapshotOf(messages))) }; };
    nowMs += 60_000;
    const first = service.tick();
    await waitFor(() => model.calls.length === 1);
    const second = service.tick();
    await second;
    expect(model.calls).toHaveLength(1);
    release();
    await first;
    expect(model.calls).toHaveLength(1);
    nowMs += 60_000;
    await service.tick();
    expect(model.calls).toHaveLength(2);
    expect(new Set(model.calls.map((call) => snapshotOf(call).topicId))).toEqual(new Set([topicA, topicB]));
  });

  it('drops a stale model result and keeps the new source pending', async () => {
    const topicId = await topic();
    const source = await write('material.create', { topicId, title: '来源', content: '旧正文', kind: 'text' });
    model.impl = async () => {
      await write('material.update', { content: '新正文' }, source.id, source.revision);
      return { text: JSON.stringify({ summary: '过期', candidates: [{ action: 'create', targetId: null, expectedRevision: null, kind: 'fact', title: '过期结论', content: '旧正文里的事实', reason: '来自旧快照', importance: 3, labels: [], evidence: [{ type: 'material', id: source.id, revision: 1 }] }] }) };
    };
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(await prisma.proposal.count()).toBe(0);
    expect(await prisma.memory.count()).toBe(0);
    const job = await prisma.autoMemoryJob.findFirstOrThrow();
    expect(job.errorCode).toBe('SOURCE_STALE');
    expect((await service.state(topicId)).pendingSourceCount).toBe(1);
    model.impl = async (messages) => ({ text: JSON.stringify(candidateFrom(snapshotOf(messages))) });
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(model.calls).toHaveLength(2);
    expect((await service.state(topicId)).pendingProposalCount).toBe(1);
    expect(await prisma.memory.count()).toBe(0);
  });

  it('ignores a model result that arrives after the scope is disabled or archived', async () => {
    const topicId = await topic();
    await write('material.create', { topicId, title: '来源', content: '正文', kind: 'text' });
    model.impl = async (messages) => {
      const state = await service.state(topicId);
      await service.setEnabled(ownerActor, topicId, false, state.revision);
      return { text: JSON.stringify(candidateFrom(snapshotOf(messages))) };
    };
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(await prisma.proposal.count()).toBe(0);
    expect((await service.state(topicId)).state).toBe('disabled');
    const archived = await topic('归档清单');
    await write('material.create', { topicId: archived, title: '来源', content: '正文', kind: 'text' });
    model.calls = [];
    model.impl = async () => {
      await prisma.topic.update({ where: { id: archived }, data: { archivedAt: new Date(nowMs).toISOString() } });
      return { text: JSON.stringify({ summary: '迟到', candidates: [{ action: 'create', targetId: null, expectedRevision: null, kind: 'fact', title: '不应写入', content: '归档后的结论', reason: '迟到', importance: 2, labels: [], evidence: [{ type: 'material', id: 'missing', revision: 1 }] }] }) };
    };
    service = newService();
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(await prisma.memory.count({ where: { topicId: archived } })).toBe(0);
    expect(await prisma.proposal.count()).toBe(0);
    expect((await service.state(archived)).state).toBe('archived');
  });

  it('lets only one of two simultaneous ticks claim the same snapshot', async () => {
    const topicId = await topic();
    await write('material.create', { topicId, title: '来源', content: '正文', kind: 'text' });
    const other = newService();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.impl = async (messages) => { await gate; return { text: JSON.stringify(candidateFrom(snapshotOf(messages))) }; };
    await service.scan();
    nowMs += 60_000;
    const left = service.tick();
    const right = other.tick();
    try {
      await Promise.race([left, right]);
      // The losing claimant may return before the winner gets its next pooled
      // read. Wait for observable model entry instead of relying on that order.
      await waitFor(() => model.calls.length === 1);
      expect(model.calls).toHaveLength(1);
    } finally { release(); }
    await Promise.all([left, right]);
    expect(model.calls).toHaveLength(1);
    expect(await prisma.autoMemoryJob.count({ where: { status: { in: ['running', 'proposed', 'completed'] } } })).toBe(1);
  });

  it('marks an expired lease INTERRUPTED and does not call the model again', async () => {
    const topicId = await topic();
    await write('material.create', { topicId, title: '来源', content: '正文', kind: 'text' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.impl = async (messages) => { await gate; return { text: JSON.stringify(candidateFrom(snapshotOf(messages))) }; };
    await service.scan();
    nowMs += 60_000;
    const pending = service.tick();
    await waitFor(() => model.calls.length === 1);
    nowMs += 121_000;
    await service.tick();
    expect(model.calls).toHaveLength(1);
    release();
    await pending;
    const job = await prisma.autoMemoryJob.findFirstOrThrow();
    expect(job.errorCode).toBe('INTERRUPTED');
    expect(await prisma.proposal.count()).toBe(0);
    expect(await prisma.memory.count()).toBe(0);
    nowMs += 60_000;
    await service.tick();
    expect(model.calls).toHaveLength(1);
  });

  it('keeps pending sources and skips the model when no builtin model is configured', async () => {
    configured = false;
    const topicId = await topic();
    await write('material.create', { topicId, title: '来源', content: '正文', kind: 'text' });
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(model.calls).toHaveLength(0);
    const state = await service.state(topicId);
    expect(state.state).toBe('unconfigured');
    expect(state.pendingSourceCount).toBe(1);
    await expect(service.run(ownerActor, topicId, randomUUID())).rejects.toMatchObject({ code: 'MODEL_UNCONFIGURED' });
  });

  it('fails the whole batch for invalid JSON and retries from the current source', async () => {
    const topicId = await topic();
    await write('material.create', { topicId, title: '来源', content: '正文', kind: 'text' });
    let attempts = 0;
    model.impl = async (messages) => {
      attempts += 1;
      if (attempts === 1) return { text: 'not-json' };
      return { text: JSON.stringify(candidateFrom(snapshotOf(messages))) };
    };
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(await prisma.proposal.count()).toBe(0);
    expect(await prisma.memory.count()).toBe(0);
    const failed = await prisma.autoMemoryJob.findFirstOrThrow({ where: { errorCode: 'INVALID_MODEL_OUTPUT' } });
    const requestId = randomUUID();
    await service.retry(ownerActor, failed.id, requestId);
    await service.retry(ownerActor, failed.id, requestId);
    expect(model.calls).toHaveLength(2);
    expect(await prisma.proposal.count()).toBe(1);
    expect(await prisma.memory.count()).toBe(0);
    expect(await prisma.autoMemoryJob.count({ where: { status: 'failed' } })).toBe(1);
  });

  it('rejects extra fields and out-of-range evidence without creating a proposal', async () => {
    const topicId = await topic();
    await write('material.create', { topicId, title: '来源', content: '正文', kind: 'text' });
    model.impl = async () => ({ text: JSON.stringify({ summary: '多余', candidates: [], extra: true }) });
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect((await prisma.autoMemoryJob.findFirstOrThrow()).errorCode).toBe('INVALID_MODEL_OUTPUT');
    expect(await prisma.proposal.count()).toBe(0);
    await clean();
    nowMs += 1_000;
    model.calls = [];
    const next = await topic();
    const source = await write('material.create', { topicId: next, title: '来源', content: '正文', kind: 'text' });
    model.impl = async () => ({ text: JSON.stringify({ summary: '越界', candidates: [{ action: 'create', targetId: null, expectedRevision: null, kind: 'fact', title: '越界', content: '没有这次来源', reason: '越界', importance: 3, labels: [], evidence: [{ type: 'material', id: source.id, revision: 9 }] }] }) });
    service = newService();
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect((await prisma.autoMemoryJob.findFirstOrThrow()).errorCode).toBe('INVALID_MODEL_OUTPUT');
    expect(await prisma.proposal.count()).toBe(0);
    expect(await prisma.memory.count()).toBe(0);
  });

  it('completes an empty candidate list and marks the source processed', async () => {
    const topicId = await topic();
    await write('material.create', { topicId, title: '来源', content: '没有值得记忆的内容', kind: 'text' });
    model.impl = async () => emptyOutput();
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    const job = await prisma.autoMemoryJob.findFirstOrThrow();
    expect(job.status).toBe('completed');
    expect(await prisma.proposal.count()).toBe(0);
    expect((await service.state(topicId)).pendingSourceCount).toBe(0);
    expect((await service.state(topicId)).state).toBe('idle');
  });

  it('reuses one pending proposal across organization and a repeated identical submission', async () => {
    const topicId = await topic();
    const source = await write('material.create', { topicId, title: '来源', content: '项目采用 SQLite。', kind: 'markdown' });
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    const proposal = (await service.proposals(topicId)).items[0];
    const stored = (JSON.parse((await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).commands) as Array<{ kind: string; input: Record<string, unknown> }>)[0];
    const command = { kind: stored.kind, input: stored.input };
    const organizations = new OrganizationService();
    const created = await organizations.create(ownerActor, { topicId, purpose: '定期回顾同一结论', provider: 'external', materialIds: [source.id] });
    const submitted = await organizations.submitCandidates(ownerActor, created.id, { summary: '同一结论', commands: [command] });
    expect(submitted.proposalIds).toEqual([proposal.id]);
    expect(await prisma.proposal.count({ where: { status: 'pending' } })).toBe(1);
    await commands.reject(ownerActor, proposal.id, { expectedRevision: proposal.revision });
    const again = await organizations.create(ownerActor, { topicId, purpose: '拒绝后相同来源', provider: 'external', materialIds: [source.id] });
    await organizations.submitCandidates(ownerActor, again.id, { summary: '同一结论', commands: [command] });
    expect(await prisma.proposal.count()).toBe(1);
    const revised = await write('material.update', { content: '项目改为保留本地 SQLite，并记录备份。' }, source.id, source.revision);
    model.impl = async (messages) => ({ text: JSON.stringify(candidateFrom(snapshotOf(messages), { title: '新的存储结论', content: '备份也需要保留。' })) });
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(await prisma.proposal.count({ where: { status: 'pending' } })).toBe(1);
    const fresh = (await service.proposals(topicId)).items[0];
    expect(fresh.id).not.toBe(proposal.id);
    expect(JSON.parse((await prisma.proposal.findUniqueOrThrow({ where: { id: fresh.id } })).commands)[0].input.evidence[0].revision).toBe(revised.revision);
  });

  it('returns 409 when the target memory changes before approval and does not overwrite it', async () => {
    const topicId = await topic();
    const source = await write('material.create', { topicId, title: '来源', content: '采用 SQLite。', kind: 'text' });
    const memory = await write('memory.create', { topicId, title: '数据库', content: '使用 SQLite', kind: 'decision', evidence: [{ type: 'material', id: source.id, revision: source.revision, hash: source.contentHash }] });
    model.impl = async (messages) => {
      const snapshot = snapshotOf(messages);
      const current = snapshot.memories[0];
      return { text: JSON.stringify(candidateFrom(snapshot, { action: 'update', targetId: current.id, expectedRevision: current.revision, title: '数据库', content: '模型想改成的正文', kind: 'decision' })) };
    };
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({ content: '使用 SQLite', revision: 1 });
    await write('memory.update', { content: '用户刚写的正文' }, memory.id, memory.revision);
    const proposal = (await service.proposals(topicId)).items[0];
    await expect(approveExistingProposal(proposal)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    expect(await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({ content: '用户刚写的正文', revision: 2 });
  });

  it('covers every material instead of stopping at a page, and splits a 12001-character source into three parts', async () => {
    const topicId = await topic();
    const stamp = new Date(nowMs).toISOString();
    await prisma.$transaction(async (tx) => {
      for (let index = 0; index < 101; index += 1) {
        const id = `mat-${String(index).padStart(3, '0')}`;
        const content = `资料${index}`;
        await tx.material.create({ data: { id, topicId, kind: 'text', title: `资料${index}`, revision: 1, createdAt: stamp, updatedAt: stamp } });
        await tx.materialVersion.create({ data: { id: `ver-${id}`, materialId: id, revision: 1, content, contentHash: knowledgeHash(`${content}\0`), createdAt: stamp } });
      }
    });
    model.impl = async () => emptyOutput();
    await service.scan();
    const seen = new Set<string>();
    for (let turn = 0; turn < 20 && seen.size < 101; turn += 1) {
      nowMs += 60_000;
      await service.tick();
      for (const call of model.calls) for (const source of snapshotOf(call).sources) seen.add(source.sourceId);
    }
    expect(seen.size).toBe(101);
    expect(model.calls.length).toBe(13);
    expect((await service.state(topicId)).pendingSourceCount).toBe(0);
    const longTopic = await topic('长文');
    const content = `${'测'.repeat(12_000)}尾`;
    await write('material.create', { topicId: longTopic, title: '长文', content, kind: 'text' });
    model.calls = [];
    service = newService();
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    const parts = snapshotOf(model.calls[0]).sources.slice().sort((left, right) => left.part - right.part);
    expect(parts.map((part) => part.part)).toEqual([0, 1, 2]);
    expect(parts[2].text).toBe('尾');
    expect(parts.reduce((sum, part) => sum + part.text.length, 0)).toBe(12_001);
  });

  it('stops distilling a deleted or moved source in the old scope and sees it in the new scope', async () => {
    const origin = await topic('原清单');
    const destination = await topic('新清单');
    const moved = await write('material.create', { topicId: origin, title: '会移动', content: '移动正文', kind: 'text' });
    const removed = await write('material.create', { topicId: origin, title: '会归档', content: '归档正文', kind: 'text' });
    await service.scan();
    await prisma.material.update({ where: { id: moved.id }, data: { topicId: destination } });
    await write('material.archive', { archived: true }, removed.id, removed.revision);
    await service.scan();
    expect(await prisma.autoMemorySource.findFirst({ where: { sourceId: moved.id, scopeKey: scopeKey(origin) } })).toMatchObject({ available: false });
    expect(await prisma.autoMemorySource.findFirst({ where: { sourceId: removed.id, scopeKey: scopeKey(origin) } })).toMatchObject({ available: false });
    expect(await prisma.autoMemorySource.findFirst({ where: { sourceId: moved.id, scopeKey: scopeKey(destination), available: true } })).toBeTruthy();
    model.impl = async () => emptyOutput();
    nowMs += 60_000;
    await service.tick();
    expect(snapshotOf(model.calls[0]).topicId).toBe(destination);
    expect(snapshotOf(model.calls[0]).sources.map((source) => source.sourceId)).toEqual([moved.id]);
  });

  it('continues with a new source while a failed source stays visible', async () => {
    const topicId = await topic();
    await write('material.create', { topicId, title: '失败来源', content: '旧资料', kind: 'text' });
    model.impl = async () => ({ text: '{' });
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect((await service.state(topicId)).failedSourceCount).toBe(1);
    await write('material.create', { topicId, title: '新资料', content: '新的事实来源', kind: 'text' });
    model.impl = async (messages) => ({ text: JSON.stringify(candidateFrom(snapshotOf(messages))) });
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(snapshotOf(model.calls.at(-1)!).sources.map((source) => source.title)).toEqual(['新资料']);
    expect((await service.state(topicId)).failedSourceCount).toBe(1);
    expect((await service.state(topicId)).pendingProposalCount).toBe(1);
  });

  it('distills an attachment only after readable text exists', async () => {
    const topicId = await topic();
    const source = await write('material.create', { topicId, title: '附件', content: '', kind: 'text' });
    await prisma.material.update({ where: { id: source.id }, data: { kind: 'attachment' } });
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(model.calls).toHaveLength(0);
    expect((await service.state(topicId)).pendingSourceCount).toBe(1);
    const extraction = await prisma.materialExtraction.findUniqueOrThrow({ where: { materialId_revision: { materialId: source.id, revision: source.revision } } });
    await prisma.materialExtraction.update({ where: { id: extraction.id }, data: { status: 'ready', generation: 1, indexedGeneration: 1, updatedAt: new Date(nowMs).toISOString() } });
    const text = '附件里的已确认决定';
    await prisma.materialChunk.create({ data: { id: randomUUID(), extractionId: extraction.id, generation: 1, ordinal: 0, text, textHash: knowledgeHash(text), locatorJson: '{}', method: 'native', createdAt: new Date(nowMs).toISOString() } });
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(model.calls).toHaveLength(1);
    expect(snapshotOf(model.calls[0]).sources[0].text).toBe(text);
  });

  it('does not treat task sort order or due date as a body change', async () => {
    const topicId = await topic();
    const task = await write('task.create', { topicId, title: '排序任务', description: '说明', resultSummary: '' });
    model.impl = async () => emptyOutput();
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    const evidenceHash = snapshotOf(model.calls[0]).sources[0].evidenceHash;
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(evidenceHash).toBe(knowledgeHash(JSON.stringify({ title: row.title, description: row.description, status: row.status, dueDate: row.dueDate, resultSummary: row.resultSummary })));
    await prisma.task.update({ where: { id: task.id }, data: { sortOrder: 9, dueDate: '2026-10-20' } });
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(model.calls).toHaveLength(1);
    await write('task.update', { title: '标题变了' }, task.id, task.revision);
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    expect(model.calls).toHaveLength(2);
  });

  it('keeps manual brief notes and their revision when the brief is regenerated', async () => {
    const topicId = await topic();
    const initial = await knowledge.brief(ownerActor, topicId);
    await knowledge.saveBrief(ownerActor, { topicId, expectedVersion: initial.revision, manualNotes: '本周只关注文档' });
    const saved = await prisma.workingBrief.findUniqueOrThrow({ where: { id: `topic:${topicId}` } });
    await write('task.create', { topicId, title: '完善文档' });
    model.impl = async () => emptyOutput();
    await service.scan();
    nowMs += 60_000;
    await service.tick();
    const regenerated = await knowledge.brief(ownerActor, topicId);
    expect(regenerated.manualNotes).toBe('本周只关注文档');
    expect(regenerated.revision).toBe(saved.revision);
    expect(regenerated.content).toContain('完善文档');
  });

  it('persists proposals from a saved model output after a crash without calling the model again', async () => {
    const topicId = await topic();
    await write('material.create', { topicId, title: '来源', content: '正文', kind: 'text' });
    service = newService({ afterOutputSaved: async () => { throw new AutoMemoryCrash(); } });
    await service.scan();
    nowMs += 60_000;
    await expect(service.tick()).rejects.toBeInstanceOf(AutoMemoryCrash);
    const running = await prisma.autoMemoryJob.findFirstOrThrow();
    expect(running.status).toBe('running');
    expect(running.modelOutput).toContain('candidates');
    expect(model.calls).toHaveLength(1);
    nowMs += 121_000;
    await service.tick();
    expect((await prisma.autoMemoryJob.findFirstOrThrow({ where: { id: running.id } })).errorCode).toBe('INTERRUPTED');
    await service.retry(ownerActor, running.id, randomUUID());
    expect(model.calls).toHaveLength(1);
    expect((await service.state(topicId)).pendingProposalCount).toBe(1);
    expect(await prisma.memory.count()).toBe(0);
  });

  it('rejects a connection actor on every new auto-memory route', async () => {
    const app = express();
    app.use(express.json());
    const actor: Actor = { id: 'connection:test', kind: 'connection', connectionId: 'test', topicIds: [], includeInbox: false, autoActions: [], revision: 1 };
    app.use((req, _res, next) => { (req as express.Request & { actor: Actor }).actor = actor; next(); });
    app.use('/api/v1/knowledge', createKnowledgeRouter());
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ZodError) return res.status(400).json({ error: 'invalid', code: 'VALIDATION_ERROR' });
      const failure = error as { status?: number; message?: string; code?: string };
      res.status(failure.status ?? 500).json({ error: failure.message, code: failure.code });
    });
    const requestId = randomUUID();
    for (const call of [
      request(app).get('/api/v1/knowledge/auto-memory').query({ topicId: 'inbox' }),
      request(app).patch('/api/v1/knowledge/auto-memory').send({ topicId: null, enabled: false, expectedRevision: 1 }),
      request(app).post('/api/v1/knowledge/auto-memory/run').send({ topicId: null, requestId }),
      request(app).post('/api/v1/knowledge/auto-memory/jobs/missing/retry').send({ requestId }),
      request(app).get('/api/v1/knowledge/auto-memory/proposals').query({ topicId: 'inbox' }),
    ]) expect((await call).status).toBe(403);
  });

  it('does not archive historical chats, failed turns, or the same turn twice, and keeps each turn in its own list', async () => {
    const conversation = await prisma.conversation.create({ data: { createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString() } });
    await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: '历史里说过的话', status: 'completed', createdAt: new Date(nowMs).toISOString() } });
    await service.scan();
    expect(await prisma.autoMemoryTurn.count()).toBe(0);
    expect(await prisma.material.count({ where: { id: { startsWith: 'auto-chat:' } } })).toBe(0);
    const left = await topic('左清单');
    const right = await topic('右清单');
    const userLeft = await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: '左清单的决定', status: 'completed', createdAt: new Date(nowMs).toISOString() } });
    const assistantLeft = await prisma.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: '记下左清单', status: 'completed', createdAt: new Date(nowMs).toISOString() } });
    await beginAutoMemoryTurn({ conversationId: conversation.id, userMessageId: userLeft.id, topicId: left, createdAt: new Date(nowMs).toISOString() });
    await prisma.message.create({ data: { conversationId: conversation.id, role: 'tool', content: '工具原文不应进入摘录', status: 'completed', createdAt: new Date(nowMs).toISOString() } });
    const userRight = await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: '右清单的问题', status: 'completed', createdAt: new Date(nowMs).toISOString() } });
    const assistantRight = await prisma.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: '记下右清单', status: 'completed', createdAt: new Date(nowMs).toISOString() } });
    await beginAutoMemoryTurn({ conversationId: conversation.id, userMessageId: userRight.id, topicId: right, createdAt: new Date(nowMs).toISOString() });
    const failedUser = await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: '失败的一轮', status: 'completed', createdAt: new Date(nowMs).toISOString() } });
    await beginAutoMemoryTurn({ conversationId: conversation.id, userMessageId: failedUser.id, topicId: left, createdAt: new Date(nowMs).toISOString() });
    await appendAutoMemoryAssistant(userLeft.id, assistantLeft.id);
    await appendAutoMemoryAssistant(userRight.id, assistantRight.id);
    await completeAutoMemoryTurn(userLeft.id, new Date(nowMs).toISOString());
    await completeAutoMemoryTurn(userRight.id, new Date(nowMs).toISOString());
    await failAutoMemoryTurn(failedUser.id, new Date(nowMs).toISOString());
    await service.scan();
    await archiveCompletedTurns();
    const excerpts = await prisma.material.findMany({ where: { id: { startsWith: 'auto-chat:' } }, include: { versions: true } });
    expect(excerpts).toHaveLength(2);
    expect(excerpts.map((row) => row.topicId).sort()).toEqual([left, right].sort());
    const leftExcerpt = excerpts.find((row) => row.topicId === left)!;
    expect(leftExcerpt.title).toBe(`聊天摘录 · ${userLeft.id} · 1`);
    expect(leftExcerpt.versions[0].content).toContain('用户\n\n左清单的决定');
    expect(leftExcerpt.versions[0].content).toContain('助手\n\n记下左清单');
    expect(leftExcerpt.versions[0].content).not.toContain('工具原文');
    expect(JSON.parse(leftExcerpt.versions[0].metadata)).toMatchObject({ provider: 'builtin', sessionId: conversation.id, completeness: 'excerpt', autoMemoryTurnId: userLeft.id });
    await service.scan();
    expect(await prisma.material.count({ where: { id: { startsWith: 'auto-chat:' } } })).toBe(2);
    const collecting = await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: '还没结束', status: 'completed', createdAt: new Date(nowMs).toISOString() } });
    await beginAutoMemoryTurn({ conversationId: conversation.id, userMessageId: collecting.id, topicId: left, createdAt: new Date(nowMs).toISOString() });
    await service.tick();
    expect((await prisma.autoMemoryTurn.findUniqueOrThrow({ where: { id: collecting.id } })).status).toBe('collecting');
    await service.prepareStartup();
    expect((await prisma.autoMemoryTurn.findUniqueOrThrow({ where: { id: collecting.id } })).status).toBe('failed');
    expect(() => assertSingleMemoryScope([{ kind: 'memory.create', input: { topicId: right, title: '跨清单', content: '不行', evidence: [{ type: 'material', id: leftExcerpt.id, revision: 1 }] } }], left)).toThrow(DomainError);
  });

  it('applies the auto-memory migration once and leaves existing business rows unchanged', async () => {
    const rehearsal = await rehearseAutoMemoryMigration();
    expect(rehearsal.afterFirst).toBe(rehearsal.before);
    expect(rehearsal.afterSecond).toBe(rehearsal.before);
    expect(rehearsal.migrationRows).toBe(1);
    expect(rehearsal.jobCount).toBe(0);
    expect(rehearsal.tables).toEqual(['AutoMemoryJob', 'AutoMemoryScope', 'AutoMemorySource', 'AutoMemoryTurn', 'MemorySuggestionKey']);
  }, 60_000);
});
