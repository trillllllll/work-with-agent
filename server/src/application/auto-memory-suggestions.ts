import type { Prisma, PrismaClient } from '@prisma/client';
import { DomainError } from '../domain/task.js';
import { canonical, type Command } from './commands.js';
import { evidenceSchema, readEvidence, readLabels, type EvidenceRef } from './knowledge.js';
import {
  normalizeMemoryText,
  scopeKey,
  sha256,
  sortEvidence,
  sortLabels,
  type AutoMemoryCandidate,
  type FrozenMemory,
  type FrozenSource,
} from './auto-memory-types.js';

type Db = Prisma.TransactionClient | PrismaClient;

export type SuggestionIdentity = {
  scopeKey: string;
  action: 'create' | 'update' | 'retire';
  targetId: string | null;
  expectedRevision: number | null;
  kind: string;
  title: string;
  content: string;
  importance: number;
  labels: string[];
  evidence: EvidenceRef[];
};

export function suggestionKey(identity: SuggestionIdentity) {
  return sha256(canonical({
    scopeKey: identity.scopeKey,
    action: identity.action,
    targetId: identity.targetId,
    expectedRevision: identity.expectedRevision,
    kind: identity.kind,
    title: normalizeMemoryText(identity.title),
    content: normalizeMemoryText(identity.content),
    importance: identity.importance,
    labels: sortLabels(identity.labels.map((label) => label.trim()).filter(Boolean)),
    evidence: sortEvidence(identity.evidence).map((ref) => ({ type: ref.type, id: ref.id, revision: ref.revision, ...(ref.hash ? { hash: ref.hash } : {}) })),
  }));
}

function actionOf(kind: string): SuggestionIdentity['action'] | null {
  if (kind === 'memory.create') return 'create';
  if (kind === 'memory.update') return 'update';
  if (kind === 'memory.retire') return 'retire';
  return null;
}

export function identityFromCommand(command: Command, key: string): SuggestionIdentity | null {
  const action = actionOf(command.kind);
  if (!action) return null;
  const input = command.input;
  const evidence = zEvidence(input.evidence);
  const labels = Array.isArray(input.labels) ? input.labels.filter((item): item is string => typeof item === 'string') : [];
  const importance = typeof input.importance === 'number' ? input.importance : 3;
  return {
    scopeKey: key,
    action,
    targetId: action === 'create' ? null : command.targetId ?? null,
    expectedRevision: action === 'create' ? null : command.expectedRevision ?? null,
    kind: typeof input.kind === 'string' ? input.kind : 'fact',
    title: typeof input.title === 'string' ? input.title : '',
    content: typeof input.content === 'string' ? input.content : '',
    importance,
    labels,
    evidence,
  };
}

function zEvidence(value: unknown): EvidenceRef[] {
  const parsed = evidenceSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function memoryTopicId(command: Command): string | null | undefined {
  if (command.kind === 'memory.create') {
    const topicId = command.input.topicId;
    if (topicId === null || typeof topicId === 'string') return topicId;
    return undefined;
  }
  return undefined;
}

export function assertSingleMemoryScope(commands: Command[], topicId: string | null) {
  for (const command of commands) {
    if (!command.kind.startsWith('memory.')) continue;
    if (command.kind === 'memory.create' && command.input.topicId !== undefined && command.input.topicId !== topicId) {
      throw new DomainError('CANDIDATE_OUT_OF_SCOPE', '一条记忆提议只能属于一个清单', 400);
    }
  }
}

export function sameWrittenFields(candidate: AutoMemoryCandidate, memory: FrozenMemory) {
  const labels = sortLabels(candidate.labels);
  const current = sortLabels(memory.labels);
  return candidate.kind === memory.kind
    && candidate.title === memory.title
    && candidate.content === memory.content
    && candidate.importance === memory.importance
    && labels.length === current.length
    && labels.every((label, index) => label === current[index]);
}

export function matchesActiveMemory(candidate: AutoMemoryCandidate, memories: FrozenMemory[]) {
  const title = normalizeMemoryText(candidate.title);
  const content = normalizeMemoryText(candidate.content);
  return memories.some((memory) => memory.status === 'active' && memory.kind === candidate.kind && normalizeMemoryText(memory.title) === title && normalizeMemoryText(memory.content) === content);
}

export function candidateEvidenceAllowed(candidate: AutoMemoryCandidate, sources: FrozenSource[]) {
  const provided = new Map(sources.filter((source) => !source.pendingReason).map((source) => [`${source.sourceType}:${source.sourceId}`, source]));
  if (!candidate.evidence.length) return false;
  let citesChange = false;
  for (const ref of candidate.evidence) {
    if (ref.type === 'memory') continue;
    const source = provided.get(`${ref.type}:${ref.id}`);
    if (!source || source.revision !== ref.revision || (ref.hash && ref.hash !== source.evidenceHash)) return false;
    citesChange = true;
  }
  return citesChange;
}

export async function lookupSuggestion(db: Db, key: string) {
  return db.memorySuggestionKey.findUnique({ where: { id: key } });
}

export async function rememberSuggestion(db: Db, key: string, scope: string, proposalId: string, createdAt: string) {
  const existing = await db.memorySuggestionKey.findUnique({ where: { id: key } });
  if (existing) return { proposalId: existing.proposalId, created: false };
  await db.memorySuggestionKey.create({ data: { id: key, scopeKey: scope, proposalId, createdAt } });
  return { proposalId, created: true };
}

/** Insert the dedup key in the same transaction as the proposal. A conflicting key rolls the proposal back. */
export async function insertSuggestion(db: Db, key: string, scope: string, proposalId: string, createdAt: string) {
  const existing = await db.memorySuggestionKey.findUnique({ where: { id: key } });
  if (existing) {
    if (existing.proposalId === proposalId) return existing;
    throw new DomainError('SUGGESTION_EXISTS', '相同建议已经存在', 409);
  }
  return db.memorySuggestionKey.create({ data: { id: key, scopeKey: scope, proposalId, createdAt } });
}

export function memorySuggestionHooks(topicId: string | null, createdAt: string) {
  const key = scopeKey(topicId);
  return {
    beforePersist: async (tx: Db, commands: Command[]) => {
      await assertMemoryCommandsScope(tx, commands, topicId);
      const memoryCommands = commands.filter((command) => command.kind.startsWith('memory.'));
      if (!memoryCommands.length || memoryCommands.length !== commands.length) return;
      const proposalIds: string[] = [];
      for (const command of memoryCommands) {
        const identity = identityFromCommand(command, key);
        if (!identity?.title || !identity.content || !identity.evidence.length) return;
        const existing = await lookupSuggestion(tx, suggestionKey(identity));
        if (!existing) return;
        proposalIds.push(existing.proposalId);
      }
      if (new Set(proposalIds).size === 1) return { reuseProposalId: proposalIds[0] };
    },
    afterProposal: async (tx: Db, proposalId: string, commands: Command[]) => {
      for (const command of commands) {
        if (!command.kind.startsWith('memory.')) continue;
        const identity = identityFromCommand(command, key);
        if (!identity?.title || !identity.content || !identity.evidence.length) continue;
        await insertSuggestion(tx, suggestionKey(identity), key, proposalId, createdAt);
      }
    },
  };
}

async function assertMemoryCommandsScope(tx: Db, commands: Command[], topicId: string | null) {
  for (const command of commands) {
    if (!command.kind.startsWith('memory.')) continue;
    if (command.kind === 'memory.create') {
      if (command.input.topicId !== undefined && command.input.topicId !== topicId) {
        throw new DomainError('CANDIDATE_OUT_OF_SCOPE', '一条记忆提议只能属于一个清单', 400);
      }
    } else if (command.targetId) {
      const memory = await tx.memory.findUnique({ where: { id: command.targetId }, select: { topicId: true } });
      if (memory && memory.topicId !== topicId) throw new DomainError('CANDIDATE_OUT_OF_SCOPE', '一条记忆提议只能属于一个清单', 400);
    }
  }
}

export async function backfillSuggestionKeys(db: Db, createdAt: string) {
  const pending = await db.proposal.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' } });
  for (const proposal of pending) {
    const commands = readCommands(proposal.commands);
    const topicIds = new Set<string | null>();
    for (const command of commands) {
      if (!command.kind.startsWith('memory.')) continue;
      const topicId = command.kind === 'memory.create'
        ? (command.input.topicId === null || typeof command.input.topicId === 'string' ? command.input.topicId : undefined)
        : await topicOfTarget(db, command.targetId);
      if (topicId === undefined) continue;
      topicIds.add(topicId);
    }
    if (topicIds.size > 1) continue;
    const key = topicIds.size === 1 ? scopeKey([...topicIds][0]) : null;
    if (!key) continue;
    for (const command of commands) {
      const identity = identityFromCommand(command, key);
      if (!identity || !identity.title || !identity.content || !identity.evidence.length) continue;
      const id = suggestionKey(identity);
      const existing = await db.memorySuggestionKey.findUnique({ where: { id } });
      if (!existing) await db.memorySuggestionKey.create({ data: { id, scopeKey: key, proposalId: proposal.id, createdAt } });
    }
  }
}

async function topicOfTarget(db: Db, targetId: string | undefined) {
  if (!targetId) return undefined;
  const memory = await db.memory.findUnique({ where: { id: targetId }, select: { topicId: true } });
  return memory ? memory.topicId : undefined;
}

function readCommands(value: string): Command[] {
  try {
    const parsed = JSON.parse(value) as Command[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function activeMemoriesMatchContent(memories: Array<{ kind: string; title: string; content: string; status: string }>, kind: string, title: string, content: string) {
  const normalizedTitle = normalizeMemoryText(title);
  const normalizedContent = normalizeMemoryText(content);
  return memories.some((memory) => memory.status === 'active' && memory.kind === kind && normalizeMemoryText(memory.title) === normalizedTitle && normalizeMemoryText(memory.content) === normalizedContent);
}

export { readEvidence, readLabels };
