/**
 * Repeated orchestration failures become pending memory and skill proposals.
 * Nothing is written until a person approves. This module never runs git or reads a worktree.
 */
import { prisma } from '../../infrastructure/prisma.js';
import { DomainError } from '../../domain/task.js';
import { CommandService, type Command } from '../commands.js';
import { identityFromCommand, lookupSuggestion, memorySuggestionHooks, suggestionKey } from '../auto-memory-suggestions.js';
import { scopeKey, sha256 } from '../auto-memory-types.js';
import { internalActor, ownerActor } from '../security.js';
import { appendOrchestrationEvent } from './events.js';

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const THRESHOLD = 3;

export const LEARNING_PAUSE_REASONS = new Set([
  'git_write_denied',
  'merge_conflict_unresolved',
  'merge_tests_failed',
  'merge_unverified',
  'develop_failed',
  'final_unsatisfied',
]);

const PAUSE_LABELS: Record<string, string> = {
  git_write_denied: '无法写 git',
  merge_conflict_unresolved: '合入冲突未解决',
  merge_tests_failed: '合入测试失败',
  merge_unverified: '合入未能核对',
  develop_failed: '开发未通过',
  final_unsatisfied: '最终验收未满足',
};

export type LearningSignal = { kind: 'pause'; reason: string } | { kind: 'reject'; reason: string };

export function normalizeRejectReason(reason: string) {
  const collapsed = reason.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
  return Array.from(collapsed).slice(0, 80).join('');
}

function clipText(value: string, max: number) {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function detailText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('；');
  if (value == null) return '';
  return JSON.stringify(value);
}

function signalKey(signal: LearningSignal): string | null {
  if (signal.kind === 'pause') return LEARNING_PAUSE_REASONS.has(signal.reason) ? `pause:${signal.reason}` : null;
  const reason = normalizeRejectReason(signal.reason);
  return reason ? `reject:${reason}` : null;
}

function matches(payload: string, signal: LearningSignal, key: string) {
  const body = parsePayload(payload);
  if (signal.kind === 'pause') return body?.reason === signal.reason;
  return typeof body?.reason === 'string' && `reject:${normalizeRejectReason(body.reason)}` === key;
}

function proposalIdFrom(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as { result?: { proposalId?: string } };
    return typeof saved.result?.proposalId === 'string' ? saved.result.proposalId : null;
  } catch { return null; }
}

function slugPart(value: string) {
  const ascii = value.normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  return ascii.length >= 3 ? ascii : 'item';
}

function skillText(label: string) {
  const description = clipText(`派发前检查：反复出现「${label}」时先核对条件再派发。`, 1024);
  const instructions = [
    `当项目反复出现「${label}」时，下次派发前先检查：`,
    '1. 仓库可写，没有 index.lock，工作区干净。',
    '2. 合入冲突已解决，没有残留冲突标记。',
    '3. 相关测试能在本机运行并通过。',
    '4. 核对结果与合入报告一致后再继续。',
    '5. 条件不满足就先处理，不要直接派发。',
  ].join('\n');
  return { description, instructions };
}

async function suggest(orchestrationId: string, signal: LearningSignal) {
  const key = signalKey(signal);
  if (!key) return;
  const row = await prisma.orchestration.findUnique({ where: { id: orchestrationId } });
  if (!row) return;
  const task = await prisma.task.findUnique({ where: { id: row.taskId } });
  if (!task || task.deletedAt) return;
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const ids = (await prisma.orchestration.findMany({ where: { projectId: row.projectId }, select: { id: true } })).map((item) => item.id);
  const events = await prisma.orchestrationEvent.findMany({
    where: { orchestrationId: { in: ids }, createdAt: { gte: since }, type: signal.kind === 'pause' ? 'paused' : 'rejected' },
    orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
  });
  const matched = events.filter((event) => matches(event.payload, signal, key));
  if (matched.length < THRESHOLD) return;
  const project = await prisma.project.findUnique({ where: { id: row.projectId }, select: { name: true } });
  const projectName = project?.name || row.projectId;
  const label = signal.kind === 'pause' ? (PAUSE_LABELS[signal.reason] ?? signal.reason) : key.slice('reject:'.length);
  const latest = parsePayload(matched[0]?.payload ?? '{}');
  const detail = clipText(signal.kind === 'reject' ? (typeof latest?.reason === 'string' ? latest.reason : signal.reason) : detailText(latest?.detail), 300);
  const title = clipText(`派发经验：${projectName} 反复出现「${label}」`, 300);
  const content = `项目「${projectName}」最近 30 天内有 ${matched.length} 轮派发出现「${label}」。最近一次：${task.title}（${detail}）。下次派发前先检查相关条件。`;
  const memoryReason = clipText(`编排学习：${label}`, 1000);
  const keyHash = sha256(key);
  const createdAt = new Date().toISOString();
  const memoryRequestId = `orch-learning:${row.projectId}:${keyHash}`;
  const skillRequestId = `orch-learning-skill:${row.projectId}:${keyHash}`;
  const command: Command = {
    kind: 'memory.create',
    input: {
      topicId: task.topicId,
      kind: 'learning',
      title,
      content,
      evidence: [{ type: 'task', id: task.id, revision: task.revision }],
      importance: 3,
      labels: ['orchestration'],
      reason: memoryReason,
      origin: 'ai',
    },
  };
  let memoryProposalId: string | null = null;
  let skillProposalId: string | null = null;
  let createdMemory = false;
  let createdSkill = false;
  const memoryReceipt = await prisma.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: internalActor.id, requestId: memoryRequestId } } });
  if (memoryReceipt) memoryProposalId = proposalIdFrom(memoryReceipt.response);
  else {
    const identity = identityFromCommand(command, scopeKey(task.topicId));
    const existing = identity?.title && identity.content && identity.evidence.length ? await lookupSuggestion(prisma, suggestionKey(identity)) : null;
    if (existing) memoryProposalId = existing.proposalId;
    else {
      const hooks = memorySuggestionHooks(task.topicId, createdAt);
      const response = await new CommandService().submit(internalActor, { requestId: memoryRequestId, commands: [command] }, { forceProposal: true, beforePersist: hooks.beforePersist, afterProposal: hooks.afterProposal });
      memoryProposalId = typeof response.proposalId === 'string' ? response.proposalId : null;
      createdMemory = true;
    }
  }
  const skillName = `dispatch-checklist-${slugPart(signal.kind === 'pause' ? signal.reason : label)}-${keyHash.slice(0, 8)}`;
  const skillReceipt = await prisma.requestReceipt.findUnique({ where: { actorId_requestId: { actorId: ownerActor.id, requestId: skillRequestId } } });
  if (skillReceipt) skillProposalId = proposalIdFrom(skillReceipt.response);
  else {
    const taken = await prisma.skill.findFirst({ where: { name: skillName, deletedAt: null }, select: { id: true } });
    if (!taken) {
      const text = skillText(label);
      const skill: Command = { kind: 'skill.create', input: { name: skillName, description: text.description, instructions: text.instructions, reason: memoryReason } };
      const response = await new CommandService().submit(ownerActor, { requestId: skillRequestId, commands: [skill] }, { forceProposal: true });
      skillProposalId = typeof response.proposalId === 'string' ? response.proposalId : null;
      createdSkill = true;
    }
  }
  if (!createdMemory && !createdSkill) return;
  await prisma.$transaction((tx) => appendOrchestrationEvent(tx, orchestrationId, 'learning_suggested', 'server', null, {
    memoryProposalId, skillProposalId, key, count: matched.length,
  }));
}

/** Fire-and-forget from the caller's point of view: failures are recorded and never thrown. */
export async function recordLearningSignal(orchestrationId: string, signal: LearningSignal): Promise<void> {
  try {
    await suggest(orchestrationId, signal);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'SOURCE_STALE') return;
    try {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.$transaction((tx) => appendOrchestrationEvent(tx, orchestrationId, 'learning_suggestion_failed', 'server', null, { error: message.slice(0, 500) }));
    } catch { /* the round must keep moving even when the audit row cannot be written */ }
  }
}
