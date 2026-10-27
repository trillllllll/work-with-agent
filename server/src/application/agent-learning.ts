import { learningNodeStatuses } from '../domain/learning.js';
import type { Command } from './commands.js';

// propose_changes 的 learning 族参数校验与命令映射。
// 执行与版本检查由 learning-commands.ts 注册的 learning.* 命令处理器完成。

export const learningActions = ['map_create', 'map_update', 'map_archive', 'node_create', 'node_update', 'node_move', 'node_archive', 'activity_append'] as const;
export type LearningAction = (typeof learningActions)[number];

const allowedKeys: Record<LearningAction, readonly string[]> = {
  map_create: ['action', 'title', 'goal'],
  map_update: ['action', 'mapId', 'expectedRevision', 'title', 'goal', 'status'],
  map_archive: ['action', 'mapId', 'expectedRevision', 'expectedNodeRevisions'],
  node_create: ['action', 'mapId', 'parentId', 'kind', 'title', 'detail', 'sortOrder', 'nodeStatus'],
  node_update: ['action', 'nodeId', 'expectedNodeRevision', 'title', 'detail', 'nodeStatus', 'mastery', 'sortOrder'],
  node_move: ['action', 'nodeId', 'expectedNodeRevision', 'parentId'],
  node_archive: ['action', 'nodeId', 'expectedNodeRevision', 'cascade', 'expectedDescendantRevisions'],
  activity_append: ['action', 'mapId', 'nodeId', 'kind', 'content', 'meta'],
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** 批次内引用：编译期允许 mapId/parentId 以 { $ref } 形式指向同批创建的地图。 */
function isIdOrRef(value: unknown): boolean {
  if (typeof value === 'string' && value.trim().length > 0) return true;
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { $ref?: unknown }).$ref === 'string' && (value as { $ref: string }).$ref.length > 0);
}

function integer(value: unknown, min: number, max?: number): boolean {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) return false;
  return max === undefined || value <= max;
}

function requireId(args: Record<string, unknown>, key: string, label: string) {
  if (!isIdOrRef(args[key])) return `需要${label}`;
  return null;
}

function requireRevision(args: Record<string, unknown>, key: string, label: string) {
  if (!integer(args[key], 1)) return `需要${label}`;
  return null;
}

export function validateLearningArguments(args: Record<string, unknown>): string | null {
  const action = args.action;
  if (typeof action !== 'string' || !(learningActions as readonly string[]).includes(action)) return '未知动作';
  const unknown = Object.keys(args).find((key) => !allowedKeys[action as LearningAction].includes(key));
  if (unknown) return `未知参数: ${unknown}`;
  if (action === 'map_create') {
    const title = text(args.title);
    if (!title || [...title].length > 200) return '标题需要 1 到 200 个字符';
    if (args.goal !== undefined && typeof args.goal !== 'string') return 'goal 无效';
    if (typeof args.goal === 'string' && [...args.goal].length > 2000) return 'goal 不能超过 2000 字';
  }
  if (action === 'map_update') {
    const id = requireId(args, 'mapId', 'mapId');
    if (id) return id;
    const revision = requireRevision(args, 'expectedRevision', '刚才读到的地图 revision');
    if (revision) return revision;
    if (args.status !== undefined && !['active', 'paused'].includes(String(args.status))) return 'status 只能是 active 或 paused';
    if (args.title !== undefined && (!text(args.title) || [...text(args.title)!].length > 200)) return '标题需要 1 到 200 个字符';
    if (args.goal !== undefined && typeof args.goal !== 'string') return 'goal 无效';
    if (args.title === undefined && args.goal === undefined && args.status === undefined) return 'map_update 需要至少一个修改字段';
  }
  if (action === 'map_archive') {
    const id = requireId(args, 'mapId', 'mapId');
    if (id) return id;
    const revision = requireRevision(args, 'expectedRevision', '刚才读到的地图 revision');
    if (revision) return revision;
  }
  if (action === 'node_create') {
    const map = requireId(args, 'mapId', 'mapId');
    if (map) return map;
    if (!['topic', 'item'].includes(String(args.kind))) return 'kind 只能是 topic 或 item';
    const title = text(args.title);
    if (!title || [...title].length > 300) return '标题需要 1 到 300 个字符';
    if (args.parentId !== undefined && args.parentId !== null && !isIdOrRef(args.parentId)) return 'parentId 无效';
    if (args.detail !== undefined && (typeof args.detail !== 'string' || [...args.detail].length > 20000)) return 'detail 不能超过 20000 字';
    if (args.sortOrder !== undefined && !integer(args.sortOrder, 0, 100000)) return 'sortOrder 无效';
  }
  if (['node_update', 'node_move', 'node_archive'].includes(action)) {
    const id = requireId(args, 'nodeId', 'nodeId');
    if (id) return id;
    const revision = requireRevision(args, 'expectedNodeRevision', '刚才读到的条目 revision');
    if (revision) return revision;
  }
  if (action === 'node_update') {
    if (args.title !== undefined && (!text(args.title) || [...text(args.title)!].length > 300)) return '标题需要 1 到 300 个字符';
    if (args.detail !== undefined && (typeof args.detail !== 'string' || [...args.detail].length > 20000)) return 'detail 不能超过 20000 字';
    if (args.nodeStatus !== undefined && !learningNodeStatuses.includes(args.nodeStatus as never)) return 'nodeStatus 只能是 todo、learning、review 或 done';
    if (args.mastery !== undefined && !integer(args.mastery, 0, 100)) return 'mastery 是 0 到 100 的整数';
    if (args.sortOrder !== undefined && !integer(args.sortOrder, 0, 100000)) return 'sortOrder 无效';
    if (['title', 'detail', 'nodeStatus', 'mastery', 'sortOrder'].every((key) => args[key] === undefined)) return 'node_update 需要至少一个修改字段';
  }
  if (action === 'node_move') {
    if (args.parentId === undefined) return 'node_move 需要 parentId（可以为 null 移到根）';
    if (args.parentId !== null && !text(args.parentId)) return 'parentId 无效';
  }
  if (action === 'activity_append') {
    const map = requireId(args, 'mapId', 'mapId');
    if (map) return map;
    if (args.nodeId !== undefined && args.nodeId !== null && !text(args.nodeId)) return 'nodeId 无效';
    if (!['session', 'status', 'note'].includes(String(args.kind))) return 'kind 只能是 session、status 或 note';
    const content = text(args.content);
    if (!content || [...content].length > 5000) return '内容需要 1 到 5000 个字符';
    if (args.meta !== undefined && (typeof args.meta !== 'object' || Array.isArray(args.meta))) return 'meta 无效';
  }
  if (args.nodeStatus !== undefined && !learningNodeStatuses.includes(args.nodeStatus as never)) return 'nodeStatus 只能是 todo、learning、review 或 done';
  if (args.cascade !== undefined && typeof args.cascade !== 'boolean') return 'cascade 必须为布尔值';
  for (const key of ['expectedNodeRevisions', 'expectedDescendantRevisions']) {
    const value = args[key];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([id, revision]) => !id || !integer(revision, 1)))) return `${key} 必须为节点 ID 到版本号的映射`;
  }
  return null;
}

export function commandForLearning(action: LearningAction, args: Record<string, unknown>): Command {
  // node_create/activity_append 的 mapId 允许是批次内引用（{ $ref }），由 normalizeCommands 解析；
  // 修改已有对象的 targetId 必须是真实 ID。
  const mapId = args.mapId as string | { $ref: string };
  const mapTargetId = text(args.mapId);
  const nodeId = text(args.nodeId);
  if (action === 'map_create') {
    return { kind: 'learning.map.create', input: { title: text(args.title), goal: typeof args.goal === 'string' ? args.goal : '' } };
  }
  if (action === 'map_update') {
    const input: Record<string, unknown> = {};
    if (args.title !== undefined) input.title = args.title;
    if (args.goal !== undefined) input.goal = args.goal;
    if (args.status !== undefined) input.status = args.status;
    return { kind: 'learning.map.update', targetId: mapTargetId!, expectedRevision: Number(args.expectedRevision), input };
  }
  if (action === 'map_archive') {
    return { kind: 'learning.map.archive', targetId: mapTargetId!, expectedRevision: Number(args.expectedRevision), input: { ...(args.expectedNodeRevisions !== undefined ? { expectedNodeRevisions: args.expectedNodeRevisions } : {}) } };
  }
  if (action === 'node_create') {
    return {
      kind: 'learning.node.create',
      input: {
        mapId: mapId!,
        parentId: args.parentId === undefined ? null : args.parentId,
        kind: args.kind,
        title: text(args.title),
        detail: typeof args.detail === 'string' ? args.detail : '',
        sortOrder: typeof args.sortOrder === 'number' ? args.sortOrder : 0,
        ...(args.nodeStatus !== undefined ? { status: args.nodeStatus } : {}),
      },
    };
  }
  if (action === 'node_update') {
    const input: Record<string, unknown> = {};
    if (args.title !== undefined) input.title = args.title;
    if (args.detail !== undefined) input.detail = args.detail;
    if (args.nodeStatus !== undefined) input.status = args.nodeStatus;
    if (args.mastery !== undefined) input.mastery = args.mastery;
    if (args.sortOrder !== undefined) input.sortOrder = args.sortOrder;
    return { kind: 'learning.node.update', targetId: nodeId!, expectedRevision: Number(args.expectedNodeRevision), input };
  }
  if (action === 'node_move') {
    return { kind: 'learning.node.move', targetId: nodeId!, expectedRevision: Number(args.expectedNodeRevision), input: { parentId: args.parentId === undefined ? null : args.parentId } };
  }
  if (action === 'node_archive') {
    return { kind: 'learning.node.archive', targetId: nodeId!, expectedRevision: Number(args.expectedNodeRevision), input: { ...(args.cascade !== undefined ? { cascade: args.cascade } : {}), ...(args.expectedDescendantRevisions !== undefined ? { expectedDescendantRevisions: args.expectedDescendantRevisions } : {}) } };
  }
  return {
    kind: 'learning.activity.append',
    input: {
      mapId: mapId!,
      nodeId: args.nodeId === undefined ? null : args.nodeId,
      kind: args.kind,
      content: text(args.content),
      ...(args.meta !== undefined ? { meta: args.meta } : {}),
    },
  };
}
