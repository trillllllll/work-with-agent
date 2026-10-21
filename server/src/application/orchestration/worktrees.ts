/**
 * Worktree management. The server only shows what a node reported and records the user's decision; listing and
 * removal are NodeJobs (`inventory`, `cleanup`) executed by that node. Deleting always goes through a confirmation
 * card (a pending WorktreeCleanup row): nothing reaches the node until the user confirms that exact card.
 */
import { z } from 'zod';
import type { NodeJob, WorktreeCleanup } from '@prisma/client';
import { prisma } from '../../infrastructure/prisma.js';
import { DomainError } from '../../domain/task.js';
import { publishWorkspaceChange } from '../commands.js';
import { cleanupResultSchema, inventoryResultSchema, type InventoryResult, type WorktreeEntry } from '../../node-agent/protocol.js';
import { activeJobStatuses, enqueueJob, isOnline, now } from './nodes.js';

const CARD_TTL_MS = 10 * 60_000;
const BLOCKING = ['draft', 'running', 'paused', 'awaiting_acceptance'];
type Usage = { orchestrationId: string; taskId: string; status: string; role: 'integration' | 'subtask'; pushed: boolean };
export type CleanupItem = { path: string; name: string; branch: string | null; dirtyCount: number; sizeBytes: number; usage: Usage | null; action: 'remove' | 'blocked'; reason: string | null; warning: string | null };

async function usageByPath(nodeId?: string) {
  const rows = await prisma.orchestration.findMany({ where: { status: { in: [...BLOCKING, 'accepted', 'cancelled', 'superseded'] } }, include: { steps: { select: { workPath: true, nodeId: true } } } });
  const map = new Map<string, Usage>();
  for (const row of rows) {
    const add = (path: string | null, role: Usage['role'], stepNode: string | null) => {
      if (!path) return;
      const owner = stepNode ?? row.nodeId;
      if (nodeId && owner !== nodeId) return;
      const prior = map.get(path);
      // An open round wins over a finished one that happens to share the path.
      if (prior && BLOCKING.includes(prior.status)) return;
      map.set(path, { orchestrationId: row.id, taskId: row.taskId, status: row.status, role, pushed: !!row.pushedAt });
    };
    add(row.integrationPath, 'integration', null);
    for (const step of row.steps) if (step.workPath !== row.integrationPath) add(step.workPath, 'subtask', step.nodeId);
  }
  return map;
}

function classify(entry: WorktreeEntry, usage: Usage | null): Pick<CleanupItem, 'action' | 'reason' | 'warning'> {
  if (usage && BLOCKING.includes(usage.status)) return { action: 'blocked', reason: '正被未结束的编排使用', warning: null };
  if (entry.dirtyCount > 0) return { action: 'blocked', reason: `有 ${entry.dirtyCount} 个未提交或未跟踪的文件`, warning: null };
  const warning = usage?.role === 'integration' && usage.status === 'accepted' && !usage.pushed ? '集成分支还没推送；只删 worktree，分支只在已合入时才删' : entry.broken ? '目录已损坏或不是 worktree，只在为空时删除' : null;
  return { action: 'remove', reason: null, warning };
}

function cardDto(row: WorktreeCleanup, nodeName: string) {
  const items = JSON.parse(row.itemsJson) as CleanupItem[];
  const removable = items.filter((item) => item.action === 'remove');
  return { id: row.id, nodeId: row.nodeId, nodeName, status: row.status, source: row.source, deleteBranches: row.deleteBranches, expiresAt: row.expiresAt, createdAt: row.createdAt, jobId: row.jobId, items, removableCount: removable.length, removableBytes: removable.reduce((sum, item) => sum + item.sizeBytes, 0), result: row.resultJson ? JSON.parse(row.resultJson) : null };
}

export class WorktreeService {
  async overview() {
    const nodes = await prisma.agentNode.findMany({ where: { status: 'active', deletedAt: null }, orderBy: { createdAt: 'asc' } });
    const usage = await usageByPath();
    const [pendingJobs, cards] = await Promise.all([
      prisma.nodeJob.findMany({ where: { kind: { in: ['inventory', 'cleanup'] }, status: { in: activeJobStatuses } }, select: { nodeId: true, kind: true } }),
      prisma.worktreeCleanup.findMany({ where: { status: { in: ['pending', 'confirmed'] } }, orderBy: { createdAt: 'desc' } }),
    ]);
    return nodes.map((node) => {
      const inventory = JSON.parse(node.inventoryJson) as InventoryResult | null;
      return {
        node: { id: node.id, name: node.name, online: isOnline(node), platform: node.platform },
        inventoryAt: node.inventoryAt,
        refreshing: pendingJobs.some((job) => job.nodeId === node.id && job.kind === 'inventory'),
        cleaning: pendingJobs.some((job) => job.nodeId === node.id && job.kind === 'cleanup'),
        runs: inventory?.runs ?? null,
        freeBytes: inventory?.freeBytes ?? null,
        worktrees: (inventory?.worktrees ?? []).map((entry) => { const used = usage.get(entry.path) ?? null; return { ...entry, usage: used, ...classify(entry, used) }; }),
        pendingCards: cards.filter((card) => card.nodeId === node.id).map((card) => cardDto(card, node.name)),
      };
    });
  }

  async refresh(nodeId: string) {
    const node = await prisma.agentNode.findUnique({ where: { id: nodeId } });
    if (!node || node.status !== 'active' || node.deletedAt) throw new DomainError('NOT_FOUND', '电脑不存在或已断开', 404);
    const active = await prisma.nodeJob.findFirst({ where: { nodeId, kind: 'inventory', status: { in: activeJobStatuses } } });
    if (active) return { jobId: active.id, replay: true };
    const { job } = await prisma.$transaction((tx) => enqueueJob(tx, { nodeId, kind: 'inventory', dispatchKey: `inventory:${nodeId}:${Date.now()}`, payload: {} }));
    return { jobId: job.id, replay: false };
  }

  /** Builds the confirmation card. Nothing is sent to the node here. */
  async previewCleanup(raw: unknown, source: 'user' | 'assistant' = 'user') {
    const input = z.object({ nodeId: z.string().min(1), paths: z.array(z.string().min(1).max(4096)).min(1).max(200), deleteBranches: z.boolean().default(false) }).strict().parse(raw);
    const node = await prisma.agentNode.findUnique({ where: { id: input.nodeId } });
    if (!node || node.status !== 'active' || node.deletedAt) throw new DomainError('NOT_FOUND', '电脑不存在或已断开', 404);
    const inventory = JSON.parse(node.inventoryJson) as InventoryResult | null;
    if (!inventory) throw new DomainError('INVENTORY_REQUIRED', '先刷新该电脑的 worktree 列表', 409);
    const usage = await usageByPath(input.nodeId);
    const byPath = new Map(inventory.worktrees.map((entry) => [entry.path, entry]));
    const items: CleanupItem[] = [...new Set(input.paths)].map((path) => {
      const entry = byPath.get(path);
      if (!entry) return { path, name: path, branch: null, dirtyCount: 0, sizeBytes: 0, usage: null, action: 'blocked', reason: '不在这台电脑最近一次上报的列表里，请先刷新', warning: null };
      const used = usage.get(path) ?? null;
      return { path, name: entry.name, branch: entry.branch, dirtyCount: entry.dirtyCount, sizeBytes: entry.sizeBytes, usage: used, ...classify(entry, used) };
    });
    const row = await prisma.worktreeCleanup.create({ data: { nodeId: node.id, itemsJson: JSON.stringify(items), deleteBranches: input.deleteBranches, source, expiresAt: new Date(Date.now() + CARD_TTL_MS).toISOString(), createdAt: now(), updatedAt: now() } });
    return cardDto(row, node.name);
  }

  async getCleanup(id: string) {
    const row = await prisma.worktreeCleanup.findUnique({ where: { id } });
    if (!row) throw new DomainError('NOT_FOUND', '删除请求不存在', 404);
    const node = await prisma.agentNode.findUnique({ where: { id: row.nodeId } });
    return cardDto(row, node?.name ?? '');
  }

  /** The user confirmed this exact card: re-check usage, then hand only the still-removable paths to the node. */
  async confirmCleanup(id: string) {
    const row = await prisma.worktreeCleanup.findUnique({ where: { id } });
    if (!row) throw new DomainError('NOT_FOUND', '删除请求不存在', 404);
    if (row.status !== 'pending') throw new DomainError('CLEANUP_NOT_PENDING', '这张确认卡片已处理过', 409);
    if (Date.parse(row.expiresAt) < Date.now()) {
      await prisma.worktreeCleanup.updateMany({ where: { id, status: 'pending' }, data: { status: 'expired', updatedAt: now() } });
      throw new DomainError('CLEANUP_EXPIRED', '确认卡片已过期，请重新选择', 409);
    }
    const usage = await usageByPath(row.nodeId);
    const items = (JSON.parse(row.itemsJson) as CleanupItem[]).map((item) => {
      const used = usage.get(item.path) ?? null;
      if (item.action === 'remove' && used && BLOCKING.includes(used.status)) return { ...item, usage: used, action: 'blocked' as const, reason: '确认前已被编排占用' };
      return item;
    });
    const paths = items.filter((item) => item.action === 'remove').map((item) => item.path);
    if (!paths.length) {
      await prisma.worktreeCleanup.updateMany({ where: { id, status: 'pending' }, data: { status: 'cancelled', itemsJson: JSON.stringify(items), updatedAt: now() } });
      throw new DomainError('NOTHING_TO_REMOVE', '没有可以删除的 worktree', 409);
    }
    await prisma.$transaction(async (tx) => {
      const changed = await tx.worktreeCleanup.updateMany({ where: { id, status: 'pending' }, data: { status: 'confirmed', itemsJson: JSON.stringify(items), updatedAt: now() } });
      if (!changed.count) throw new DomainError('CLEANUP_NOT_PENDING', '这张确认卡片已处理过', 409);
      const { job } = await enqueueJob(tx, { nodeId: row.nodeId, kind: 'cleanup', dispatchKey: `cleanup:${id}`, payload: { worktrees: paths, deleteBranches: row.deleteBranches } });
      await tx.worktreeCleanup.update({ where: { id }, data: { jobId: job.id } });
    });
    return this.getCleanup(id);
  }

  async cancelCleanup(id: string) {
    const changed = await prisma.worktreeCleanup.updateMany({ where: { id, status: 'pending' }, data: { status: 'cancelled', updatedAt: now() } });
    if (!changed.count) throw new DomainError('CLEANUP_NOT_PENDING', '这张确认卡片已处理过', 409);
    return this.getCleanup(id);
  }
}

/** Node finished an inventory or cleanup job: store the latest listing and close the card. */
export async function applyWorktreeJob(job: NodeJob) {
  const report = job.resultJson ? JSON.parse(job.resultJson) as { ok: boolean; result?: unknown; error?: string } : null;
  if (job.kind === 'inventory') {
    const parsed = report?.ok ? inventoryResultSchema.safeParse(report.result) : null;
    if (parsed?.success) await prisma.agentNode.update({ where: { id: job.nodeId }, data: { inventoryJson: JSON.stringify(parsed.data), inventoryAt: now() } });
  }
  if (job.kind === 'cleanup') {
    const parsed = report?.ok ? cleanupResultSchema.safeParse(report.result) : null;
    if (parsed?.success) await prisma.agentNode.update({ where: { id: job.nodeId }, data: { inventoryJson: JSON.stringify(parsed.data.inventory), inventoryAt: now() } });
    const { inventory: _inventory, ...summary } = parsed?.success ? parsed.data : { inventory: null };
    await prisma.worktreeCleanup.updateMany({ where: { jobId: job.id }, data: { status: parsed?.success ? 'done' : 'failed', resultJson: JSON.stringify(parsed?.success ? summary : { error: report?.error ?? job.error ?? '电脑回报格式无效' }), updatedAt: now() } });
  }
  publishWorkspaceChange({ kind: 'worktrees', nodeId: job.nodeId });
}
