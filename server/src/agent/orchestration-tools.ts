/**
 * Assistant tools for orchestration. Read-only views of rounds, nodes and the worktrees a node last reported, plus
 * one cleanup tool that only creates a pending confirmation card (WorktreeCleanup, source "assistant"). The assistant
 * never dispatches node jobs: nothing reaches a node until the user confirms the card in the chat or on #/worktrees.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { dispatchStats } from '../application/orchestration/stats.js';
import { weekRange } from '../application/orchestration/week-range.js';
import { redact } from '../infrastructure/controlled-execution.js';
import type { Clock } from './time.js';

const MAX_ROUNDS = 20;

export const orchestrationReadInput = z.object({
  action: z.enum(['attention', 'list', 'get', 'nodes', 'worktrees']),
  taskId: z.string().min(1).optional(),
  orchestrationId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
}).strict();

export const orchestrationStatsInput = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  projectId: z.string().min(1).optional(),
  timeZone: z.string().min(1).optional(),
}).strict();

const STATS_NOTE = '数字来自服务端聚合，回答时照实引用，不要改写；画图用 present_reply，数据取本结果；没有费用数据的步骤要说明费用未知。';

/** Same zone order as get_time: argument, then a non-default request zone, else Asia/Shanghai. */
export function resolveStatsTimeZone(args: { timeZone?: string }, context: { timeZone?: string; timeZoneSource?: 'context' | 'default' }) {
  if (args.timeZone) return args.timeZone;
  if (context.timeZone && context.timeZoneSource !== 'default') return context.timeZone;
  return 'Asia/Shanghai';
}

export async function statsForAssistant(raw: Record<string, unknown>, context: { timeZone?: string; timeZoneSource?: 'context' | 'default' }, clock: Clock = { now: () => new Date() }) {
  const args = orchestrationStatsInput.parse(raw);
  const timeZone = resolveStatsTimeZone(args, context);
  const range = weekRange(clock.now(), timeZone, 0);
  let from = args.from;
  let to = args.to;
  if (!from && !to) { from = range.from; to = range.to; }
  else if (!from || !to) throw new DomainError('INVALID_STATS_RANGE', '统计需要同时提供开始和结束时间', 400);
  const stats = await dispatchStats({ from, to, projectId: args.projectId });
  return { ...stats, timeZone, note: STATS_NOTE };
}

/** Aggregate token counts are the answer. The shared redactor treats any key containing "token" as a credential. */
const statsCountKeys = new Set(['inputTokens', 'cachedInputTokens', 'outputTokens']);
export function redactStats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactStats(item));
  if (!value || typeof value !== 'object') return redact(value);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, statsCountKeys.has(key) ? item : redactStats(item)]));
}

export const worktreeCleanupInput = z.object({
  nodeId: z.string().min(1),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(50),
  deleteBranches: z.boolean().optional(),
  reason: z.string().max(500).optional(),
}).strict();

export type WorktreeCleanupPart = {
  schemaVersion: 1;
  type: 'worktree_cleanup';
  id: string;
  cleanupId: string;
  nodeName: string;
  removableCount: number;
  blockedCount: number;
  reason: string;
};

function parse<T>(raw: string | null | undefined, fallback: T): T {
  try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

async function roundSummary(id: string, withSteps: boolean) {
  const row = await prisma.orchestration.findUnique({ where: { id }, include: withSteps ? { steps: { orderBy: { position: 'asc' } } } : undefined });
  if (!row) throw new DomainError('NOT_FOUND', '编排不存在', 404);
  const steps = 'steps' in row ? row.steps as Array<{ id: string; kind: string; status: string; subtaskId: string | null; branch: string | null; nodeId: string | null; resultCommit: string | null; mergeCommit: string | null; attempt: number; feedback: string | null }> : [];
  return {
    id: row.id, taskId: row.taskId, round: row.round, status: row.status, pauseReason: row.pauseReason,
    integrationBranch: row.integrationBranch, integrationHead: row.integrationHead, nodeId: row.nodeId,
    extraLocations: parse<unknown[]>(row.extraLocationsJson, []).length,
    startedAt: row.startedAt, endedAt: row.endedAt, acceptedAt: row.acceptedAt, pushedAt: row.pushedAt, pullRequestUrl: row.pullRequestUrl,
    finalComment: row.finalComment,
    ...(withSteps ? { steps: steps.map((step) => ({ id: step.id, kind: step.kind, status: step.status, subtaskId: step.subtaskId, branch: step.branch, nodeId: step.nodeId, attempt: step.attempt, resultCommit: step.resultCommit, mergeCommit: step.mergeCommit, feedback: step.feedback ? [...step.feedback].slice(0, 400).join('') : null })) } : {}),
  };
}

export async function readOrchestration(raw: Record<string, unknown>) {
  const input = orchestrationReadInput.parse(raw);
  if (input.action === 'attention') {
    const rows = await prisma.orchestration.findMany({ where: { status: { in: ['awaiting_acceptance', 'paused', 'running'] } }, orderBy: { updatedAt: 'desc' }, take: MAX_ROUNDS, select: { id: true, taskId: true, round: true, status: true, pauseReason: true, updatedAt: true } });
    return { items: rows, note: 'running 正在执行；paused 需要用户处理；awaiting_acceptance 等用户在任务里验收。' };
  }
  if (input.action === 'list') {
    if (!input.taskId) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'list 需要 taskId', 400);
    const rows = await prisma.orchestration.findMany({ where: { taskId: input.taskId }, orderBy: { createdAt: 'desc' }, take: MAX_ROUNDS, select: { id: true } });
    return { items: await Promise.all(rows.map((row) => roundSummary(row.id, false))) };
  }
  if (input.action === 'get') {
    if (!input.orchestrationId) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'get 需要 orchestrationId', 400);
    return roundSummary(input.orchestrationId, true);
  }
  if (input.action === 'nodes') {
    const { isOnline } = await import('../application/orchestration/nodes.js');
    const rows = await prisma.agentNode.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } });
    return { items: rows.map((node) => ({ id: node.id, name: node.name, online: isOnline(node), platform: node.platform, version: node.version, capabilities: parse<Record<string, unknown>>(node.capabilitiesJson, {}), inventoryAt: node.inventoryAt })) };
  }
  const { WorktreeService } = await import('../application/orchestration/worktrees.js');
  const overview = await new WorktreeService().overview();
  const views = input.nodeId ? overview.filter((view) => view.node.id === input.nodeId) : overview;
  return {
    items: views.map((view) => ({
      node: view.node, inventoryAt: view.inventoryAt, freeBytes: view.freeBytes, runs: view.runs, refreshing: view.refreshing,
      worktrees: view.worktrees.map((entry) => ({ path: entry.path, name: entry.name, branch: entry.branch, dirtyCount: entry.dirtyCount, sizeBytes: entry.sizeBytes, broken: entry.broken, modifiedAt: entry.modifiedAt, usage: entry.usage, action: entry.action, reason: entry.reason, warning: entry.warning })),
      pendingCards: view.pendingCards.map((card) => ({ id: card.id, status: card.status, source: card.source, removableCount: card.removableCount })),
    })),
    note: '列表是执行端最近一次上报的结果（inventoryAt），助手不能刷新。需要最新数据时请用户在「Worktree 管理」页点刷新。',
  };
}

/** Creates the pending card and the chat part that renders it. Does not contact the node. */
export async function proposeWorktreeCleanup(raw: Record<string, unknown>, messageId: string, toolCallId: string) {
  const input = worktreeCleanupInput.parse(raw);
  const { WorktreeService } = await import('../application/orchestration/worktrees.js');
  const card = await new WorktreeService().previewCleanup({ nodeId: input.nodeId, paths: input.paths, deleteBranches: input.deleteBranches ?? false }, 'assistant');
  const part: WorktreeCleanupPart = {
    schemaVersion: 1,
    type: 'worktree_cleanup',
    id: createHash('sha256').update(`${messageId}:${toolCallId}`).digest('hex').slice(0, 32),
    cleanupId: card.id,
    nodeName: card.nodeName,
    removableCount: card.removableCount,
    blockedCount: card.items.length - card.removableCount,
    reason: input.reason ?? '',
  };
  const row = await prisma.message.findUnique({ where: { id: messageId }, select: { partsJson: true } });
  const parts = parse<unknown[]>(row?.partsJson, []);
  if (!parts.some((item) => item && typeof item === 'object' && (item as { id?: string }).id === part.id)) parts.push(part);
  await prisma.message.update({ where: { id: messageId }, data: { partsJson: JSON.stringify(parts) } });
  return {
    data: {
      status: 'pending_user_confirmation', cleanupId: card.id, expiresAt: card.expiresAt, removableCount: card.removableCount,
      items: card.items.map((item) => ({ path: item.path, action: item.action, reason: item.reason, warning: item.warning })),
      note: '只生成了待确认卡片，还没有删除任何东西。用户在卡片上确认后才由执行端删除；卡片 10 分钟后过期。',
    },
    part,
  };
}
