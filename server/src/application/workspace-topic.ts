import { randomUUID } from 'node:crypto';
import { Topic as TopicDomain } from '../domain/topic.js';
import { DomainError } from '../domain/task.js';
import { parseInput, topicCreateSchema, topicUpdateSchema, tagSchema } from './workspace-input.js';
import { prisma, mutationTransaction, ChangeGroup, activeTopic, nextOrder, normalizeContext, notFound, now, taskDto, taskInclude, assignmentData, type MutationContext } from './workspace-store.js';

export class TopicService {
  async list(options: { archived?: boolean } = {}) {
    return prisma.topic.findMany({ where: { archivedAt: options.archived ? { not: null } : null }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] });
  }

  async get(topicId: string, options: { includeArchived?: boolean } = {}) {
    const topic = await prisma.topic.findFirst({ where: { id: topicId, ...(options.includeArchived ? {} : { archivedAt: null }) }, include: { tasks: { where: { deletedAt: null }, include: taskInclude, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } } });
    return topic ? { ...topic, tasks: topic.tasks.map(taskDto) } : null;
  }

  async create(value: unknown, context: MutationContext | string = { source: 'user' }) {
    const input = parseInput(topicCreateSchema, value);
    return mutationTransaction(context, async (tx) => {
      const group = new ChangeGroup(tx, normalizeContext(context));
      const id = normalizeContext(context).entityId ?? randomUUID();
      await group.capture('topics', id);
      await group.scope({ kind: 'topic', id });
      const timestamp = now();
      const result = await tx.topic.create({ data: { ...input, id, createdAt: timestamp, updatedAt: timestamp } });
      const meta = await group.record('topic', id, 'create');
      return { ...result, meta };
    });
  }

  async update(topicId: string, value: unknown, context: MutationContext | string = { source: 'user' }) {
    const input = parseInput(topicUpdateSchema, value);
    return mutationTransaction(context, async (tx) => {
      const before = await activeTopic(tx, topicId);
      if (!before) throw notFound('清单不存在');
      const group = new ChangeGroup(tx, normalizeContext(context));
      const data = { ...input };
      if (input.draftSummary !== undefined) {
        const topic = TopicDomain.restore(before);
        if (input.draftSummary) topic.proposeSummary(input.draftSummary);
        else topic.discardSummary();
        Object.assign(data, topic.summaryState(), { summaryUpdatedAt: now() });
      }
      const result = await group.topic(topicId, data);
      return { ...result, meta: await group.record('topic', topicId, 'update') };
    });
  }

  /** Compatibility: the old delete contract archives and empties the list. */
  async remove(topicId: string, context: MutationContext | string = { source: 'user' }) {
    return mutationTransaction(context, async (tx) => {
      await activeTopic(tx, topicId);
      const group = new ChangeGroup(tx, normalizeContext(context));
      await this.moveAllToInbox(group, topicId, 'topic_archived');
      const result = await group.topic(topicId, { archivedAt: now() });
      return { ...result, meta: await group.record('topic', topicId, 'archive') };
    });
  }

  async archive(topicId: string, context: MutationContext = { source: 'user' }) {
    return mutationTransaction(context, async (tx) => {
      await activeTopic(tx, topicId);
      const group = new ChangeGroup(tx, context);
      await group.scope({ kind: 'topic', id: topicId });
      const result = await group.topic(topicId, { archivedAt: now() });
      return { ...result, meta: await group.record('topic', topicId, 'archive_preserve') };
    });
  }

  async restore(topicId: string, context: MutationContext = { source: 'user' }) {
    return mutationTransaction(context, async (tx) => {
      const before = await tx.topic.findUnique({ where: { id: topicId } });
      if (!before) throw notFound('清单不存在');
      if (!before.archivedAt) throw new DomainError('TOPIC_NOT_ARCHIVED', '清单未归档');
      const group = new ChangeGroup(tx, context);
      await group.scope({ kind: 'topic', id: topicId });
      const result = await group.topic(topicId, { archivedAt: null });
      return { ...result, meta: await group.record('topic', topicId, 'restore') };
    });
  }

  async moveTasksToInbox(topicId: string, context: MutationContext = { source: 'user' }) {
    return mutationTransaction(context, async (tx) => {
      if (!await tx.topic.findUnique({ where: { id: topicId } })) throw notFound('清单不存在');
      const group = new ChangeGroup(tx, context);
      await this.moveAllToInbox(group, topicId, 'moved_to_inbox');
      const result = await group.topic(topicId);
      return { ...result, meta: await group.record('topic', topicId, 'move_tasks_to_inbox') };
    });
  }

  private async moveAllToInbox(group: ChangeGroup, topicId: string, reason: string) {
    const tasks = await group.tx.task.findMany({ where: { topicId }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    await group.scope({ kind: 'topic', id: topicId });
    // Capture both complete ordering scopes before the first move.
    for (const task of tasks) {
      await group.scope({ kind: 'order', topicId, parentId: task.parentId });
      await group.scope({ kind: 'order', topicId: null, parentId: task.parentId });
      if (!task.parentId) await group.scope({ kind: 'children', id: task.id });
    }
    for (const task of tasks) {
      await group.task(task.id, { topicId: null, ...(!task.deletedAt ? { sortOrder: await nextOrder(group.tx, null, task.parentId) } : {}) });
      await group.tx.taskTopicAssignment.create({ data: assignmentData(task.id, topicId, null, reason, group.context) });
    }
  }

  async generateSummary(topicId: string, summary: string, context: MutationContext = { source: 'agent' }) {
    if (typeof summary !== 'string' || !summary.trim()) throw new DomainError('TOPIC_SUMMARY_EMPTY', '成果草稿不能为空', 400);
    return this.update(topicId, { draftSummary: summary.trim() }, context);
  }
  async confirmSummary(topicId: string, context: MutationContext = { source: 'user' }) { return this.changeSummary(topicId, true, context); }
  async discardSummary(topicId: string, context: MutationContext = { source: 'user' }) { return this.changeSummary(topicId, false, context); }
  private async changeSummary(topicId: string, confirm: boolean, context: MutationContext) {
    return mutationTransaction(context, async (tx) => {
      const before = await activeTopic(tx, topicId);
      if (!before) throw notFound('清单不存在');
      const topic = TopicDomain.restore(before);
      if (confirm) topic.confirmSummary(); else topic.discardSummary();
      const group = new ChangeGroup(tx, context);
      const result = await group.topic(topicId, { ...topic.summaryState(), summaryUpdatedAt: now() });
      return { ...result, meta: await group.record('topic', topicId, confirm ? 'confirm_summary' : 'discard_summary') };
    });
  }
}
export class TagService {
  async list() { return prisma.tag.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] }); }

  async create(value: unknown, context: MutationContext = { source: 'user' }) {
    const input = parseInput(tagSchema, value);
    return mutationTransaction(context, async (tx) => {
      const group = new ChangeGroup(tx, context);
      const id = normalizeContext(context).entityId ?? randomUUID();
      await group.capture('tags', id);
      await group.scope({ kind: 'tag', id });
      const timestamp = now();
      const result = await tx.tag.create({ data: { ...input, id, createdAt: timestamp, updatedAt: timestamp } });
      return { ...result, meta: await group.record('tag', id, 'create') };
    });
  }

  async update(id: string, value: unknown, context: MutationContext = { source: 'user' }) {
    const input = parseInput(tagSchema, value);
    return mutationTransaction(context, async (tx) => {
      if (!await tx.tag.findUnique({ where: { id } })) throw notFound('标签不存在');
      const group = new ChangeGroup(tx, context);
      const result = await group.tag(id, input);
      return { ...result, meta: await group.record('tag', id, 'update') };
    });
  }

  async remove(id: string, context: MutationContext = { source: 'user' }) {
    return mutationTransaction(context, async (tx) => {
      const tag = await tx.tag.findUnique({ where: { id } });
      if (!tag) throw notFound('标签不存在');
      const group = new ChangeGroup(tx, context);
      await group.capture('tags', id);
      await group.scope({ kind: 'tag', id });
      const links = await tx.taskTag.findMany({ where: { tagId: id } });
      if (await tx.task.count({ where: { id: { in: links.map((link) => link.taskId) }, topic: { archivedAt: { not: null } } } })) {
        throw new DomainError('TOPIC_ARCHIVED', '此标签用于已归档清单，请先恢复清单再删除标签');
      }
      for (const link of links) await group.task(link.taskId);
      await tx.tag.delete({ where: { id } });
      return { ...tag, meta: await group.record('tag', id, 'delete') };
    });
  }
}
