import { z } from 'zod';
import { registerCommandHandler } from './commands.js';
import { jsonSchema } from './command-catalog.js';
import { recordChange } from './workspace-store.js';
import { DomainError } from '../domain/task.js';

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
const empty = z.object({}).strict();
const nodeCreate = z.object({
  mapId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  kind: z.enum(['topic', 'item']),
  title: z.string().min(1).max(300),
  detail: z.string().max(20000),
  sortOrder: z.number().int().min(0).max(100000),
}).strict();
const nodeUpdate = z.object({
  title: z.string().min(1).max(300).optional(),
  detail: z.string().max(20000).optional(),
  status: z.enum(['todo', 'learning', 'done']).optional(),
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

async function requireMap(tx: { learningMap: { findUnique: Function } }, mapId: string) {
  const map = await tx.learningMap.findUnique({ where: { id: mapId } });
  if (!map || map.deletedAt) throw learningFailure('NOT_FOUND', '学习地图不存在', 404);
  return map as { id: string; title: string; goal: string; status: string; revision: number; deletedAt: string | null };
}

async function requireNode(tx: { learningNode: { findUnique: Function } }, nodeId: string) {
  const node = await tx.learningNode.findUnique({ where: { id: nodeId } });
  if (!node || node.deletedAt) throw learningFailure('NOT_FOUND', '学习条目不存在', 404);
  return node as { id: string; mapId: string; parentId: string | null; kind: string; title: string; revision: number };
}

async function assertRevision(current: number | undefined, expected: number | undefined, label: string) {
  if (expected === undefined || !Number.isInteger(expected) || expected < 1) throw learningFailure('VERSION_REQUIRED', `需要${label}`, 400);
  if (current !== expected) throw learningFailure('VERSION_CONFLICT', '内容已经变化，请刷新后重试', 428);
}

async function requireParent(tx: { learningNode: { findUnique: Function } }, mapId: string, parentId: string | null) {
  if (!parentId) return null;
  const parent = await requireNode(tx, parentId);
  if (parent.mapId !== mapId) throw learningFailure('INVALID_PARENT', '父节点必须在同一张学习地图里', 400);
  if (parent.kind === 'item') throw learningFailure('INVALID_PARENT', '清单条目下不能再建节点', 400);
  return parent;
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
    inputSchema: jsonSchema(empty),
    inspect: async (tx, _actor, command) => {
      const map = await requireMap(tx, command.targetId ?? '');
      await assertRevision(map.revision, command.expectedRevision, '地图版本');
      return { preconditions: { id: map.id, revision: map.revision }, preview: { archived: true, title: map.title } };
    },
    execute: async (tx, _actor, command, context) => {
      const map = await requireMap(tx, command.targetId ?? '');
      await assertRevision(map.revision, command.expectedRevision, '地图版本');
      const updated = await tx.learningMap.update({ where: { id: map.id, revision: map.revision }, data: { deletedAt: now(), revision: { increment: 1 }, updatedAt: now() } });
      await recordChange(tx, 'learning_map', updated.id, 'archive', map, updated, context);
      return updated;
    },
  });
  registerCommandHandler('learning.node.create', {
    forceProposal: true,
    description: '在学习地图里创建节点：kind=topic 是结构节点，kind=item 是清单条目。',
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
      const node = await tx.learningNode.create({ data: { ...(context.entityId || command.entityId ? { id: context.entityId ?? command.entityId } : {}), mapId: input.mapId, parentId: input.parentId, kind: input.kind, title: input.title, detail: input.detail, sortOrder: input.sortOrder, createdAt: timestamp, updatedAt: timestamp } });
      await recordChange(tx, 'learning_node', node.id, 'create', null, node, context);
      return node;
    },
  });
  registerCommandHandler('learning.node.update', {
    forceProposal: true,
    description: '修改学习条目的标题、说明、状态、掌握度（0-100）或排序。',
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
    description: '归档（软删除）学习条目。有子节点时需要先处理子节点。',
    inputSchema: jsonSchema(empty),
    inspect: async (tx, _actor, command) => {
      const node = await requireNode(tx, command.targetId ?? '');
      await assertRevision(node.revision, command.expectedRevision, '条目版本');
      const children = await tx.learningNode.count({ where: { parentId: node.id, deletedAt: null } });
      if (children > 0) throw learningFailure('NODE_HAS_CHILDREN', '该节点还有子节点，先归档或移走子节点', 400);
      return { preconditions: { id: node.id, revision: node.revision }, preview: { archived: true, title: node.title } };
    },
    execute: async (tx, _actor, command, context) => {
      const node = await requireNode(tx, command.targetId ?? '');
      await assertRevision(node.revision, command.expectedRevision, '条目版本');
      const children = await tx.learningNode.count({ where: { parentId: node.id, deletedAt: null } });
      if (children > 0) throw learningFailure('NODE_HAS_CHILDREN', '该节点还有子节点，先归档或移走子节点', 400);
      const updated = await tx.learningNode.update({ where: { id: node.id, revision: node.revision }, data: { deletedAt: now(), revision: { increment: 1 }, updatedAt: now() } });
      await recordChange(tx, 'learning_node', updated.id, 'archive', node, updated, context);
      return updated;
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
      return { preconditions: { mapId: input.mapId }, preview: { kind: input.kind, content: input.content.slice(0, 200) } };
    },
    execute: async (tx, _actor, command, context) => {
      const input = activityAppend.parse(command.input ?? {});
      await requireMap(tx, input.mapId);
      if (input.nodeId) {
        const node = await requireNode(tx, input.nodeId);
        if (node.mapId !== input.mapId) throw learningFailure('INVALID_PARENT', '条目不属于这张学习地图', 400);
      }
      const activity = await tx.learningActivity.create({ data: { mapId: input.mapId, nodeId: input.nodeId, kind: input.kind, content: input.content, metaJson: JSON.stringify(input.meta ?? {}), createdAt: now() } });
      await recordChange(tx, 'learning_activity', activity.id, 'append', null, activity, context);
      return activity;
    },
  });
}
