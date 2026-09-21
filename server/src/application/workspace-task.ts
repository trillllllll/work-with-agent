import { randomUUID } from 'node:crypto';
import { Prisma, type Task } from '@prisma/client';
import { DomainError, Task as TaskDomain } from '../domain/task.js';
import { parseInput, taskCreateSchema, taskUpdateSchema, taskListSchema, reorderSchema, type TaskListOptions } from './workspace-input.js';
import { prisma, mutationTransaction, ChangeGroup, activeTopic, editableTask, nextOrder, normalizeContext, notFound, now, readTask, setTags, taskDto, taskInclude, validateTags, assignmentData, type Db, type MutationContext } from './workspace-store.js';

const rank = { none: 0, low: 1, medium: 2, high: 3 };
async function validateParent(tx: Db, parentId: string, taskId?: string) {
  if (parentId === taskId) throw new DomainError('INVALID_PARENT', '任务不能成为自己的子任务', 400);
  const parent = await editableTask(tx, parentId);
  if (parent.parentId) throw new DomainError('INVALID_PARENT', '只支持一级子任务', 400);
  if (taskId && await tx.task.count({ where: { parentId: taskId } })) throw new DomainError('INVALID_PARENT', '已有子任务的任务不能成为子任务', 400);
  return parent;
}
async function touchParent(group: ChangeGroup, id: string | null, reopen: boolean) {
  if (!id) return;
  const parent = await group.tx.task.findUnique({ where: { id } });
  if (parent) await group.task(id, reopen && parent.status === 'done' && !parent.deletedAt ? { status: 'todo' } : {});
}
async function orderScope(group: ChangeGroup, task: Pick<Task, 'topicId' | 'parentId'>) {
  await group.scope({ kind: 'order', topicId: task.topicId, parentId: task.parentId });
}
async function assignment(group: ChangeGroup, task: Pick<Task, 'id' | 'topicId'>, topicId: string | null, reason = topicId ? 'assigned' : 'unassigned') {
  if (task.topicId !== topicId) await group.tx.taskTopicAssignment.create({ data: assignmentData(task.id, task.topicId, topicId, reason, group.context) });
}
export class TaskService {
  async list(topicId?: string, options: TaskListOptions = {}, visibility?: Prisma.TaskWhereInput) {
    const query = parseInput(taskListSchema, options);
    if (query.dueFrom && query.dueTo && query.dueFrom > query.dueTo) throw new DomainError('INVALID_INPUT', '开始日期不能晚于结束日期', 400);
    const where: Prisma.TaskWhereInput = {
      ...(topicId ? { topicId } : {}),
      ...(query.inbox ? { topicId: null } : {}),
      ...(query.parentId !== undefined ? { parentId: query.parentId } : {}),
      ...(query.includeDeleted ? {} : { deletedAt: null }),
      ...(query.includeArchived ? {} : { OR: [{ topicId: null }, { topic: { archivedAt: null } }] }),
    };
    const and: Prisma.TaskWhereInput[] = [];
    if (visibility) and.push(visibility);
    if (query.q?.trim()) and.push({ OR: [{ title: { contains: query.q.trim() } }, { description: { contains: query.q.trim() } }] });
    if (query.status === 'open') where.status = { not: 'done' };
    else if (query.status && query.status !== 'all') where.status = query.status;
    if (query.dueFrom || query.dueTo) where.dueDate = { ...(query.dueFrom ? { gte: query.dueFrom } : {}), ...(query.dueTo ? { lte: query.dueTo } : {}) };
    for (const tagId of query.tagIds ?? []) and.push({ tags: { some: { tagId } } });
    if (and.length) where.AND = and;
    const tasks = (await prisma.task.findMany({ where, include: taskInclude, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })).map(taskDto);
    const sort = query.sort ?? (query.q || query.tagIds?.length || query.dueFrom || query.dueTo ? 'date' : 'manual');
    if (sort !== 'manual') tasks.sort((a, b) => {
      const date = (a.dueDate ?? '9999-99-99').localeCompare(b.dueDate ?? '9999-99-99');
      const priority = rank[b.priority] - rank[a.priority];
      return (sort === 'priority' ? priority || date : date || priority) || a.id.localeCompare(b.id);
    });
    return tasks;
  }

  async listDeleted() {
    return (await prisma.task.findMany({ where: { deletedAt: { not: null } }, include: taskInclude, orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }] })).map(taskDto);
  }

  async get(taskId: string, options: { includeDeleted?: boolean } = {}) {
    const task = await prisma.task.findFirst({ where: { id: taskId, ...(options.includeDeleted ? {} : { deletedAt: null }) }, include: { ...taskInclude, children: { where: { deletedAt: null }, include: taskInclude, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } } });
    return task ? { ...taskDto(task), children: task.children.map(taskDto) } : null;
  }

  async create(value: unknown, context: MutationContext | string = { source: 'user' }) {
    const input = parseInput(taskCreateSchema, value);
    if (input.status && input.status !== 'todo') throw new DomainError('INVALID_INITIAL_TASK_STATUS', '新任务必须从待办状态开始', 400);
    return mutationTransaction(context, async (tx) => {
      const group = new ChangeGroup(tx, normalizeContext(context));
      const parent = input.parentId ? await validateParent(tx, input.parentId) : null;
      const topicId = input.topicId === undefined ? parent?.topicId ?? null : input.topicId;
      if (parent && parent.topicId !== topicId) throw new DomainError('INVALID_PARENT', '父子任务必须属于同一清单', 400);
      await activeTopic(tx, topicId);
      await validateTags(tx, input.tagIds ?? []);
      const parentId = parent?.id ?? null;
      await orderScope(group, { topicId, parentId });
      if (parentId) await group.scope({ kind: 'children', id: parentId });
      const id = normalizeContext(context).entityId ?? randomUUID();
      await group.capture('tasks', id);
      const timestamp = now();
      const { tagIds, ...fields } = input;
      await tx.task.create({ data: { ...fields, id, topicId, parentId, status: 'todo', sortOrder: await nextOrder(tx, topicId, parentId), createdAt: timestamp, updatedAt: timestamp } });
      await setTags(tx, id, tagIds ?? []);
      await touchParent(group, parentId, true);
      if (topicId) await tx.taskTopicAssignment.create({ data: assignmentData(id, null, topicId, 'created', group.context) });
      const meta = await group.record('task', id, 'create');
      return { ...taskDto(await readTask(tx, id)), meta };
    });
  }

  async update(taskId: string, value: unknown, context: MutationContext | string = { source: 'user' }) {
    const input = parseInput(taskUpdateSchema, value);
    return mutationTransaction(context, async (tx) => {
      const group = new ChangeGroup(tx, normalizeContext(context));
      const before = await editableTask(tx, taskId);
      const task = TaskDomain.restore(before);
      if (input.status) task.transitionTo(input.status);
      let parentId = input.parentId === undefined ? before.parentId : input.parentId;
      let topicId = input.topicId === undefined ? before.topicId : input.topicId;
      // An explicitly chosen parent determines the destination unless a conflicting list was given.
      if (input.parentId) {
        const parent = await validateParent(tx, input.parentId, taskId);
        if (input.topicId !== undefined && parent.topicId !== input.topicId) throw new DomainError('INVALID_PARENT', '父子任务必须属于同一清单', 400);
        topicId = parent.topicId;
      } else if (parentId && topicId !== before.topicId) parentId = null;
      await activeTopic(tx, topicId);
      if (input.tagIds) await validateTags(tx, input.tagIds);
      const children = await tx.task.findMany({ where: { parentId: taskId } });
      const unfinished = children.filter((child) => !child.deletedAt && child.status !== 'done');
      if (input.status === 'done' && unfinished.length && !input.completeChildren) {
        throw Object.assign(new DomainError('SUBTASKS_INCOMPLETE', '还有未完成子任务，请确认一并完成'), { taskIds: unfinished.map((child) => child.id) });
      }
      const moved = topicId !== before.topicId || parentId !== before.parentId;
      if (moved) {
        await orderScope(group, before);
        await orderScope(group, { topicId, parentId });
        if (before.parentId) await group.scope({ kind: 'children', id: before.parentId });
        if (parentId) await group.scope({ kind: 'children', id: parentId });
      }
      if (children.length) await group.scope({ kind: 'children', id: taskId });
      const { tagIds, completeChildren: _completeChildren, ...fields } = input;
      await group.task(taskId, { ...fields, parentId, topicId, ...(moved ? { sortOrder: await nextOrder(tx, topicId, parentId) } : {}) });
      if (tagIds) await setTags(tx, taskId, tagIds);
      await assignment(group, before, topicId);
      if (topicId !== before.topicId) {
        await group.scope({ kind: 'order', topicId: before.topicId, parentId: taskId });
        await group.scope({ kind: 'order', topicId, parentId: taskId });
        for (const child of children) {
          await group.task(child.id, { topicId });
          await assignment(group, child, topicId, 'parent_moved');
        }
      }
      if (input.status === 'done') for (const child of unfinished) await group.task(child.id, { status: 'done' });
      if (before.parentId && before.parentId !== parentId) await touchParent(group, before.parentId, false);
      if (parentId) await touchParent(group, parentId, (input.status ?? before.status) !== 'done');
      const meta = await group.record('task', taskId, 'update');
      return { ...taskDto(await readTask(tx, taskId)), meta };
    });
  }

  async reorder(value: unknown, context: MutationContext = { source: 'user' }) {
    const input = parseInput(reorderSchema, value);
    return mutationTransaction(context, async (tx) => {
      await activeTopic(tx, input.topicId);
      if (input.parentId) {
        const parent = await validateParent(tx, input.parentId);
        if (parent.topicId !== input.topicId) throw new DomainError('INVALID_PARENT', '父子任务必须属于同一清单', 400);
      }
      const rows = await tx.task.findMany({ where: { topicId: input.topicId, parentId: input.parentId, deletedAt: null } });
      const ids = new Set(rows.map((row) => row.id));
      if (ids.size !== input.orderedTaskIds.length || input.orderedTaskIds.some((id) => !ids.has(id))) throw new DomainError('SORT_CONFLICT', '排序范围已变化，请刷新后重试');
      const group = new ChangeGroup(tx, context);
      await orderScope(group, input);
      for (const [index, id] of input.orderedTaskIds.entries()) await group.task(id, { sortOrder: index });
      await touchParent(group, input.parentId, false);
      const meta = await group.record('task', input.parentId ?? input.topicId ?? 'inbox', 'reorder');
      return { orderedTaskIds: input.orderedTaskIds, meta };
    });
  }

  async remove(taskId: string, context: MutationContext | string = { source: 'user' }) { return this.softDelete(taskId, normalizeContext(context)); }

  async softDelete(taskId: string, context: MutationContext = { source: 'user' }) {
    return mutationTransaction(context, async (tx) => {
      const task = await editableTask(tx, taskId);
      const group = new ChangeGroup(tx, context);
      const children = await tx.task.findMany({ where: { parentId: taskId, deletedAt: null } });
      await group.scope({ kind: 'children', id: taskId });
      const timestamp = now();
      const deleteBatchId = randomUUID();
      for (const member of [task, ...children]) {
        await orderScope(group, member);
        await group.task(member.id, { deletedAt: timestamp, deleteBatchId });
      }
      await touchParent(group, task.parentId, false);
      const meta = await group.record('task', taskId, 'delete');
      return { ...taskDto(await readTask(tx, taskId)), meta };
    });
  }

  async restore(taskId: string, context: MutationContext = { source: 'user' }) {
    return mutationTransaction(context, async (tx) => {
      const task = await tx.task.findUnique({ where: { id: taskId }, include: taskInclude });
      if (!task || !task.deletedAt) throw new DomainError('TASK_NOT_DELETED', '任务不在回收站');
      const group = new ChangeGroup(tx, context);
      const warnings: string[] = [];
      let topicId = task.topicId;
      if (topicId && (!task.topic || task.topic.archivedAt)) {
        if (task.topic?.archivedAt) {
          // Restoring from an archived list explicitly changes its membership. Keep
          // the unchanged list version and full scope so undo can safely return the
          // task family to its original trash without bypassing later list edits.
          await group.capture('topics', topicId);
          await group.scope({ kind: 'topic', id: topicId });
        }
        topicId = null;
        warnings.push('原清单不可用，任务已恢复到收集箱');
      }
      let parentId = task.parentId;
      if (parentId) {
        const parent = await tx.task.findUnique({ where: { id: parentId }, include: { topic: true } });
        if (!parent || parent.deletedAt || parent.parentId || parent.topic?.archivedAt || parent.topicId !== topicId) {
          parentId = null;
          warnings.push('原父任务不可用，已解除父子关系');
        }
        await group.scope({ kind: 'children', id: task.parentId! });
      }
      const children = await tx.task.findMany({ where: { parentId: taskId } });
      await group.scope({ kind: 'children', id: taskId });
      const restoreIds = new Set([taskId, ...children.filter((child) => child.deletedAt && task.deleteBatchId && child.deleteBatchId === task.deleteBatchId).map((child) => child.id)]);
      await orderScope(group, { topicId, parentId });
      await group.task(taskId, { deletedAt: null, deleteBatchId: null, parentId, topicId, sortOrder: await nextOrder(tx, topicId, parentId) });
      await assignment(group, task, topicId, 'restored');
      for (const child of children) {
        // Deleted children stay deleted, but a moved parent must still retain valid ownership.
        const restoring = restoreIds.has(child.id);
        if (restoring) await orderScope(group, { topicId, parentId: taskId });
        if (restoring || child.topicId !== topicId) {
          await group.task(child.id, { topicId, ...(restoring ? { deletedAt: null, deleteBatchId: null, sortOrder: await nextOrder(tx, topicId, taskId) } : {}) });
          await assignment(group, child, topicId, 'restored');
        }
      }
      if (task.status === 'done' && children.some((child) => restoreIds.has(child.id) && child.status !== 'done')) await group.task(taskId, { status: 'todo' });
      await touchParent(group, task.parentId && task.parentId !== parentId ? task.parentId : null, false);
      await touchParent(group, parentId, task.status !== 'done');
      const meta = { ...await group.record('task', taskId, 'restore'), ...(warnings.length ? { warnings } : {}) };
      return { ...taskDto(await readTask(tx, taskId)), meta };
    });
  }

  async permanentDelete(taskId: string, context: MutationContext = { source: 'user' }) {
    return mutationTransaction(context, async (tx) => {
      const task = await tx.task.findUnique({ where: { id: taskId }, include: taskInclude });
      if (!task || !task.deletedAt) throw new DomainError('TASK_NOT_DELETED', '任务不在回收站');
      await activeTopic(tx, task.topicId);
      const children = await tx.task.findMany({ where: { parentId: taskId } });
      if (children.some((child) => !child.deletedAt)) throw new DomainError('TASK_HAS_ACTIVE_CHILDREN', '仍有未删除子任务，不能永久删除');
      const group = new ChangeGroup(tx, context);
      await group.scope({ kind: 'children', id: taskId });
      for (const member of [...children, task]) {
        await group.capture('tasks', member.id);
        await tx.task.delete({ where: { id: member.id } });
      }
      await touchParent(group, task.parentId, false);
      const meta = await group.record('task', taskId, 'permanent_delete');
      return { ...taskDto(task), meta };
    });
  }

  async topicHistory(taskId: string) {
    if (!await prisma.task.findUnique({ where: { id: taskId } })) throw notFound('任务不存在');
    return prisma.taskTopicAssignment.findMany({ where: { taskId }, include: { fromTopic: { select: { id: true, name: true } }, toTopic: { select: { id: true, name: true } } }, orderBy: { changedAt: 'asc' } });
  }
}
