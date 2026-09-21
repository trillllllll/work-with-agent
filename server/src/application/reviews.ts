import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../infrastructure/prisma.js';
import { assertOwner, ownerActor, type Actor } from './security.js';
import { checkKnowledgeScope, knowledgeFailure, knowledgeNow, takeKnowledgeSnapshot, type KnowledgeSnapshot } from './knowledge.js';
import { OrganizationService } from './knowledge-organizations.js';
import { latestOccurrence, localCalendarDate, validateSchedule } from './reviews-clock.js';
import { canonical, publishWorkspaceChange } from './commands.js';

const ruleSchema = z.object({ name: z.string().trim().min(1).max(200), enabled: z.boolean().default(false), frequency: z.enum(['daily', 'weekly']).default('daily'), timeOfDay: z.string().default('21:00'), timeZone: z.string().default('Asia/Hong_Kong'), weekDay: z.number().int().min(0).max(6).default(0), topicIds: z.array(z.string().min(1)).max(100).default([]), includeInbox: z.boolean().default(false), provider: z.enum(['none', 'builtin', 'external', 'codex', 'claude']).default('none') }).strict();
type RuleInput = z.infer<typeof ruleSchema>;
export type ExternalReviewGenerator = (request: { id: string; topicId: string | null; prompt: string; provider?: 'codex' | 'claude' }) => Promise<{ summary: string; commands: unknown[] }>;
function ruleDto<T extends { topicIds: string }>(row: T) { return { ...row, topicIds: JSON.parse(row.topicIds) as string[] }; }
function batchDto<T extends { snapshot: string; organizationIds: string }>(row: T) { return { ...row, snapshot: JSON.parse(row.snapshot), organizationIds: JSON.parse(row.organizationIds) as string[] }; }

export class ReviewService {
  constructor(private readonly organizations = new OrganizationService(), private readonly external?: ExternalReviewGenerator) {}
  private async checkRuleScope(actor: Actor, data: Pick<RuleInput, 'topicIds' | 'includeInbox'>) {
    if (!data.topicIds.length && !data.includeInbox) throw knowledgeFailure('EMPTY_REVIEW_SCOPE', '至少选择一个清单或收集箱', 400);
    for (const topicId of data.topicIds) await checkKnowledgeScope(prisma, actor, topicId, true);
    if (data.includeInbox) await checkKnowledgeScope(prisma, actor, null);
  }
  async rules(actor: Actor) {
    assertOwner(actor);
    return (await prisma.reviewRule.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] })).map(ruleDto);
  }
  async createRule(actor: Actor, raw: unknown) {
    assertOwner(actor);
    const data = ruleSchema.parse(raw);
    data.topicIds = [...new Set(data.topicIds)].sort();
    validateSchedule(data);
    await this.checkRuleScope(actor, data);
    const timestamp = knowledgeNow();
    return ruleDto(await prisma.reviewRule.create({ data: { ...data, topicIds: JSON.stringify(data.topicIds), createdAt: timestamp, updatedAt: timestamp } }));
  }
  async updateRule(actor: Actor, id: string, raw: unknown) {
    assertOwner(actor);
    const { expectedVersion, ...patch } = ruleSchema.partial().extend({ expectedVersion: z.number().int().positive() }).parse(raw);
    const row = await prisma.reviewRule.findUnique({ where: { id } });
    if (!row) throw knowledgeFailure('NOT_FOUND', '回顾规则不存在', 404);
    if (row.revision !== expectedVersion) throw knowledgeFailure('VERSION_CONFLICT', '回顾规则已变化');
    const previous = ruleDto(row);
    const fields = Object.fromEntries(Object.keys(ruleSchema.shape).map((key) => [key, previous[key as keyof typeof previous]]));
    const data = ruleSchema.parse({ ...fields, ...patch });
    validateSchedule(data);
    if (data.enabled) await this.checkRuleScope(actor, data);
    const updated = await prisma.reviewRule.updateMany({ where: { id, revision: expectedVersion }, data: { ...data, topicIds: JSON.stringify([...new Set(data.topicIds)].sort()), revision: { increment: 1 }, updatedAt: knowledgeNow() } });
    if (!updated.count) throw knowledgeFailure('VERSION_CONFLICT', '回顾规则已变化');
    return ruleDto(await prisma.reviewRule.findUniqueOrThrow({ where: { id } }));
  }
  async batches(actor: Actor, ruleId?: string) {
    assertOwner(actor);
    const rows = await prisma.reviewBatch.findMany({ where: ruleId ? { ruleId } : {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
    return Promise.all(rows.map((row) => this.batch(actor, row.id)));
  }
  async batch(actor: Actor, id: string) {
    assertOwner(actor);
    let row = await prisma.reviewBatch.findUnique({ where: { id } });
    if (!row) throw knowledgeFailure('NOT_FOUND', '回顾批次不存在', 404);
    const ids = JSON.parse(row.organizationIds) as string[];
    if (row.status === 'partial' && ids.length) {
      const ready = await prisma.organizationRequest.count({ where: { id: { in: ids }, status: { in: ['completed', 'proposed'] } } });
      const expected = (JSON.parse(row.snapshot) as { sources?: unknown[] }).sources?.length ?? 0;
      if (ready === ids.length && ids.length === expected) row = await prisma.reviewBatch.update({ where: { id }, data: { status: 'ready', error: null, updatedAt: knowledgeNow() } });
    }
    return batchDto(row);
  }

  async run(actor: Actor, ruleId: string, options: { occurrenceKey?: string; at?: Date; scheduled?: boolean } = {}) {
    assertOwner(actor);
    const at = options.at ?? new Date();
    const rule = await prisma.reviewRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw knowledgeFailure('NOT_FOUND', '回顾规则不存在', 404);
    if (options.scheduled && !rule.enabled) return null;
    const occurrenceKey = options.occurrenceKey ?? `manual:${randomUUID()}`;
    const existing = await prisma.reviewBatch.findUnique({ where: { ruleId_occurrenceKey: { ruleId, occurrenceKey } } });
    if (existing) return batchDto(existing);
    let batch;
    try { batch = await prisma.reviewBatch.create({ data: { ruleId, occurrenceKey, createdAt: at.toISOString(), updatedAt: at.toISOString() } }); }
    catch (error) {
      if ((error as { code?: string }).code === 'P2002') return batchDto(await prisma.reviewBatch.findUniqueOrThrow({ where: { ruleId_occurrenceKey: { ruleId, occurrenceKey } } }));
      throw error;
    }
    try {
      const topicIds = JSON.parse(rule.topicIds) as string[];
      const scopes: Array<string | null> = [...topicIds, ...(rule.includeInbox ? [null] : [])];
      const snapshots: KnowledgeSnapshot[] = [];
      const skipped: string[] = [];
      const cutoff = rule.coverageThrough ?? new Date(at.getTime() - (rule.frequency === 'weekly' ? 7 : 1) * 86_400_000).toISOString();
      const today = localCalendarDate(at, rule.timeZone);
      const lines = [`# ${rule.name}`, '', `覆盖 ${cutoff} 至 ${at.toISOString()}（${rule.timeZone}）`];
      for (const topicId of scopes) {
        const topic = await checkKnowledgeScope(prisma, actor, topicId);
        if (topic?.archivedAt) { skipped.push(topic.name); continue; }
        snapshots.push(await takeKnowledgeSnapshot(actor, { topicId }));
        const tasks = await prisma.task.findMany({ where: { topicId, deletedAt: null }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] });
        const changed = tasks.filter((task) => task.updatedAt >= cutoff && task.updatedAt <= at.toISOString());
        const materials = await prisma.material.findMany({ where: { topicId, archivedAt: null, updatedAt: { gte: cutoff, lte: at.toISOString() } }, orderBy: { updatedAt: 'desc' } });
        const memories = await prisma.memory.findMany({ where: { topicId, updatedAt: { gte: cutoff, lte: at.toISOString() } }, orderBy: { updatedAt: 'desc' } });
        const proposals = await prisma.organizationRequest.findMany({ where: { topicId, status: 'proposed' } });
        lines.push('', `## ${topic?.name ?? '收集箱'}`, `- 新增：${changed.filter((task) => task.createdAt >= cutoff).length}`, `- 完成：${changed.filter((task) => task.status === 'done').length}`, `- 逾期未完成：${tasks.filter((task) => task.status !== 'done' && task.dueDate && task.dueDate < today).length}`, `- 阻塞：${tasks.filter((task) => task.status === 'blocked').length}`, `- 材料变化：${materials.length}；记忆变化：${memories.length}`, `- 待处理整理批次：${proposals.length}`, ...changed.slice(0, 50).map((task) => `  - [${task.status}] ${task.title}`));
        if (changed.length > 50) lines.push(`  - 另有 ${changed.length - 50} 项变化，请在任务列表查看。`);
      }
      if (skipped.length) lines.push('', `已跳过归档清单：${skipped.join('、')}`);
      const timestamp = knowledgeNow();
      // Persist the useful, model-free report before attempting any external inference.
      await prisma.$transaction(async (tx) => {
        await tx.reviewBatch.update({ where: { id: batch.id }, data: { status: rule.provider === 'none' || !snapshots.length ? 'ready' : 'partial', error: rule.provider === 'none' || !snapshots.length ? null : '确定性回顾已保存，AI 整理尚未完成。', content: lines.join('\n'), snapshot: JSON.stringify({ from: cutoff, through: at.toISOString(), ruleRevision: rule.revision, sources: snapshots, skipped }), updatedAt: timestamp } });
        await tx.reviewRule.updateMany({ where: { id: ruleId, revision: rule.revision, OR: [{ coverageThrough: null }, { coverageThrough: { lt: at.toISOString() } }] }, data: { coverageThrough: at.toISOString() } });
      });
      if (rule.provider !== 'none' && snapshots.length) await this.generateSuggestions(actor, batch.id, rule.provider, snapshots);
      const completed = await this.batch(actor, batch.id);
      publishWorkspaceChange({ kind: 'review', batchId: completed.id, status: completed.status });
      return completed;
    } catch (error) {
      await prisma.reviewBatch.update({ where: { id: batch.id }, data: { status: 'failed', error: error instanceof Error ? error.message : '回顾生成失败', updatedAt: knowledgeNow() } });
      const failed = await this.batch(actor, batch.id);
      publishWorkspaceChange({ kind: 'review', batchId: failed.id, status: failed.status });
      return failed;
    }
  }

  private async generateSuggestions(actor: Actor, batchId: string, provider: string, snapshots: KnowledgeSnapshot[]) {
    const ids: string[] = [];
    const errors: string[] = [];
    for (const snapshot of snapshots) {
      try {
        const organization = await this.organizations.create(actor, { topicId: snapshot.topicId, purpose: '根据本次回顾整理耐久记忆与下一步建议。只提议，不派发任务；无需建议时返回空命令。', provider: provider === 'builtin' ? 'builtin' : 'external', materialIds: snapshot.sources.filter((row) => row.type === 'material').map((row) => row.id), memoryIds: snapshot.sources.filter((row) => row.type === 'memory').map((row) => row.id), taskIds: snapshot.sources.filter((row) => row.type === 'task').map((row) => row.id) });
        const organizationId = String(organization.id);
        ids.push(organizationId);
        // Persist each request before inference, so crashes never silently restart a model call.
        await prisma.reviewBatch.update({ where: { id: batchId }, data: { status: 'partial', organizationIds: JSON.stringify(ids), updatedAt: knowledgeNow() } });
        const manifest = (value: KnowledgeSnapshot) => value.sources.map(({ type, id, revision, hash }) => ({ type, id, revision, hash })).sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
        if (canonical(manifest(organization.snapshot)) !== canonical(manifest(snapshot))) {
          await prisma.organizationRequest.update({ where: { id: organizationId }, data: { status: 'stale', snapshot: JSON.stringify(snapshot), error: 'SOURCE_STALE: 回顾来源已变化，请建立新的回顾批次。', updatedAt: knowledgeNow() } });
          throw knowledgeFailure('SOURCE_STALE', '回顾来源已变化，请建立新的回顾批次。');
        }
        if (provider === 'builtin') await this.organizations.generate(actor, organizationId);
        else if ((provider === 'codex' || provider === 'claude') && this.external) {
          const output = await this.external({ id: organizationId, topicId: snapshot.topicId, prompt: organization.prompt, provider });
          await this.organizations.submitCandidates(actor, organizationId, output);
        } else errors.push('外部 AI 整理请求已就绪，请在已连接的宿主读取并提交候选。');
      } catch (error) { errors.push(error instanceof Error ? `${'code' in error ? `${error.code}: ` : ''}${error.message}` : 'AI 整理失败'); }
    }
    await prisma.reviewBatch.update({ where: { id: batchId }, data: { status: errors.length ? 'partial' : 'ready', organizationIds: JSON.stringify(ids), error: errors.length ? [...new Set(errors)].join('\n') : null, updatedAt: knowledgeNow() } });
  }

  async retry(actor: Actor, id: string) {
    assertOwner(actor);
    const batch = await this.batch(actor, id);
    const rule = await prisma.reviewRule.findUniqueOrThrow({ where: { id: batch.ruleId } });
    // A retry creates a fresh batch with fresh sources; an uncertain model request is never replayed.
    return this.run(actor, rule.id, { occurrenceKey: `retry:${id}:${randomUUID()}` });
  }

  async tick(at = new Date()) {
    const rules = await prisma.reviewRule.findMany({ where: { enabled: true }, orderBy: { id: 'asc' } });
    const outcomes: unknown[] = [];
    for (const rule of rules) {
      try {
        const occurrence = latestOccurrence(rule, at);
        // Creating, resuming or editing a schedule only affects future occurrences.
        if (occurrence.scheduledAt < rule.updatedAt) continue;
        const prior = await prisma.reviewBatch.findUnique({ where: { ruleId_occurrenceKey: { ruleId: rule.id, occurrenceKey: occurrence.key } } });
        if (prior) continue;
        outcomes.push(await this.run(ownerActor, rule.id, { occurrenceKey: occurrence.key, at, scheduled: true }));
      } catch (error) { outcomes.push({ ruleId: rule.id, error: error instanceof Error ? error.message : '回顾规则无效' }); }
    }
    return outcomes;
  }
}

/** The server owns lifetime; tests do not start timers merely by importing a module. */
export function startReviewScheduler(service = new ReviewService(), intervalMs = 60_000) {
  let busy = false;
  let stopped = false;
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    try { await service.tick(); } catch (error) { console.error('Review scheduler:', error instanceof Error ? error.message : error); }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  void run();
  return () => { stopped = true; clearInterval(timer); };
}
