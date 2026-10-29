import { z } from 'zod';
import { registerCommandHandler } from './commands.js';
import { jsonSchema } from './command-catalog.js';
import { recordChange } from './workspace-store.js';
import { DomainError } from '../domain/task.js';
import type { Prisma } from '@prisma/client';
import { learningNodeStatuses } from '../domain/learning.js';
import { checkedCheckpoint, confirmedCheckpoint } from './learning-checkpoint.js';

// 学习域命令处理器。全部 forceProposal：内置助手和外部连接都只能先生成
// 待确认方案，用户批准后经 executeBatch 执行并写入变更历史。

const learningFailure = (code: string, message: string, status = 400) => new DomainError(code, message, status);
const now = () => new Date().toISOString();

const mapCreate = z.object({ title: z.string().min(1).max(200), goal: z.string().max(2000) }).strict();
const mapUpdate = z.object({
  title: z.string().min(1).max(200).optional(),
  goal: z.string().max(2000).optional(),
  status: z.enum(['active', 'paused']).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => value[key as keyof typeof value] !== undefined), { message: '至少修改一个字段' });
const revisions = z.record(z.number().int().positive());
const mapArchive = z.object({ expectedNodeRevisions: revisions.optional() }).strict();
const nodeArchive = z.object({ cascade: z.boolean().optional(), expectedDescendantRevisions: revisions.optional() }).strict();
const nodeCreate = z.object({
  mapId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  kind: z.enum(['topic', 'item']),
  title: z.string().min(1).max(300),
  detail: z.string().max(20000),
  sortOrder: z.number().int().min(0).max(100000),
  status: z.enum(learningNodeStatuses).optional(),
}).strict();
const nodeUpdate = z.object({
  title: z.string().min(1).max(300).optional(),
  detail: z.string().max(20000).optional(),
  status: z.enum(learningNodeStatuses).optional(),
  mastery: z.number().int().min(0).max(100).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => value[key as keyof typeof value] !== undefined), { message: '至少修改一个字段' });
const nodeMove = z.object({ parentId: z.string().min(1).nullable() }).strict();
const activityAppend = z.object({
  mapId: z.string().min(1),
  nodeId: z.string().min(1).nullable(),
  kind: z.enum(['session', 'status', 'note']),
  content: z.string().min(1).max(5000),
  meta: z.record(z.unknown()).optional(),
}).strict();

type LearningDb = Pick<Prisma.TransactionClient, 'learningMap' | 'learningNode'>;
async function requireMap(tx: Pick<LearningDb, 'learningMap'>, mapId: string) {
  const map = await tx.learningMap.findUnique({ where: { id: mapId } });
  if (!map || map.deletedAt) throw learningFailure('NOT_FOUND', '学习地图不存在', 404);
  return map as { id: string; title: string; goal: string; status: string; revision: number; deletedAt: string | null };
}

async function requireNode(tx: LearningDb, nodeId: string) {
  const node = await tx.learningNode.findUnique({ where: { id: nodeId } });
  if (!node || node.deletedAt) throw learningFailure('NOT_FOUND', '学习条目不存在', 404);
  await requireMap(tx, node.mapId);
  return node;
}

async function assertRevision(current: number | undefined, expected: number | undefined, label: string) {
  if (expected === undefined || !Number.isInteger(expected) || expected < 1) throw learningFailure('VERSION_REQUIRED', `需要${label}`, 400);
  if (current !== expected) throw learningFailure('VERSION_CONFLICT', '内容已经变化，请刷新后重试', 428);
}

async function requireParent(tx: LearningDb, mapId: string, parentId: string | null) {
  if (!parentId) return null;
  const parent = await requireNode(tx, parentId);
  if (parent.mapId !== mapId) throw learningFailure('INVALID_PARENT', '父节点必须在同一张学习地图里', 400);
  if (parent.kind === 'item') throw learningFailure('INVALID_PARENT', '清单条目下不能再建节点', 400);
  return parent;
}

async function liveMapNodes(tx: LearningDb, mapId: string) {
  return tx.learningNode.findMany({ where: { mapId, deletedAt: null }, orderBy: { id: 'asc' } });
}
function assertExpectedRows(rows: Array<{ id: string; revision: number }>, expected?: Record<string, number>) {
  if (expected && (Object.keys(expected).length !== rows.length || rows.some(row => expected[row.id] !== row.revision))) {
    throw learningFailure('VERSION_CONFLICT', '知识点或笔记已经变化，请刷新后重新确认', 428);
  }
}
async function archiveScope(tx: LearningDb, nodeId: string, input: z.infer<typeof nodeArchive>) {
  const node = await requireNode(tx, nodeId);
  const rows = await liveMapNodes(tx, node.mapId);
  const ids = new Set([node.id]);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) { ids.add(row.id); changed = true; } }
  const descendants = rows.filter(row => row.id !== node.id && ids.has(row.id));
  if (descendants.length && !input.cascade) throw learningFailure('NODE_HAS_CHILDREN', '该节点还有子节点，请明确确认同时删除下级知识点', 400);
  assertExpectedRows(descendants, input.expectedDescendantRevisions);
  return { node, descendants };
}

export function registerLearningCommands() {
  registerCommandHandler('learning.map.create', {
    forceProposal: true,
    description: '创建一张学习地图。',
    inputSchema: jsonSchema(mapCreate),
    inspect: async (tx, _actor, command) => {
      const input = mapCreate.parse(command.input ?? {});
      return { preconditions: { title: input.title }, preview: input };
    },
    execute: async (tx, _actor, command, context) => {
      const input = mapCreate.parse(command.input ?? {});
      const timestamp = now();
      const map = await tx.learningMap.create({ data: { ...(context.entityId || command.entityId ? { id: context.entityId ?? command.entityId } : {}), title: input.title, goal: input.goal, createdAt: timestamp, updatedAt: timestamp } });
      await recordChange(tx, 'learning_map', map.id, 'create', null, map, context);
      return map;
    },
  });
  registerCommandHandler('learning.map.update', {
    forceProposal: true,
    description: '修改学习地图的标题、目标或状态（active/paused）。',
    inputSchema: jsonSchema(mapUpdate),
    inspect: async (tx, _actor, command) => {
      const input = mapUpdate.parse(command.input ?? {});
      const map = await requireMap(tx, command.targetId ?? '');
      await assertRevision(map.revision, command.expectedRevision, '地图版本');
      return { preconditions: { id: map.id, revision: map.revision }, preview: { ...input, previousTitle: map.title } };
    },
    execute: async (tx, _actor, command, context) => {
      const input = mapUpdate.parse(command.input ?? {});
      const map = await requireMap(tx, command.targetId ?? '');
      await assertRevision(map.revision, command.expectedRevision, '地图版本');
      const updated = await tx.learningMap.update({ where: { id: map.id, revision: map.revision }, data: { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.goal !== undefined ? { goal: input.goal } : {}), ...(input.status !== undefined ? { status: input.status } : {}), revision: { increment: 1 }, updatedAt: now() } });
      await recordChange(tx, 'learning_map', updated.id, 'update', map, updated, context);
      return updated;
    },
  });
  registerCommandHandler('learning.map.archive', {
    forceProposal: true,
    description: '归档（软删除）一张学习地图。',
    inputSchema: jsonSchema(mapArchive),
    inspect: async (tx, _actor, command) => {
      const input = mapArchive.parse(command.input ?? {});
      const map = await requireMap(tx, command.targetId ?? '');
      await assertRevision(map.revision, command.expectedRevision, '地图版本');
      const nodes = await liveMapNodes(tx, map.id);
      assertExpectedRows(nodes, input.expectedNodeRevisions);
      return { preconditions: { id: map.id, revision: map.revision, nodes: nodes.map(({ id, revision }) => ({ id, revision })) }, preview: { archived: true, title: map.title, nodeCount: nodes.length } };
    },
    execute: async (tx, _actor, command, context) => {
      const input = mapArchive.parse(command.input ?? {});
      const map = await requireMap(tx, command.targetId ?? '');
      await assertRevision(map.revision, command.expectedRevision, '地图版本');
      const nodes = await liveMapNodes(tx, map.id);
      assertExpectedRows(nodes, input.expectedNodeRevisions);
      const updated = await tx.learningMap.update({ where: { id: map.id, revision: map.revision }, data: { deletedAt: now(), revision: { increment: 1 }, updatedAt: now() } });
      await recordChange(tx, 'learning_map', updated.id, 'archive', map, updated, context);
      for (const node of nodes) {
        const archived = await tx.learningNode.update({ where: { id: node.id, revision: node.revision }, data: { deletedAt: now(), revision: { increment: 1 }, updatedAt: now() } });
        await recordChange(tx, 'learning_node', node.id, 'archive', node, archived, context);
      }
      return updated;
    },
  });
  registerCommandHandler('learning.node.create', {
    forceProposal: true,
    description: '在学习地图里创建节点：kind=topic 是结构节点，kind=item 是带持久笔记的知识点。',
    inputSchema: jsonSchema(nodeCreate),
    inspect: async (tx, _actor, command) => {
      const input = nodeCreate.parse(command.input ?? {});
      await requireMap(tx, input.mapId);
      await requireParent(tx, input.mapId, input.parentId);
      return { preconditions: { mapId: input.mapId, parentId: input.parentId }, preview: input };
    },
    execute: async (tx, _actor, command, context) => {
      const input = nodeCreate.parse(command.input ?? {});
      await requireMap(tx, input.mapId);
      await requireParent(tx, input.mapId, input.parentId);
      const timestamp = now();
      const node = await tx.learningNode.create({ data: { ...(context.entityId || command.entityId ? { id: context.entityId ?? command.entityId } : {}), mapId: input.mapId, parentId: input.parentId, kind: input.kind, title: input.title, detail: input.detail, sortOrder: input.sortOrder, ...(input.status ? { status: input.status } : {}), createdAt: timestamp, updatedAt: timestamp } });
      await recordChange(tx, 'learning_node', node.id, 'create', null, node, context);
      return node;
    },
  });
  registerCommandHandler('learning.node.update', {
    forceProposal: true,
    description: '修改知识点标题、持久笔记正文 detail、四档状态 todo/learning/review/done 或排序。mastery 数值保留兼容，不参与四档状态判断。',
    inputSchema: jsonSchema(nodeUpdate),
    inspect: async (tx, _actor, command) => {
      const input = nodeUpdate.parse(command.input ?? {});
      const node = await requireNode(tx, command.targetId ?? '');
      await assertRevision(node.revision, command.expectedRevision, '条目版本');
      return { preconditions: { id: node.id, revision: node.revision }, preview: { ...input, previousTitle: node.title } };
    },
    execute: async (tx, _actor, command, context) => {
      const input = nodeUpdate.parse(command.input ?? {});
      const node = await requireNode(tx, command.targetId ?? '');
      await assertRevision(node.revision, command.expectedRevision, '条目版本');
      const updated = await tx.learningNode.update({
        where: { id: node.id, revision: node.revision },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.mastery !== undefined ? { mastery: input.mastery } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          revision: { increment: 1 },
          updatedAt: now(),
        },
      });
      await recordChange(tx, 'learning_node', updated.id, 'update', node, updated, context);
      return updated;
    },
  });
  registerCommandHandler('learning.node.move', {
    forceProposal: true,
    description: '在学习地图内移动节点。parentId 为 null 时移到根。',
    inputSchema: jsonSchema(nodeMove),
    inspect: async (tx, _actor, command) => {
      const input = nodeMove.parse(command.input ?? {});
      const node = await requireNode(tx, command.targetId ?? '');
      await assertRevision(node.revision, command.expectedRevision, '条目版本');
      await requireParent(tx, node.mapId, input.parentId);
      if (input.parentId === node.id) throw learningFailure('INVALID_PARENT', '节点不能做自己的父节点', 400);
      let cursor = input.parentId;
      while (cursor) {
        if (cursor === node.id) throw learningFailure('INVALID_PARENT', '不能把节点移到它自己的子树里', 400);
        const parent = await tx.learningNode.findUnique({ where: { id: cursor }, select: { id: true, parentId: true } });
        cursor = parent?.parentId ?? null;
      }
      return { preconditions: { id: node.id, revision: node.revision }, preview: { parentId: input.parentId, previousParentId: node.parentId } };
    },
    execute: async (tx, _actor, command, context) => {
      const input = nodeMove.parse(command.input ?? {});
      const node = await requireNode(tx, command.targetId ?? '');
      await assertRevision(node.revision, command.expectedRevision, '条目版本');
      await requireParent(tx, node.mapId, input.parentId);
      if (input.parentId === node.id) throw learningFailure('INVALID_PARENT', '节点不能做自己的父节点', 400);
      const updated = await tx.learningNode.update({ where: { id: node.id, revision: node.revision }, data: { parentId: input.parentId, revision: { increment: 1 }, updatedAt: now() } });
      await recordChange(tx, 'learning_node', updated.id, 'update', node, updated, context);
      return updated;
    },
  });
  registerCommandHandler('learning.node.archive', {
    forceProposal: true,
    description: '软删除知识点。分组含下级时须明确 cascade=true；可带 expectedDescendantRevisions 防止删除新改动。',
    inputSchema: jsonSchema(nodeArchive),
    inspect: async (tx, _actor, command) => {
      const input = nodeArchive.parse(command.input ?? {});
      const { node, descendants } = await archiveScope(tx, command.targetId ?? '', input);
      await assertRevision(node.revision, command.expectedRevision, '条目版本');
      return { preconditions: { id: node.id, revision: node.revision, descendants: descendants.map(({ id, revision }) => ({ id, revision })) }, preview: { archived: true, title: node.title, descendants: descendants.map(({ id, title }) => ({ id, title })) } };
    },
    execute: async (tx, _actor, command, context) => {
      const input = nodeArchive.parse(command.input ?? {});
      const { node, descendants } = await archiveScope(tx, command.targetId ?? '', input);
      await assertRevision(node.revision, command.expectedRevision, '条目版本');
      const timestamp = now();
      let result;
      for (const previous of [...descendants, node]) {
        const updated = await tx.learningNode.update({ where: { id: previous.id, revision: previous.revision }, data: { deletedAt: timestamp, revision: { increment: 1 }, updatedAt: timestamp } });
        await recordChange(tx, 'learning_node', updated.id, 'archive', previous, updated, context);
        if (previous.id === node.id) result = updated;
      }
      return result;
    },
  });
  registerCommandHandler('learning.activity.append', {
    forceProposal: true,
    description: '追加一条学习动态（session 陪学总结 / status 状态变更 / note 笔记）。只追加，不修改。',
    inputSchema: jsonSchema(activityAppend),
    inspect: async (tx, _actor, command) => {
      const input = activityAppend.parse(command.input ?? {});
      await requireMap(tx, input.mapId);
      if (input.nodeId) {
        const node = await requireNode(tx, input.nodeId);
        if (node.mapId !== input.mapId) throw learningFailure('INVALID_PARENT', '条目不属于这张学习地图', 400);
      }
      await checkedCheckpoint(tx, input);
      return { preconditions: { mapId: input.mapId }, preview: { kind: input.kind, content: input.content.slice(0, 200) } };
    },
    execute: async (tx, _actor, command, context) => {
      const input = activityAppend.parse(command.input ?? {});
      await requireMap(tx, input.mapId);
      if (input.nodeId) {
        const node = await requireNode(tx, input.nodeId);
        if (node.mapId !== input.mapId) throw learningFailure('INVALID_PARENT', '条目不属于这张学习地图', 400);
      }
      const checkpoint = await checkedCheckpoint(tx, input);
      const timestamp = now();
      const meta = checkpoint ? confirmedCheckpoint(checkpoint, context, timestamp) : input.meta ?? {};
      const activity = await tx.learningActivity.create({ data: { mapId: input.mapId, nodeId: input.nodeId, kind: input.kind, content: input.content, metaJson: JSON.stringify(meta), createdAt: timestamp } });
      await recordChange(tx, 'learning_activity', activity.id, 'append', null, activity, context);
      return activity;
    },
  });
}
