import { randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ModelAdapter } from '../agent.js';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { archiveCompletedTurns, failCollectingTurns } from './auto-memory-chat.js';
import {
  assertSingleMemoryScope,
  backfillSuggestionKeys,
  candidateEvidenceAllowed,
  identityFromCommand,
  insertSuggestion,
  lookupSuggestion,
  matchesActiveMemory,
  memorySuggestionHooks,
  sameWrittenFields,
  suggestionKey,
} from './auto-memory-suggestions.js';
import {
  AUTO_MEMORY_SYSTEM_PROMPT,
  JOB_LEASE_MS,
  MAX_COALESCE_MS,
  MEMORY_CONTEXT_LIMIT,
  MEMORY_EXCERPT_CHARS,
  MIN_SCOPE_INTERVAL_MS,
  MODEL_TIMEOUT_MS,
  PAGE_SIZE,
  QUIET_PERIOD_MS,
  SCAN_INTERVAL_MS,
  SOURCE_PART_CHARS,
  SOURCES_PER_JOB,
  autoMemoryOutputSchema,
  autoSourceRowId,
  clipCodePoints,
  isAutoJobStatus,
  readJson,
  scopeKey,
  sha256,
  splitCodePoints,
  type AutoMemoryCandidate,
  type AutoMemoryOutput,
  type AutoMemoryState,
  type AutoSourceType,
  type FrozenMemory,
  type FrozenSnapshot,
  type FrozenSource,
} from './auto-memory-types.js';
import { CommandService, canonical, type Command } from './commands.js';
import { knowledgeHash, readLabels } from './knowledge.js';
import type { OrganizationModel } from './knowledge-organizations.js';
import { assertOwner, type Actor } from './security.js';
import { SettingsService } from './settings.js';

type Db = Prisma.TransactionClient | PrismaClient;
type ScopeRow = { id: string; topicId: string | null; enabled: boolean; revision: number; initializedAt: string | null; dirtySince: string | null; dueAt: string | null; lastStartedAt: string | null; lastCompletedAt: string | null };
export class AutoMemoryCrash extends Error {
  constructor() { super('auto-memory crashed before proposals'); this.name = 'AutoMemoryCrash'; }
}

type Prepared = { part: number; partCount: number; text: string; observedHash: string; pendingReason: string | null; revision: number; evidenceHash: string; extractionHash: string | null; title: string };

export class AutoMemoryService {
  private tail: Promise<unknown> = Promise.resolve();
  private backfilled = false;
  private readonly commands = new CommandService();

  constructor(private readonly deps: {
    now: () => Date;
    model: OrganizationModel;
    hasModelConfig: () => Promise<boolean>;
    afterOutputSaved?: () => Promise<void>;
  }) {}

  private iso() { return this.deps.now().toISOString(); }
  private nowMs() { return this.deps.now().getTime(); }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async prepareStartup() {
    await failCollectingTurns(this.iso());
    await this.backfillOnce();
  }

  async backfillOnce() {
    if (this.backfilled) return;
    this.backfilled = true;
    try { await backfillSuggestionKeys(prisma, this.iso()); }
    catch (error) { this.backfilled = false; throw error; }
  }

  async scan() {
    return this.enqueue(async () => {
      await archiveCompletedTurns();
      await prisma.$transaction(async (tx) => { await this.scanWithin(tx); }, { timeout: 60_000 });
    });
  }

  async tick(options: { forceScope?: string; ignoreQuiet?: boolean } = {}) {
    await this.recoverExpired();
    await this.scan();
    if (await this.globalRunning()) return;
    if (!(await this.deps.hasModelConfig())) return;
    for (const scope of await this.dueScopes(options)) {
      const claimed = await this.claim(scope, options);
      if (claimed === 'busy') return;
      if (claimed === 'empty') continue;
      await this.execute(claimed);
      return;
    }
  }

  async state(topicId: string | null): Promise<AutoMemoryState> {
    await this.backfillOnce();
    const topic = await this.requireTopic(topicId);
    const key = scopeKey(topicId);
    const scope = await this.ensureScope(prisma, topicId);
    const sources = await prisma.autoMemorySource.findMany({ where: { scopeKey: key, available: true }, select: { observedHash: true, processedHash: true, failedHash: true } });
    let pendingSourceCount = 0;
    let failedSourceCount = 0;
    for (const source of sources) {
      const open = source.observedHash !== source.processedHash;
      if (!open) continue;
      if (source.failedHash && source.failedHash === source.observedHash) failedSourceCount += 1;
      else pendingSourceCount += 1;
    }
    const pendingProposalCount = await this.countPendingProposals(key);
    const latest = await prisma.autoMemoryJob.findFirst({ where: { scopeKey: key }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const active = await prisma.autoMemoryJob.findFirst({ where: { scopeKey: key, status: 'running', leaseExpiresAt: { gt: this.iso() } } });
    const configured = await this.deps.hasModelConfig();
    const name = !scope.enabled ? 'disabled'
      : topic?.archivedAt ? 'archived'
      : !configured ? 'unconfigured'
      : active ? 'running'
      : scope.dueAt || pendingSourceCount > 0 ? 'queued'
      : failedSourceCount > 0 ? 'failed'
      : 'idle';
    return {
      scopeKey: key,
      topicId,
      enabled: scope.enabled,
      revision: scope.revision,
      state: name,
      pendingSourceCount,
      failedSourceCount,
      pendingProposalCount,
      dueAt: scope.dueAt,
      lastStartedAt: scope.lastStartedAt,
      lastCompletedAt: scope.lastCompletedAt,
      latestJob: latest && isAutoJobStatus(latest.status) ? { id: latest.id, status: latest.status, errorCode: latest.errorCode, errorMessage: latest.errorMessage } : null,
    };
  }

  async setEnabled(actor: Actor, topicId: string | null, enabled: boolean, expectedRevision: number) {
    assertOwner(actor);
    await this.requireTopic(topicId);
    const key = scopeKey(topicId);
    const scope = await this.ensureScope(prisma, topicId);
    if (scope.revision !== expectedRevision) throw new DomainError('VERSION_CONFLICT', '自动提炼设置已变化', 409);
    const updated = await prisma.autoMemoryScope.updateMany({ where: { id: key, revision: expectedRevision }, data: { enabled, revision: { increment: 1 }, updatedAt: this.iso() } });
    if (!updated.count) throw new DomainError('VERSION_CONFLICT', '自动提炼设置已变化', 409);
    if (!enabled) {
      await prisma.autoMemoryJob.updateMany({
        where: { scopeKey: key, status: 'running', proposalIds: '[]' },
        data: { status: 'cancelled', errorCode: 'CANCELLED', errorMessage: '自动提炼已暂停', leaseToken: null, leaseExpiresAt: null, completedAt: this.iso() },
      });
    } else await this.scan();
    return this.state(topicId);
  }

  async run(actor: Actor, topicId: string | null, requestId: string) {
    assertOwner(actor);
    const requestHash = sha256(canonical({ topicId, requestId }));
    const storedId = `auto-memory-run:${requestId}`;
    const existing = await this.readReceipt(actor.id, storedId, requestHash);
    if (existing) return existing;
    const topic = await this.requireTopic(topicId);
    const key = scopeKey(topicId);
    const scope = await this.ensureScope(prisma, topicId);
    if (!scope.enabled) throw new DomainError('AUTO_MEMORY_DISABLED', '自动提炼已暂停', 409);
    if (topic?.archivedAt) throw new DomainError('TOPIC_ARCHIVED', '已归档，暂停提炼', 409);
    if (!(await this.deps.hasModelConfig())) throw new DomainError('MODEL_UNCONFIGURED', '尚未配置内置模型', 409);
    const running = await prisma.autoMemoryJob.findFirst({ where: { scopeKey: key, status: 'running', leaseExpiresAt: { gt: this.iso() } } });
    if (running) return this.writeReceipt(actor.id, storedId, requestHash, { accepted: true, job: jobView(running) });
    await this.scan();
    if (!(await this.readablePending(key)).length) return this.writeReceipt(actor.id, storedId, requestHash, { accepted: false, reason: 'NO_CHANGES' });
    const other = await prisma.autoMemoryJob.findFirst({ where: { status: 'running', leaseExpiresAt: { gt: this.iso() } } });
    const due = this.iso();
    await prisma.autoMemoryScope.update({ where: { id: key }, data: { dueAt: due, dirtySince: scope.dirtySince ?? due, updatedAt: due } });
    if (other && other.scopeKey !== key) return this.writeReceipt(actor.id, storedId, requestHash, { accepted: true, job: null });
    await this.tick({ forceScope: key, ignoreQuiet: true });
    const job = await prisma.autoMemoryJob.findFirst({ where: { scopeKey: key }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return this.writeReceipt(actor.id, storedId, requestHash, { accepted: true, job: job ? jobView(job) : null });
  }

  async retry(actor: Actor, jobId: string, requestId: string) {
    assertOwner(actor);
    const requestHash = sha256(canonical({ jobId, requestId }));
    const storedId = `auto-memory-retry:${requestId}`;
    const existing = await this.readReceipt(actor.id, storedId, requestHash);
    if (existing) return existing;
    const job = await prisma.autoMemoryJob.findUnique({ where: { id: jobId } });
    if (!job) throw new DomainError('NOT_FOUND', '提炼作业不存在', 404);
    if (job.status !== 'failed') throw new DomainError('JOB_NOT_RETRYABLE', '只能重试失败的提炼', 409);
    const scope = await prisma.autoMemoryScope.findUnique({ where: { id: job.scopeKey } });
    if (!scope) throw new DomainError('NOT_FOUND', '提炼范围不存在', 404);
    const topic = await this.requireTopic(scope.topicId);
    if (!scope.enabled) throw new DomainError('AUTO_MEMORY_DISABLED', '自动提炼已暂停', 409);
    if (topic?.archivedAt) throw new DomainError('TOPIC_ARCHIVED', '已归档，暂停提炼', 409);
    if (!(await this.deps.hasModelConfig())) throw new DomainError('MODEL_UNCONFIGURED', '尚未配置内置模型', 409);
    const snapshot = readJson<FrozenSnapshot | null>(job.snapshot, null);
    const parsed = job.modelOutput ? parseOutput(job.modelOutput) : null;
    if (job.errorCode === 'INTERRUPTED' && parsed && snapshot) {
      const matches = await this.sourcesMatch(snapshot.sources, snapshot.topicId);
      const attempt = await this.nextAttempt(job.scopeKey, job.inputHash);
      if (!matches) {
        const created = await prisma.autoMemoryJob.create({ data: { scopeKey: job.scopeKey, inputHash: job.inputHash, attempt, status: 'failed', snapshot: job.snapshot, modelOutput: job.modelOutput, errorCode: 'SOURCE_STALE', errorMessage: '来源已变化，将重新提炼', proposalIds: '[]', createdAt: this.iso(), completedAt: this.iso() } });
        await this.scan();
        return this.writeReceipt(actor.id, storedId, requestHash, jobView(created));
      }
      const token = randomBytes(16).toString('hex');
      const now = this.iso();
      const created = await prisma.autoMemoryJob.create({ data: { scopeKey: job.scopeKey, inputHash: job.inputHash, attempt, status: 'running', snapshot: job.snapshot, modelOutput: job.modelOutput, proposalIds: '[]', leaseToken: token, leaseExpiresAt: new Date(this.nowMs() + JOB_LEASE_MS).toISOString(), createdAt: now, startedAt: now } });
      await this.persist({ jobId: created.id, token, scopeKey: job.scopeKey, topicId: scope.topicId, snapshot }, parsed);
      const saved = await prisma.autoMemoryJob.findUniqueOrThrow({ where: { id: created.id } });
      return this.writeReceipt(actor.id, storedId, requestHash, jobView(saved));
    }
    if (snapshot) {
      for (const source of snapshot.sources) {
        await prisma.autoMemorySource.updateMany({ where: { id: source.rowId, failedHash: source.observedHash }, data: { failedHash: null, updatedAt: this.iso() } });
      }
    }
    const due = this.iso();
    await prisma.autoMemoryScope.update({ where: { id: job.scopeKey }, data: { dueAt: due, dirtySince: scope.dirtySince ?? due, updatedAt: due } });
    await this.tick({ forceScope: job.scopeKey, ignoreQuiet: true });
    const latest = await prisma.autoMemoryJob.findFirst({ where: { scopeKey: job.scopeKey }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return this.writeReceipt(actor.id, storedId, requestHash, latest ? jobView(latest) : null);
  }

  async proposals(topicId: string | null, cursor = 0, limit = 20) {
    await this.backfillOnce();
    await this.requireTopic(topicId);
    const key = scopeKey(topicId);
    const links = await prisma.memorySuggestionKey.findMany({ where: { scopeKey: key }, select: { proposalId: true } });
    const ids = [...new Set(links.map((link) => link.proposalId))];
    const rows = ids.length ? await prisma.proposal.findMany({ where: { id: { in: ids }, status: 'pending' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) : [];
    const matched = rows.filter((row) => readJson<Command[]>(row.commands, []).some((command) => command.kind.startsWith('memory.')));
    const page = matched.slice(cursor, cursor + limit);
    return {
      items: page.map((row) => ({ id: row.id, revision: row.revision, status: row.status, commands: JSON.parse(row.commands) as unknown[], preview: JSON.parse(row.preview) as unknown, createdAt: row.createdAt })),
      total: matched.length,
      nextCursor: cursor + page.length < matched.length ? cursor + page.length : null,
    };
  }

  private async scanWithin(tx: Db) {
    const topics = await tx.topic.findMany({ where: { archivedAt: null }, orderBy: { id: 'asc' }, select: { id: true } });
    for (const topicId of [null, ...topics.map((topic) => topic.id)]) await this.scanScope(tx, topicId);
  }

  private async scanScope(tx: Db, topicId: string | null) {
    const scope = await this.ensureScope(tx, topicId);
    if (!scope.enabled) return;
    const seen = new Set<string>();
    let changed = false;
    const stamp = () => { changed = true; };
    let materialCursor: string | undefined;
    while (true) {
      const materials = await tx.material.findMany({ where: { topicId, archivedAt: null, ...(materialCursor ? { id: { gt: materialCursor } } : {}) }, orderBy: { id: 'asc' }, take: PAGE_SIZE });
      for (const material of materials) {
        const prepared = await this.prepareMaterial(tx, material);
        if (await this.upsertParts(tx, scope.id, 'material', material.id, prepared, seen, stamp)) changed = true;
      }
      if (materials.length < PAGE_SIZE) break;
      materialCursor = materials[materials.length - 1].id;
    }
    let taskCursor: string | undefined;
    while (true) {
      const tasks = await tx.task.findMany({ where: { topicId, deletedAt: null, ...(taskCursor ? { id: { gt: taskCursor } } : {}) }, orderBy: { id: 'asc' }, take: PAGE_SIZE });
      for (const task of tasks) {
        const prepared = prepareTask(task);
        if (await this.upsertParts(tx, scope.id, 'task', task.id, prepared, seen, stamp)) changed = true;
      }
      if (tasks.length < PAGE_SIZE) break;
      taskCursor = tasks[tasks.length - 1].id;
    }
    const current = await tx.autoMemorySource.findMany({ where: { scopeKey: scope.id, available: true }, select: { id: true } });
    const missing = current.filter((row) => !seen.has(row.id)).map((row) => row.id);
    if (missing.length) await tx.autoMemorySource.updateMany({ where: { id: { in: missing } }, data: { available: false, updatedAt: this.iso() } });
    const fresh = await tx.autoMemoryScope.findUniqueOrThrow({ where: { id: scope.id } });
    const now = this.iso();
    if (changed) {
      const dirtySince = fresh.dirtySince ?? now;
      const dueAt = new Date(Math.min(this.nowMs() + QUIET_PERIOD_MS, new Date(dirtySince).getTime() + MAX_COALESCE_MS)).toISOString();
      await tx.autoMemoryScope.update({ where: { id: scope.id }, data: { dirtySince, dueAt, initializedAt: fresh.initializedAt ?? now, updatedAt: now } });
    } else if (!fresh.initializedAt) {
      await tx.autoMemoryScope.update({ where: { id: scope.id }, data: { initializedAt: now, updatedAt: now } });
    }
  }

  private async upsertParts(tx: Db, key: string, sourceType: AutoSourceType, sourceId: string, parts: Prepared[], seen: Set<string>, stamp: () => void) {
    let changed = false;
    const now = this.iso();
    for (const part of parts) {
      const id = autoSourceRowId(key, sourceType, sourceId, part.part);
      seen.add(id);
      const existing = await tx.autoMemorySource.findUnique({ where: { id } });
      if (!existing) {
        await tx.autoMemorySource.create({ data: { id, scopeKey: key, sourceType, sourceId, part: part.part, revision: Math.max(1, part.revision), observedHash: part.observedHash, available: true, firstObservedAt: now, changedAt: now, updatedAt: now } });
        changed = true;
        stamp();
      } else if (existing.observedHash !== part.observedHash || !existing.available) {
        await tx.autoMemorySource.update({ where: { id }, data: { observedHash: part.observedHash, revision: existing.revision + 1, changedAt: now, failedHash: null, available: true, updatedAt: now } });
        changed = true;
        stamp();
      }
    }
    return changed;
  }

  private async prepareMaterial(tx: Db, material: { id: string; kind: string; title: string; revision: number }): Promise<Prepared[]> {
    const version = await tx.materialVersion.findUnique({ where: { materialId_revision: { materialId: material.id, revision: material.revision } } });
    if (!version) return [pendingPart(material.revision, '', null, material.title, '缺少版本')];
    if (material.kind === 'attachment') {
      const extraction = await tx.materialExtraction.findUnique({ where: { materialId_revision: { materialId: material.id, revision: material.revision } } });
      const chunks = extraction && extraction.indexedGeneration > 0 ? await tx.materialChunk.findMany({ where: { extractionId: extraction.id, generation: extraction.indexedGeneration }, orderBy: { ordinal: 'asc' } }) : [];
      const extractionHash = chunks.length ? sha256(canonical(chunks.map((chunk) => chunk.textHash))) : null;
      const readable = Boolean(extraction && ['ready', 'partial'].includes(extraction.status) && chunks.length && chunks.some((chunk) => chunk.text.trim()));
      if (!readable) {
        const reason = extraction?.status === 'failed' || extraction?.status === 'unsupported' || extraction?.status === 'blocked' ? '解析失败' : chunks.length && !chunks.some((chunk) => chunk.text.trim()) ? '无可读正文' : '正文尚未解析';
        return [pendingPart(material.revision, version.contentHash, extractionHash, material.title, reason)];
      }
      return splitSource(chunks.map((chunk) => chunk.text).join(''), material.revision, version.contentHash, extractionHash, material.title);
    }
    return splitSource(version.content, material.revision, version.contentHash, null, material.title);
  }

  private async recoverExpired() {
    const now = this.iso();
    const expired = await prisma.autoMemoryJob.findMany({ where: { status: 'running', leaseExpiresAt: { lt: now } } });
    for (const job of expired) {
      const marked = await prisma.autoMemoryJob.updateMany({ where: { id: job.id, status: 'running', leaseExpiresAt: { lt: now } }, data: { status: 'failed', errorCode: 'INTERRUPTED', errorMessage: '提炼中断，请重试', completedAt: now, leaseToken: null, leaseExpiresAt: null } });
      if (!marked.count) continue;
      const snapshot = readJson<FrozenSnapshot | null>(job.snapshot, null);
      if (!snapshot) continue;
      for (const source of snapshot.sources) {
        await prisma.autoMemorySource.updateMany({ where: { id: source.rowId, observedHash: source.observedHash }, data: { failedHash: source.observedHash, updatedAt: now } });
      }
    }
  }

  private async globalRunning() {
    return Boolean(await prisma.autoMemoryJob.findFirst({ where: { status: 'running', leaseExpiresAt: { gt: this.iso() } } }));
  }

  private async dueScopes(options: { forceScope?: string; ignoreQuiet?: boolean }) {
    const now = this.iso();
    const rows = options.forceScope
      ? await prisma.autoMemoryScope.findMany({ where: { id: options.forceScope, enabled: true } })
      : await prisma.autoMemoryScope.findMany({ where: { enabled: true, dueAt: { lte: now } } });
    const open: ScopeRow[] = [];
    for (const scope of rows) {
      if (scope.topicId) {
        const topic = await prisma.topic.findUnique({ where: { id: scope.topicId }, select: { archivedAt: true } });
        if (!topic || topic.archivedAt) continue;
      }
      if (!options.ignoreQuiet && scope.lastStartedAt && this.nowMs() - new Date(scope.lastStartedAt).getTime() < MIN_SCOPE_INTERVAL_MS) continue;
      if (!options.forceScope && (!scope.dueAt || scope.dueAt > now)) continue;
      open.push(scope);
    }
    return open.sort((left, right) => (left.dueAt ?? '').localeCompare(right.dueAt ?? '') || left.id.localeCompare(right.id));
  }

  private async claim(scope: ScopeRow, _options: { ignoreQuiet?: boolean }): Promise<'busy' | 'empty' | { jobId: string; token: string; scopeKey: string; topicId: string | null; snapshot: FrozenSnapshot; inputHash: string }> {
    try {
      return await prisma.$transaction(async (tx) => {
        const running = await tx.autoMemoryJob.findFirst({ where: { status: 'running', leaseExpiresAt: { gt: this.iso() } } });
        if (running) return 'busy' as const;
        const pending = await tx.autoMemorySource.findMany({ where: { scopeKey: scope.id, available: true }, orderBy: [{ changedAt: 'asc' }, { id: 'asc' }] });
        const selected: FrozenSource[] = [];
        for (const row of pending) {
          if (row.observedHash === row.processedHash || row.observedHash === row.failedHash) continue;
          if (!isAutoSourceType(row.sourceType)) continue;
          const fresh = await this.freezeSource(tx, scope.topicId, row.sourceType, row.sourceId, row.part, row.observedHash);
          if (!fresh || fresh.pendingReason) continue;
          selected.push(fresh);
          if (selected.length >= SOURCES_PER_JOB) break;
        }
        if (!selected.length) {
          await tx.autoMemoryScope.update({ where: { id: scope.id }, data: { dirtySince: null, dueAt: null, updatedAt: this.iso() } });
          return 'empty' as const;
        }
        const memories = await this.freezeMemories(tx, scope.topicId);
        const snapshot: FrozenSnapshot = { promptVersion: 1, scopeKey: scope.id, topicId: scope.topicId, sources: selected, memories: memories.items, memoryTotal: memories.total, memoriesTruncated: memories.total > MEMORY_CONTEXT_LIMIT };
        const inputHash = sha256(canonical(snapshot));
        const attempt = ((await tx.autoMemoryJob.findFirst({ where: { scopeKey: scope.id, inputHash }, orderBy: { attempt: 'desc' } }))?.attempt ?? 0) + 1;
        const now = this.iso();
        const token = randomBytes(16).toString('hex');
        const job = await tx.autoMemoryJob.create({ data: { scopeKey: scope.id, inputHash, attempt, status: 'queued', snapshot: JSON.stringify(snapshot), proposalIds: '[]', createdAt: now } });
        const leaseExpiresAt = new Date(this.nowMs() + JOB_LEASE_MS).toISOString();
        const switched = await tx.autoMemoryJob.updateMany({ where: { id: job.id, status: 'queued' }, data: { status: 'running', leaseToken: token, leaseExpiresAt, startedAt: now } });
        if (!switched.count) return 'busy' as const;
        await tx.autoMemoryScope.update({ where: { id: scope.id }, data: { lastStartedAt: now, updatedAt: now } });
        return { jobId: job.id, token, scopeKey: scope.id, topicId: scope.topicId, snapshot, inputHash };
      }, { timeout: 30_000 });
    } catch (error) {
      if (isUnique(error)) return 'busy';
      throw error;
    }
  }

  private async execute(claim: { jobId: string; token: string; scopeKey: string; topicId: string | null; snapshot: FrozenSnapshot; inputHash: string }) {
    const job = await prisma.autoMemoryJob.findUnique({ where: { id: claim.jobId } });
    if (!job || job.status !== 'running' || job.leaseToken !== claim.token) return;
    let text = '';
    try {
      const result = await this.deps.model.complete([
        { role: 'system', content: AUTO_MEMORY_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(claim.snapshot) },
      ], AbortSignal.timeout(MODEL_TIMEOUT_MS));
      text = result.text;
    } catch (error) {
      if (await this.lost(claim.jobId, claim.token)) return;
      const timedOut = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      await this.failJob(claim, timedOut ? 'MODEL_TIMEOUT' : 'MODEL_FAILED', timedOut ? '提炼超时，请稍后重试' : '提炼失败，请稍后重试', true);
      return;
    }
    const saved = await prisma.autoMemoryJob.updateMany({ where: { id: claim.jobId, status: 'running', leaseToken: claim.token }, data: { modelOutput: text } });
    if (!saved.count) return;
    if (this.deps.afterOutputSaved) await this.deps.afterOutputSaved();
    let parsed: AutoMemoryOutput;
    try { parsed = requireOutput(text); }
    catch (error) {
      if (error instanceof AutoMemoryCrash) throw error;
      if (await this.lost(claim.jobId, claim.token)) return;
      await this.failJob(claim, 'INVALID_MODEL_OUTPUT', error instanceof Error ? error.message : '模型输出无法采用', true);
      return;
    }
    try { await this.persist(claim, parsed); }
    catch (error) {
      if (error instanceof AutoMemoryCrash) throw error;
      if (await this.lost(claim.jobId, claim.token)) return;
      const code = error instanceof DomainError ? error.code : 'MODEL_FAILED';
      const keep = code === 'SOURCE_STALE' || code === 'AUTO_MEMORY_CANCELLED' || code === 'TOPIC_ARCHIVED';
      await this.failJob(claim, code, error instanceof Error ? error.message : '提炼失败，请稍后重试', !keep);
    }
  }

  private async persist(claim: { jobId: string; token: string; scopeKey: string; topicId: string | null; snapshot: FrozenSnapshot }, parsed: AutoMemoryOutput) {
    if (await this.lost(claim.jobId, claim.token)) return;
    const scope = await prisma.autoMemoryScope.findUnique({ where: { id: claim.scopeKey } });
    if (!scope?.enabled) throw new DomainError('AUTO_MEMORY_CANCELLED', '自动提炼已暂停', 409);
    if (scope.topicId) {
      const topic = await prisma.topic.findUnique({ where: { id: scope.topicId }, select: { archivedAt: true } });
      if (topic?.archivedAt) throw new DomainError('TOPIC_ARCHIVED', '已归档，暂停提炼', 409);
    }
    if (!(await this.sourcesMatch(claim.snapshot.sources, claim.snapshot.topicId))) throw new DomainError('SOURCE_STALE', '来源已变化，将重新提炼', 409);
    const invalid = parsed.candidates.find((candidate) => !candidateAllowed(candidate, claim.snapshot));
    if (invalid) throw new DomainError('INVALID_MODEL_OUTPUT', '模型输出无法采用', 502);
    const memories = await this.activeMemories(claim.topicId);
    const kept: Array<{ candidate: AutoMemoryCandidate; key: string }> = [];
    const seen = new Set<string>();
    let deduped = 0;
    for (const candidate of parsed.candidates) {
      const identity = identityFromCommand(commandFor(candidate, claim.topicId), claim.scopeKey);
      if (!identity) { deduped += 1; continue; }
      const key = suggestionKey(identity);
      if (seen.has(key)) { deduped += 1; continue; }
      seen.add(key);
      if (candidate.action === 'create' && matchesActiveMemory(candidate, memories)) { deduped += 1; continue; }
      if (candidate.action === 'update') {
        const target = memories.find((memory) => memory.id === candidate.targetId);
        if (target && sameWrittenFields(candidate, target)) { deduped += 1; continue; }
      }
      kept.push({ candidate, key });
    }
    void deduped;
    for (const item of kept) {
      if (item.candidate.action === 'create') continue;
      const memory = await prisma.memory.findUnique({ where: { id: item.candidate.targetId ?? '' } });
      if (!memory || memory.revision !== item.candidate.expectedRevision) throw new DomainError('VERSION_CONFLICT', '记忆版本已变化', 409);
    }
    const proposalIds: string[] = [];
    const createdAt = this.iso();
    for (const item of kept) {
      const hooks = memorySuggestionHooks(claim.topicId, createdAt);
      try {
        const response = await this.commands.submit(autoActor(claim.jobId, claim.topicId), {
          requestId: `auto-memory:${claim.jobId}:${item.key}`,
          commands: [commandFor(item.candidate, claim.topicId)],
        }, {
          forceProposal: true,
          beforePersist: async (tx, commands) => {
            assertSingleMemoryScope(commands, claim.topicId);
            await this.assertLease(tx, claim.jobId, claim.token);
            if (!(await this.sourcesMatch(claim.snapshot.sources, claim.snapshot.topicId, tx))) throw new DomainError('SOURCE_STALE', '来源已变化，将重新提炼', 409);
            return hooks.beforePersist(tx, commands);
          },
          afterProposal: async (tx, proposalId, commands) => {
            await hooks.afterProposal(tx, proposalId, commands);
            await insertSuggestion(tx, item.key, claim.scopeKey, proposalId, createdAt).catch((error: unknown) => {
              if (error instanceof DomainError && error.code === 'SUGGESTION_EXISTS') return;
              throw error;
            });
          },
        });
        if (typeof response.proposalId === 'string') proposalIds.push(response.proposalId);
        await prisma.autoMemoryJob.updateMany({ where: { id: claim.jobId, status: 'running', leaseToken: claim.token }, data: { proposalIds: JSON.stringify(proposalIds) } });
      } catch (error) {
        if (error instanceof DomainError && error.code === 'SUGGESTION_EXISTS') {
          const found = await lookupSuggestion(prisma, item.key);
          if (found) { proposalIds.push(found.proposalId); continue; }
        }
        throw error;
      }
    }
    const finished = await prisma.autoMemoryJob.updateMany({
      where: { id: claim.jobId, status: 'running', leaseToken: claim.token },
      data: { status: proposalIds.length ? 'proposed' : 'completed', proposalIds: JSON.stringify(proposalIds), completedAt: this.iso(), leaseToken: null, leaseExpiresAt: null, errorCode: null, errorMessage: null },
    });
    if (!finished.count) return;
    await this.markProcessed(claim.snapshot.sources);
    await prisma.autoMemoryScope.update({ where: { id: claim.scopeKey }, data: { lastCompletedAt: this.iso(), updatedAt: this.iso() } });
    await this.scheduleNext(claim.scopeKey);
  }

  private async failJob(claim: { jobId: string; token: string; scopeKey: string; snapshot: FrozenSnapshot }, code: string, message: string, failedHash: boolean) {
    const now = this.iso();
    const marked = await prisma.autoMemoryJob.updateMany({ where: { id: claim.jobId, status: 'running', leaseToken: claim.token }, data: { status: 'failed', errorCode: code, errorMessage: message.slice(0, 300), completedAt: now, leaseToken: null, leaseExpiresAt: null } });
    if (!marked.count) return;
    if (failedHash) {
      for (const source of claim.snapshot.sources) {
        await prisma.autoMemorySource.updateMany({ where: { id: source.rowId, observedHash: source.observedHash }, data: { failedHash: source.observedHash, updatedAt: now } });
      }
    }
    await this.scheduleNext(claim.scopeKey);
  }

  private async scheduleNext(key: string) {
    const readable = await this.readablePending(key);
    const now = this.iso();
    if (readable.length) {
      const scope = await prisma.autoMemoryScope.findUnique({ where: { id: key } });
      const started = scope?.lastStartedAt ? new Date(scope.lastStartedAt).getTime() : this.nowMs();
      const dueAt = new Date(Math.max(this.nowMs(), started + MIN_SCOPE_INTERVAL_MS)).toISOString();
      await prisma.autoMemoryScope.update({ where: { id: key }, data: { dueAt, dirtySince: scope?.dirtySince ?? now, updatedAt: now } });
      return;
    }
    await prisma.autoMemoryScope.update({ where: { id: key }, data: { dirtySince: null, dueAt: null, updatedAt: now } });
  }

  private async markProcessed(sources: FrozenSource[]) {
    const now = this.iso();
    for (const source of sources) {
      await prisma.autoMemorySource.updateMany({ where: { id: source.rowId, observedHash: source.observedHash }, data: { processedHash: source.observedHash, updatedAt: now } });
    }
  }

  private async readablePending(key: string) {
    const rows = await prisma.autoMemorySource.findMany({ where: { scopeKey: key, available: true }, orderBy: [{ changedAt: 'asc' }, { id: 'asc' }] });
    const scope = await prisma.autoMemoryScope.findUnique({ where: { id: key } });
    const selected = [];
    for (const row of rows) {
      if (row.observedHash === row.processedHash || row.observedHash === row.failedHash) continue;
      if (!isAutoSourceType(row.sourceType) || !scope) continue;
      const fresh = await this.freezeSource(prisma, scope.topicId, row.sourceType, row.sourceId, row.part, row.observedHash);
      if (fresh && !fresh.pendingReason) selected.push(row);
    }
    return selected;
  }

  private async sourcesMatch(sources: FrozenSource[], topicId: string | null, tx: Db = prisma) {
    for (const source of sources) {
      const fresh = await this.freezeSource(tx, topicId, source.sourceType, source.sourceId, source.part, source.observedHash);
      if (!fresh || fresh.pendingReason) return false;
      if (fresh.revision !== source.revision || fresh.evidenceHash !== source.evidenceHash || fresh.extractionHash !== source.extractionHash || fresh.observedHash !== source.observedHash) return false;
    }
    return true;
  }

  private async freezeSource(tx: Db, topicId: string | null, sourceType: AutoSourceType, sourceId: string, part: number, observedHash: string): Promise<FrozenSource | null> {
    if (sourceType === 'material') {
      const material = await tx.material.findUnique({ where: { id: sourceId } });
      if (!material || material.archivedAt || material.topicId !== topicId) return null;
      const prepared = await this.prepareMaterial(tx, material);
      const item = prepared.find((entry) => entry.part === part);
      if (!item || item.observedHash !== observedHash) return null;
      return frozenFrom(material.id, 'material', item, scopeKey(material.topicId));
    }
    const task = await tx.task.findUnique({ where: { id: sourceId } });
    if (!task || task.deletedAt || task.topicId !== topicId) return null;
    const prepared = prepareTask(task);
    const item = prepared.find((entry) => entry.part === part);
    if (!item || item.observedHash !== observedHash) return null;
    return frozenFrom(task.id, 'task', item, scopeKey(task.topicId));
  }

  private async freezeMemories(tx: Db, topicId: string | null) {
    const where = { topicId, status: 'active' as const };
    const total = await tx.memory.count({ where });
    const rows = await tx.memory.findMany({ where, orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }], take: MEMORY_CONTEXT_LIMIT });
    return {
      total,
      items: rows.map((memory) => {
        const clipped = clipCodePoints(memory.content, MEMORY_EXCERPT_CHARS);
        return { id: memory.id, revision: memory.revision, kind: memory.kind, title: memory.title, content: clipped.text, truncated: clipped.truncated, importance: memory.importance, labels: readLabels(memory.labels), status: memory.status };
      }),
    };
  }

  private async activeMemories(topicId: string | null): Promise<FrozenMemory[]> {
    const rows = await prisma.memory.findMany({ where: { topicId, status: 'active' }, orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }] });
    return rows.map((memory) => ({ id: memory.id, revision: memory.revision, kind: memory.kind, title: memory.title, content: memory.content, truncated: false, importance: memory.importance, labels: readLabels(memory.labels), status: memory.status }));
  }

  private async assertLease(tx: Db, jobId: string, token: string) {
    const job = await tx.autoMemoryJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'running' || job.leaseToken !== token || (job.leaseExpiresAt && job.leaseExpiresAt <= this.iso())) throw new DomainError('AUTO_MEMORY_CANCELLED', '自动提炼已取消', 409);
    const scope = await tx.autoMemoryScope.findUnique({ where: { id: job.scopeKey } });
    if (!scope?.enabled) throw new DomainError('AUTO_MEMORY_CANCELLED', '自动提炼已暂停', 409);
    if (scope.topicId) {
      const topic = await tx.topic.findUnique({ where: { id: scope.topicId }, select: { archivedAt: true } });
      if (topic?.archivedAt) throw new DomainError('TOPIC_ARCHIVED', '已归档，暂停提炼', 409);
    }
  }

  private async lost(jobId: string, token: string) {
    const job = await prisma.autoMemoryJob.findUnique({ where: { id: jobId } });
    return !job || job.status !== 'running' || job.leaseToken !== token || Boolean(job.leaseExpiresAt && job.leaseExpiresAt <= this.iso());
  }

  private async nextAttempt(key: string, inputHash: string) {
    return ((await prisma.autoMemoryJob.findFirst({ where: { scopeKey: key, inputHash }, orderBy: { attempt: 'desc' } }))?.attempt ?? 0) + 1;
  }

  private async countPendingProposals(key: string) {
    const links = await prisma.memorySuggestionKey.findMany({ where: { scopeKey: key }, select: { proposalId: true } });
    const ids = [...new Set(links.map((link) => link.proposalId))];
    if (!ids.length) return 0;
    return prisma.proposal.count({ where: { id: { in: ids }, status: 'pending' } });
  }

  private async requireTopic(topicId: string | null) {
    if (topicId === null) return null;
    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) throw new DomainError('NOT_FOUND', '清单不存在', 404);
    return topic;
  }

  private async ensureScope(tx: Db, topicId: string | null): Promise<ScopeRow> {
    const id = scopeKey(topicId);
    const existing = await tx.autoMemoryScope.findUnique({ where: { id } });
    if (existing) return existing;
    const now = this.iso();
    try {
      return await tx.autoMemoryScope.create({ data: { id, topicId, enabled: true, revision: 1, createdAt: now, updatedAt: now } });
    } catch (error) {
      if (!isUnique(error)) throw error;
      return tx.autoMemoryScope.findUniqueOrThrow({ where: { id } });
    }
  }

  private async readReceipt(actorId: string, requestId: string, requestHash: string) {
    const receipt = await prisma.requestReceipt.findUnique({ where: { actorId_requestId: { actorId, requestId } } });
    if (!receipt) return null;
    if (receipt.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', '相同请求标识不能提交不同内容', 409);
    return JSON.parse(receipt.response).result as unknown;
  }

  private async writeReceipt(actorId: string, requestId: string, requestHash: string, result: unknown) {
    await prisma.requestReceipt.create({ data: { actorId, requestId, requestHash, response: JSON.stringify({ result }), createdAt: this.iso() } }).catch((error: unknown) => {
      if (!isUnique(error)) throw error;
    });
    return result;
  }
}

function isAutoSourceType(value: string): value is AutoSourceType {
  return value === 'material' || value === 'task';
}

function isUnique(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'P2002');
}

function splitSource(body: string, revision: number, evidenceHash: string, extractionHash: string | null, title: string): Prepared[] {
  const whole = sha256(body);
  const segments = splitCodePoints(body, SOURCE_PART_CHARS);
  return segments.map((text, part) => ({ part, partCount: segments.length, text, observedHash: sha256(canonical([whole, part, text])), pendingReason: null, revision, evidenceHash, extractionHash, title }));
}

function pendingPart(revision: number, evidenceHash: string, extractionHash: string | null, title: string, reason: string): Prepared {
  const whole = sha256(`pending:${reason}`);
  return { part: 0, partCount: 1, text: '', observedHash: sha256(canonical([whole, 0, ''])), pendingReason: reason, revision, evidenceHash, extractionHash, title };
}

function prepareTask(task: { title: string; description: string | null; status: string; resultSummary: string | null; dueDate: string | null; revision: number }): Prepared[] {
  const title = task.title ?? '';
  const description = task.description ?? '';
  const resultSummary = task.resultSummary ?? '';
  const body = canonical({ title, description, status: task.status, resultSummary });
  const evidenceHash = knowledgeHash(JSON.stringify({ title, description, status: task.status, dueDate: task.dueDate, resultSummary }));
  return splitSource(body, task.revision, evidenceHash, null, title);
}

function frozenFrom(sourceId: string, sourceType: AutoSourceType, item: Prepared, key: string): FrozenSource {
  return { rowId: autoSourceRowId(key, sourceType, sourceId, item.part), sourceType, sourceId, part: item.part, partCount: item.partCount, revision: item.revision, evidenceHash: item.evidenceHash, extractionHash: item.extractionHash, observedHash: item.observedHash, title: item.title, text: item.text, pendingReason: item.pendingReason };
}

function commandFor(candidate: AutoMemoryCandidate, topicId: string | null): Command {
  if (candidate.action === 'create') {
    return { kind: 'memory.create', input: { topicId, kind: candidate.kind, title: candidate.title, content: candidate.content, evidence: candidate.evidence, reason: candidate.reason, importance: candidate.importance, labels: candidate.labels, origin: 'ai' } };
  }
  return {
    kind: candidate.action === 'retire' ? 'memory.retire' : 'memory.update',
    targetId: candidate.targetId ?? undefined,
    expectedRevision: candidate.expectedRevision ?? undefined,
    input: { kind: candidate.kind, title: candidate.title, content: candidate.content, evidence: candidate.evidence, reason: candidate.reason, importance: candidate.importance, labels: candidate.labels, origin: 'ai', ...(candidate.action === 'retire' ? { status: 'retired' as const } : {}) },
  };
}

function candidateAllowed(candidate: AutoMemoryCandidate, snapshot: FrozenSnapshot) {
  if (candidate.action === 'create') return candidate.targetId === null && candidate.expectedRevision === null && candidateEvidenceAllowed(candidate, snapshot.sources);
  const memory = snapshot.memories.find((item) => item.id === candidate.targetId);
  return Boolean(memory && memory.revision === candidate.expectedRevision && candidateEvidenceAllowed(candidate, snapshot.sources));
}

function parseOutput(text: string) {
  try { return requireOutput(text); } catch { return null; }
}

function requireOutput(text: string): AutoMemoryOutput {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new DomainError('INVALID_MODEL_OUTPUT', '模型输出无法采用', 502); }
  const parsed = autoMemoryOutputSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('INVALID_MODEL_OUTPUT', '模型输出无法采用', 502);
  return parsed.data;
}

function autoActor(jobId: string, topicId: string | null): Actor {
  return { id: `auto-memory:${jobId}`, kind: 'internal', topicIds: topicId === null ? [] : [topicId], includeInbox: topicId === null, autoActions: [], revision: 1 };
}

function jobView(job: { id: string; status: string; errorCode?: string | null; errorMessage?: string | null }) {
  return { id: job.id, status: job.status, errorCode: job.errorCode ?? null, errorMessage: job.errorMessage ?? null };
}

export async function clearAutoMemory(db: PrismaClient) {
  await db.memorySuggestionKey.deleteMany();
  await db.autoMemoryJob.deleteMany();
  await db.autoMemorySource.deleteMany();
  await db.autoMemoryTurn.deleteMany();
  await db.autoMemoryScope.deleteMany();
}

let shared: AutoMemoryService | undefined;
export function sharedAutoMemoryService() {
  shared ??= new AutoMemoryService({
    now: () => new Date(),
    model: { async complete(messages, signal) { const result = await new ModelAdapter().complete(messages, signal, false); return { text: result.text }; } },
    hasModelConfig: async () => Boolean(await new SettingsService().credentials()),
  });
  return shared;
}

export function startAutoMemoryScheduler(service = sharedAutoMemoryService(), intervalMs = SCAN_INTERVAL_MS) {
  let busy = false;
  let stopped = false;
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    try { await service.tick(); } catch (error) { console.error('Auto memory:', error instanceof Error ? error.message : error); }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  void run();
  return () => { stopped = true; clearInterval(timer); };
}


