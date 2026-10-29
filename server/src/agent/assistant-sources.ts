import { withChatAttachments } from '../application/chat-attachments.js';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { ownerActor, assertTopicAccess } from '../application/security.js';
import { appKnowledge, applicationVersion } from './app-knowledge.js';
import { readPracticeItem } from '../application/learning-practice/read.js';
export const sourceReadTools = new Set(['read_app_knowledge', 'query_tasks', 'get_task_activity', 'search_workspace', 'library_read', 'memory_read', 'conversation_search', 'learning_read']);
export type { AssistantSource } from '../domain/assistant-source.js';
import type { AssistantSource } from '../domain/assistant-source.js';
export async function resolveAssistantSource(kind: string, id: string, revision?: number) {
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) throw new DomainError('INVALID_SOURCE', '来源版本无效', 400);
  if (kind === 'help') {
    const item = appKnowledge.find((item) => item.id === id);
    if (item) return { kind, id, title: item.title, content: `应用版本 ${applicationVersion}\n\n${item.content}` };
  }
  if (kind === 'task') {
    const row = await prisma.task.findUnique({ where: { id } });
    if (row && !row.deletedAt) { assertTopicAccess(ownerActor, row.topicId); return { kind, id, title: row.title, topicId: row.topicId, content: row.description }; }
  }
  if (kind === 'material') {
    const row = await prisma.material.findUnique({ where: { id } });
    if (row) {
      assertTopicAccess(ownerActor, row.topicId);
      const version = await prisma.materialVersion.findUnique({ where: { materialId_revision: { materialId: id, revision: revision ?? row.revision } } });
      if (version) return { kind, id, title: row.title, topicId: row.topicId, revision: version.revision, content: version.content };
    }
  }
  if (kind === 'memory') {
    const row = await prisma.memory.findUnique({ where: { id } });
    if (row) {
      assertTopicAccess(ownerActor, row.topicId);
      const version = revision && revision !== row.revision ? await prisma.memoryVersion.findUnique({ where: { memoryId_revision: { memoryId: id, revision } } }) : row;
      if (version) return { kind, id, title: version.title, topicId: row.topicId, revision: version.revision, content: version.content };
    }
  }
  if (kind === 'learning_node' || kind === 'learning_map') {
    const row = kind === 'learning_node' ? await prisma.learningNode.findUnique({ where: { id } }) : await prisma.learningMap.findUnique({ where: { id } });
    const map = kind === 'learning_node' && row ? await prisma.learningMap.findUnique({ where: { id: (row as { mapId: string }).mapId } }) : row;
    if (row && !row.deletedAt && map && !map.deletedAt && (revision === undefined || revision === row.revision)) return { kind, id, title: row.title, revision: row.revision, content: `# ${row.title}\n\n状态：${row.status}\n\n${'detail' in row ? row.detail : row.goal}` };
  }
  if (kind === 'learning_item') {
    const item = await readPracticeItem(id);
    // A citation identifies the frozen public question, never the private answer,
    // rubric, live draft or model job input, even after the learner has submitted.
    return { kind, id, title: item.question.objective || item.question.prompt.slice(0, 100), content: [
      item.question.prompt,
      ...item.question.options.map(option => `${option.id}. ${option.text}`),
      `来源：${item.question.source.label}`,
    ].join('\n\n'), questionVersionId: item.question.versionId };
  }
  if (kind === 'conversation') {
    const row = await prisma.message.findUnique({ where: { id } });
    if (row && ['user', 'assistant'].includes(row.role)) {
      const content = (await withChatAttachments([row]))[0].content;
      const title = content.replace(/[#*`>\[\]\n\r]+/g, ' ').trim().slice(0, 60) || '历史对话';
      return { kind, id, title, createdAt: row.createdAt, content, conversationId: row.conversationId };
    }
  }
  throw new DomainError('NOT_FOUND', '来源已删除、不可访问或版本不存在', 404);
}
export async function sourcesFromTool(name: string, args: Record<string, unknown>, result: { success: boolean; data?: unknown }): Promise<AssistantSource[]> {
  if (!result.success || !result.data || typeof result.data !== 'object') return [];
  const data = result.data as Record<string, any>;
  const candidates: Array<{ kind: AssistantSource['kind']; id: string; revision?: number }> = [];
  const add = (kind: AssistantSource['kind'], id: unknown, revision?: unknown) => { if (typeof id === 'string') candidates.push({ kind, id, ...(typeof revision === 'number' ? { revision } : {}) }); };
  if (name === 'read_app_knowledge') for (const row of data.items ?? []) add('help', row.id);
  if (name === 'get_task_activity') add('task', args.taskId);
  if (name === 'query_tasks') {
    if (args.action === 'get') add('task', data.id);
    if (args.action === 'list') for (const row of data.items ?? []) add('task', row.id);
  }
  if (name === 'search_workspace') for (const row of data.items ?? []) if (['task', 'material', 'memory', 'conversation'].includes(row.type)) add(row.type, row.id, ['memory', 'material'].includes(row.type) ? row.revision : undefined);
  if (name === 'library_read') {
    if (args.action === 'linked_tasks') for (const row of data.items ?? []) add('task', row.id);

    if (['read', 'content'].includes(String(args.action))) add('material', args.materialId, data.viewedRevision ?? data.revision ?? args.revision);
    if (['list', 'search', 'task_materials'].includes(String(args.action))) for (const row of data.items ?? []) add('material', row.id, row.revision);
  }
  if (name === 'memory_read') {
    if (args.action === 'read') add('memory', data.id, data.revision);
    for (const row of data.matches ?? data.memories ?? data.items ?? []) add('memory', row.id, row.revision);
  }
  if (name === 'learning_read') {
    if (args.action === 'practice_item') add('learning_item', args.itemId);
    if (args.action === 'practice_session') for (const item of data.items ?? []) add('learning_item', item.id);
    if (args.action === 'practice_history') for (const item of data.items ?? []) add('learning_item', item.itemId);
    if (args.action === 'search') for (const node of data.items ?? []) add('learning_node', node.id, node.revision);
    if (args.action === 'node') add('learning_node', args.nodeId, data.node?.revision);
    if (args.action === 'get') {
      if (data.map?.goal) add('learning_map', args.mapId, data.map?.revision);
      const pending = [...(data.tree ?? [])];
      while (pending.length && candidates.length < 30) {
        const node = pending.shift(); add('learning_node', node?.id, node?.revision);
        if (Array.isArray(node?.children)) pending.push(...node.children);
      }
    }
  }
  if (name === 'conversation_search') for (const row of data.messages ?? data.matches ?? []) add('conversation', row.messageId);
  const sources: AssistantSource[] = [];
  const seen = new Set<string>();
  for (const item of candidates.slice(0, 30)) {
    const key = `${item.kind}:${item.id}:${item.revision ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try { const resolved = await resolveAssistantSource(item.kind, item.id, item.revision); sources.push({ ...item, title: resolved.title, ...('createdAt' in resolved && resolved.createdAt ? { createdAt: resolved.createdAt } : {}) }); }
    catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
  }
  return sources;
}
