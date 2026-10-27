import { z } from 'zod';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';

// 学习域读取服务：学习地图（learning_maps）、地图树与清单条目（learning_nodes）、
// 学习动态（learning_activity，只追加）。写入统一经 learning.* 命令；AI 修改须先经 propose_changes 待确认。

export const learningReadInput = z.object({
  action: z.enum(['list', 'get', 'node', 'activity']),
  mapId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  includeArchived: z.boolean().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export type LearningNodeRow = {
  id: string; mapId: string; parentId: string | null; kind: string; title: string;
  status: string; mastery: number; sortOrder: number; revision: number;
  detail: string; deletedAt: string | null; createdAt: string; updatedAt: string;
};

type LearningTreeNode = LearningNodeRow & { children: LearningTreeNode[] };

function toRow(node: {
  id: string; mapId: string; parentId: string | null; kind: string; title: string; detail: string;
  status: string; mastery: number; sortOrder: number; revision: number;
  deletedAt: string | null; createdAt: string; updatedAt: string;
}): LearningNodeRow {
  return {
    id: node.id, mapId: node.mapId, parentId: node.parentId, kind: node.kind, title: node.title,
    detail: node.detail, status: node.status, mastery: node.mastery, sortOrder: node.sortOrder,
    revision: node.revision, deletedAt: node.deletedAt, createdAt: node.createdAt, updatedAt: node.updatedAt,
  };
}

function buildTree(rows: LearningNodeRow[]): LearningTreeNode[] {
  const byParent = new Map<string | null, LearningTreeNode[]>();
  for (const row of rows) {
    const list = byParent.get(row.parentId) ?? [];
    list.push({ ...row, children: [] });
    byParent.set(row.parentId, list);
  }
  const attach = (nodes: LearningTreeNode[]): LearningTreeNode[] => nodes.map((node) => {
    node.children = attach(byParent.get(node.id) ?? []);
    return node;
  });
  return attach(byParent.get(null) ?? []);
}

function statsOf(rows: LearningNodeRow[]) {
  const live = rows.filter((row) => !row.deletedAt);
  const items = live.filter((row) => row.kind === 'item');
  const mastered = items.filter((row) => row.status === 'done');
  const avg = items.length ? Math.round(items.reduce((sum, row) => sum + row.mastery, 0) / items.length) : null;
  return {
    topics: live.filter((row) => row.kind === 'topic').length,
    items: items.length,
    itemsDone: mastered.length,
    itemsLearning: items.filter((row) => row.status === 'learning').length,
    averageMastery: avg,
  };
}

async function mapWithCounts(includeArchived: boolean) {
  const maps = await prisma.learningMap.findMany({
    where: includeArchived ? {} : { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  const nodes = await prisma.learningNode.findMany({
    where: { deletedAt: null },
    select: { mapId: true, kind: true, status: true, mastery: true },
  });
  return maps.map((map) => {
    const own = nodes.filter((node) => node.mapId === map.id);
    const items = own.filter((node) => node.kind === 'item');
    return {
      id: map.id, title: map.title, goal: map.goal, status: map.status,
      revision: map.revision, deletedAt: map.deletedAt, updatedAt: map.updatedAt,
      stats: {
        topics: own.filter((node) => node.kind === 'topic').length,
        items: items.length,
        itemsDone: items.filter((node) => node.status === 'done').length,
        averageMastery: items.length ? Math.round(items.reduce((sum, node) => sum + node.mastery, 0) / items.length) : null,
      },
    };
  });
}

export async function learningRead(args: Record<string, unknown>) {
  const parsed = learningReadInput.safeParse(args);
  if (!parsed.success) throw new DomainError('INVALID_TOOL_ARGUMENTS', parsed.error.issues.map((issue) => issue.message).join('；'), 400);
  const input = parsed.data;
  if (input.action === 'list') {
    const maps = await mapWithCounts(input.includeArchived === true);
    return { maps, complete: true, note: '学习地图列表。get 读取节点树，node 读取条目详情。' };
  }
  if (input.action === 'get') {
    if (!input.mapId) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'get 需要 mapId', 400);
    const map = await prisma.learningMap.findUnique({ where: { id: input.mapId } });
    if (!map || map.deletedAt && !input.includeArchived) throw new DomainError('NOT_FOUND', '学习地图不存在', 404);
    const rows = (await prisma.learningNode.findMany({
      where: { mapId: map.id, ...(input.includeArchived === true ? {} : { deletedAt: null }) },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    })).map(toRow);
    return {
      map: { id: map.id, title: map.title, goal: map.goal, status: map.status, revision: map.revision, updatedAt: map.updatedAt },
      tree: buildTree(rows),
      stats: statsOf(rows),
      complete: true,
      note: '完整节点树。kind=topic 是结构分组，kind=item 是知识点；detail 为持久笔记。status 为 todo/learning/review/done，分别表示未开始/学习中/需巩固/已掌握；mastery 仅为兼容历史数值。',
    };
  }
  if (input.action === 'node') {
    if (!input.nodeId) throw new DomainError('INVALID_TOOL_ARGUMENTS', 'node 需要 nodeId', 400);
    const node = await prisma.learningNode.findUnique({ where: { id: input.nodeId } });
    if (!node || node.deletedAt && !input.includeArchived) throw new DomainError('NOT_FOUND', '学习条目不存在', 404);
    const map = await prisma.learningMap.findUnique({ where: { id: node.mapId } });
    if (!map || map.deletedAt && !input.includeArchived) throw new DomainError('NOT_FOUND', '学习地图不存在', 404);
    const children = (await prisma.learningNode.findMany({
      where: { parentId: node.id, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, kind: true, title: true, status: true, mastery: true },
    }));
    const activity = await prisma.learningActivity.findMany({
      where: { nodeId: node.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5,
      select: { id: true, kind: true, content: true, createdAt: true },
    });
    return { node: toRow(node), children, recentActivity: activity, activityCoverage: '最近 5 条，不代表全部' };
  }
  // action === 'activity'
  const where = {
    ...(input.mapId ? { mapId: input.mapId } : {}),
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.from || input.to ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}),
  };
  const limit = input.limit ?? 20;
  const cursor = input.cursor ? decodeActivityCursor(input.cursor) : null;
  const rows = await prisma.learningActivity.findMany({
    where: { ...where, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    activity: page,
    nextCursor: hasMore && last ? encodeActivityCursor({ createdAt: last.createdAt, id: last.id }) : null,
    complete: !hasMore,
    note: '学习动态按时间倒序，只追加记录；用 nextCursor 续读。',
  };
}

function encodeActivityCursor(value: { createdAt: string; id: string }) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
function decodeActivityCursor(cursor: string) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch { return null; }
}

/** 学习助手系统上下文里的【学习域概况】：active 地图统计 + 最近动态摘录。 */
export async function learningOverview() {
  const maps = (await mapWithCounts(false)).filter((map) => map.status === 'active');
  const recent = await prisma.learningActivity.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 5,
    select: { kind: true, content: true, createdAt: true },
  });
  if (!maps.length && !recent.length) return '还没有学习地图。和用户聊要学什么，用 propose_changes（learning_write 组）起草第一张学习地图。';
  const lines = ['# 学习域概况', ''];
  if (maps.length) {
    lines.push('进行中的学习地图：');
    for (const map of maps) lines.push(`- ${map.id} ${map.title}：${map.stats.topics} 个主题、${map.stats.items} 条清单，完成 ${map.stats.itemsDone}`);
  } else lines.push('没有进行中的学习地图。');
  lines.push('', '最近学习动态（最多 5 条，完整记录用 learning_read 的 action=activity）：');
  if (recent.length) for (const item of recent) lines.push(`- ${item.createdAt} [${item.kind}] ${item.content.slice(0, 120)}${item.content.length > 120 ? '…' : ''}`);
  else lines.push('- 暂无动态');
  return lines.join('\n');
}

/** 学习地图页面聚合端点：一张地图的树、统计与最近动态。 */
export async function learningMapAggregate(mapId: string) {
  const map = await prisma.learningMap.findUnique({ where: { id: mapId } });
  if (!map || map.deletedAt) throw new DomainError('NOT_FOUND', '学习地图不存在', 404);
  const rows = (await prisma.learningNode.findMany({
    where: { mapId: map.id, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })).map(toRow);
  const activity = await prisma.learningActivity.findMany({
    where: { mapId: map.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 30,
  });
  return {
    map: { id: map.id, title: map.title, goal: map.goal, status: map.status, revision: map.revision, updatedAt: map.updatedAt },
    tree: buildTree(rows),
    stats: statsOf(rows),
    recentActivity: activity,
    activityCoverage: '最近 30 条',
  };
}
