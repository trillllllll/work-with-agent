import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { DomainError } from '../domain/task.js';
import { prisma } from '../infrastructure/prisma.js';
import { CommandService, type Command } from './commands.js';
import { libraryFiltersSchema, type LibraryFilters } from './library/schema.js';
import { LibraryService } from './library/service.js';
import { codePointLength } from './library/text.js';
import { internalActor, ownerActor } from './security.js';
import { readResourceDocument } from './resources/agent-read.js';
import { createResourceSchema, saveResourceSchema } from './resources/service.js';

const READ_ACTIONS = ['list', 'search', 'read', 'document', 'content', 'linked_tasks', 'task_materials', 'folders', 'tags', 'ask'] as const;
const WRITE_ACTIONS = ['create', 'update', 'document_create', 'document_save', 'archive', 'organize', 'links', 'reextract', 'folder_create', 'folder_update', 'folder_delete', 'tag_create', 'tag_update', 'tag_delete', 'reference', 'undo'] as const;
const ACTIONS = [...READ_ACTIONS, ...WRITE_ACTIONS] as const;
const KINDS = ['text', 'markdown', 'link', 'thread', 'attachment'] as const;
const CREATE_KINDS = ['text', 'markdown', 'link', 'thread'] as const;
const COMPLETENESS = ['full', 'excerpt', 'summary'] as const;
const TEXT_CLIP = 200;
const CONTENT_CLIP = 240;
const CONTENT_PAGE = 40;
const LIST_PAGE = 20;

type LibraryAction = (typeof ACTIONS)[number];
export type AgentLibraryContext = { conversationId?: string; approvalId?: string };
type ToolPayload = { success: boolean; data?: unknown; error?: string; code?: string };

const failure = (code: string, message: string, status = 400) => new DomainError(code, message, status);
const library = new LibraryService();

const allowedKeys: Record<LibraryAction, string[]> = {
  list: ['action', 'folderId', 'recursive', 'tagIds', 'taskId', 'taskTopicId', 'kind', 'archived', 'view', 'cursor', 'limit'],
  search: ['action', 'q', 'folderId', 'recursive', 'tagIds', 'taskId', 'taskTopicId', 'kind', 'archived', 'view', 'cursor', 'limit'],
  read: ['action', 'materialId'],
  content: ['action', 'materialId', 'revision', 'cursor', 'limit'],
  document: ['action', 'materialId', 'revision', 'cursor', 'limit'],
  linked_tasks: ['action', 'materialId', 'cursor', 'limit'],
  task_materials: ['action', 'taskId', 'archived', 'cursor', 'limit'],
  folders: ['action'],
  tags: ['action'],
  ask: ['action', 'question', 'folderId', 'recursive', 'tagIds', 'taskId', 'taskTopicId', 'kind', 'archived', 'view'],
  create: ['action', 'topicId', 'kind', 'title', 'content', 'uri', 'metadata'],
  update: ['action', 'materialId', 'revision', 'title', 'content', 'uri', 'taskId', 'reason', 'metadata'],
  document_create: ['action', 'topicId', 'folderId', 'title', 'format', 'schemaVersion', 'document', 'content', 'relativeReferences'],
  document_save: ['action', 'materialId', 'revision', 'format', 'schemaVersion', 'document', 'content', 'relativeReferences'],
  archive: ['action', 'materialId', 'revision', 'archived'],
  organize: ['action', 'materialId', 'revision', 'organizationRevision', 'folderId', 'tagIds'],
  links: ['action', 'materialId', 'revision', 'organizationRevision', 'addTaskIds', 'removeTaskIds', 'removeInlineReferences', 'expectedTaskRevisions'],
  reextract: ['action', 'materialId', 'revision'],
  folder_create: ['action', 'parentId', 'name'],
  folder_update: ['action', 'folderId', 'revision', 'parentId', 'name'],
  folder_delete: ['action', 'folderId', 'revision'],
  tag_create: ['action', 'name'],
  tag_update: ['action', 'tagId', 'revision', 'name'],
  tag_delete: ['action', 'tagId', 'revision'],
  reference: ['action', 'taskId', 'revision', 'materialIds', 'from', 'to', 'expectedMaterialRevisions', 'expectedOrganizationRevisions'],
  undo: ['action', 'changeId'],
};

export const LIBRARY_TOOL_DESCRIPTION = '查和改项目资料。list、search、read、document、content、linked_tasks、task_materials、folders、tags、ask 立即返回。create、update、document_create、document_save、archive、organize、links、reextract、folder_create、folder_update、folder_delete、tag_create、tag_update、tag_delete、reference、undo 只生成待确认，不会立刻改数据。create 只接受 text、markdown、link、thread。上传文件不在工具里，要加文件时告诉用户到项目资料里添加。改已有资料前先 read，并带上刚才读到的 revision；organize 和 links 还要带 organizationRevision。search 搜文件名、标题、标签和提取正文。ask 按现有资料回答；模型没配置时返回模型不可用。undo 使用变更记录 id。memory 只记稳定事实，不要把资料正文抄进记忆。';

const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const stringArray = { type: 'array', items: { type: 'string' } };
const revisionField = { type: 'number', description: '刚才 read 到的版本' };

export const libraryToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: [...ACTIONS], description: '读操作立即返回；写操作等待用户确认' },
    materialId: string,
    taskId: string,
    folderId: { ...nullableString, description: '列出时可传 unfiled；整理时 null 表示移出文件夹' },
    tagId: string,
    parentId: { ...nullableString, description: '新建或移动文件夹时的父文件夹，null 表示顶层' },
    changeId: { type: 'string', description: '要撤销的变更记录 id' },
    revision: revisionField,
    organizationRevision: { type: 'number', description: '刚才 read 到的整理版本' },
    title: string,
    content: string,
    document: { type: 'object', description: 'Complete richdoc-v1 product JSON; schemaVersion=1 and stable blocks. Do not supply extracted text.' },
    format: { type: 'string', enum: ['richdoc-v1', 'markdown', 'text'] },
    schemaVersion: { type: ['number', 'null'] },
    relativeReferences: { type: 'array', items: { type: 'object', required: ['path', 'resourceId', 'revision'], properties: { path: string, resourceId: string, revision: revisionField } } },
    uri: string,
    reason: string,
    question: string,
    q: { type: 'string', description: '搜索文件名、标题、标签和提取正文' },
    name: string,
    kind: { type: 'string', enum: [...KINDS], description: 'create 不能用 attachment' },
    topicId: nullableString,
    metadata: { type: 'object', description: '会话资料必须包含 completeness：full、excerpt 或 summary' },
    tagIds: stringArray,
    addTaskIds: stringArray,
    removeTaskIds: stringArray,
    materialIds: stringArray,
    removeInlineReferences: { type: 'boolean', description: '任务正文仍引用时，解除关联必须为 true' },
    archived: { description: 'archive 用布尔值；列出时用 exclude、only 或 include' },
    recursive: { type: 'boolean' },
    taskTopicId: { type: 'string', description: '任务所属清单，inbox 表示收集箱' },
    view: { type: 'string', enum: ['all', 'recent', 'unfiled', 'archived'] },
    cursor: { type: 'number' },
    limit: { type: 'number', description: '最多 40' },
    from: { type: 'number', description: '插入引用的起始位置' },
    to: { type: 'number', description: '插入引用的结束位置' },
    expectedTaskRevisions: { type: 'object' },
    expectedMaterialRevisions: { type: 'object' },
    expectedOrganizationRevisions: { type: 'object' },
  },
};

export function isLibraryReadAction(action: unknown) {
  return typeof action === 'string' && (READ_ACTIONS as readonly string[]).includes(action);
}

function clip(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function httpUrl(value: unknown) {
  const uri = text(value);
  if (!uri || uri.length > 4000) return false;
  try { return ['http:', 'https:'].includes(new URL(uri).protocol); }
  catch { return false; }
}

function integer(value: unknown, min: number) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

function idList(value: unknown, max: number) {
  if (!Array.isArray(value) || value.length > max) return null;
  const items = value.map((item) => (typeof item === 'string' ? item.trim() : ''));
  if (items.some((item) => !item || item.length > 80)) return null;
  return items;
}

function revisionMap(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 50) return null;
  const mapped: Record<string, number> = {};
  for (const [key, revision] of entries) {
    if (!key.trim() || key.length > 80 || !integer(revision, 1)) return null;
    mapped[key] = revision as number;
  }
  return mapped;
}

function metadataOf(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (JSON.stringify(value).length > 32_000) return undefined;
  return value as Record<string, unknown>;
}

function paging(args: Record<string, unknown>, fallback: number) {
  const cursor = args.cursor === undefined ? 0 : args.cursor;
  const limit = args.limit === undefined ? fallback : args.limit;
  if (!integer(cursor, 0) || !integer(limit, 1) || Number(limit) > CONTENT_PAGE) return null;
  return { cursor: Number(cursor), limit: Number(limit) };
}

function filtersFrom(args: Record<string, unknown>): LibraryFilters {
  const archived = args.archived;
  return libraryFiltersSchema.parse({
    ...(typeof args.folderId === 'string' ? { folderId: args.folderId } : {}),
    ...(typeof args.recursive === 'boolean' ? { recursive: args.recursive } : {}),
    ...(Array.isArray(args.tagIds) ? { tagIds: args.tagIds } : {}),
    ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
    ...(typeof args.taskTopicId === 'string' ? { taskTopicId: args.taskTopicId } : {}),
    ...(typeof args.kind === 'string' ? { kind: args.kind } : {}),
    ...(typeof archived === 'string' ? { archived } : {}),
    ...(typeof args.view === 'string' ? { view: args.view } : {}),
  });
}

function requireId(args: Record<string, unknown>, key: string, label: string) {
  const value = text(args[key]);
  if (!value || value.length > 80) return `${label}无效`;
  return null;
}

function requireRevision(args: Record<string, unknown>, key: string, label: string) {
  if (!integer(args[key], 1)) return `需要${label}`;
  return null;
}

export function validateLibraryArguments(args: Record<string, unknown>) {
  const action = args.action;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) return '未知动作';
  const unknown = Object.keys(args).find((key) => !allowedKeys[action as LibraryAction].includes(key));
  if (unknown) return `未知参数: ${unknown}`;
  if (action === 'document_create' || action === 'document_save') {
    if (args.document !== undefined && args.content !== undefined) return 'document and content are mutually exclusive';
    const input = { requestId: 'validation', format: args.format, schemaVersion: args.schemaVersion, content: args.document ?? args.content, relativeReferences: args.relativeReferences };
    const result = action === 'document_create'
      ? createResourceSchema.safeParse({ ...input, title: args.title, topicId: args.topicId, folderId: args.folderId })
      : saveResourceSchema.safeParse({ ...input, expectedRevision: args.revision });
    if (!result.success) return result.error.issues.map((issue) => issue.message).join('; ');
    if (action === 'document_save' && !text(args.materialId)) return 'materialId is required';
    return null;
  }
  if (action === 'document') {
    if (!text(args.materialId) || !integer(args.revision, 1)) return 'materialId and revision are required';
    if (args.cursor !== undefined && !integer(Number(args.cursor), 0)) return 'cursor is invalid';
    if (args.limit !== undefined && (!integer(args.limit, 1) || Number(args.limit) > 20000)) return 'limit must be between 1 and 20000';
    return null;
  }
  if (args.cursor !== undefined && !integer(args.cursor, 0)) return 'cursor 无效';
  if (args.limit !== undefined && (!integer(args.limit, 1) || Number(args.limit) > CONTENT_PAGE)) return 'limit 必须是 1 到 40 的整数';
  if (args.tagIds !== undefined && !idList(args.tagIds, 50)) return 'tagIds 无效';
  if (typeof args.archived === 'string' && !['exclude', 'only', 'include'].includes(args.archived)) return 'archived 的值无效';
  if (action === 'search' && (typeof args.q !== 'string' || args.q.trim().length < 1 || args.q.trim().length > 200)) return '搜索需要 1 到 200 个字符';
  if (action === 'ask') {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    const length = codePointLength(question);
    if (length < 1 || length > 2000) return '问题需要 1 到 2000 个字符';
  }
  if (['read', 'content', 'linked_tasks', 'update', 'archive', 'organize', 'links', 'reextract'].includes(action)) {
    const id = requireId(args, 'materialId', 'materialId ');
    if (id) return id;
  }
  if (['task_materials', 'reference'].includes(action)) {
    const id = requireId(args, 'taskId', 'taskId ');
    if (id) return id;
  }
  if (['content', 'update', 'archive', 'organize', 'links', 'reextract', 'folder_update', 'folder_delete', 'tag_update', 'tag_delete', 'reference'].includes(action)) {
    const revision = requireRevision(args, 'revision', '刚才读到的 revision');
    if (revision) return revision;
  }
  if (action === 'organize' || action === 'links') {
    const revision = requireRevision(args, 'organizationRevision', '刚才读到的 organizationRevision');
    if (revision) return revision;
  }
  if (action === 'create') {
    if (!CREATE_KINDS.includes(args.kind as (typeof CREATE_KINDS)[number])) return args.kind === 'attachment' ? '创建资料不接受附件，请到项目资料里添加文件' : 'create 的类型无效';
    const title = text(args.title);
    if (!title || title.length > 300) return '标题需要 1 到 300 个字符';
    if (args.content !== undefined && (typeof args.content !== 'string' || args.content.length > 500_000)) return '正文不能超过 500000 字';
    if (args.uri !== undefined && (typeof args.uri !== 'string' || args.uri.length > 4000)) return '链接无效';
    if (args.metadata !== undefined && !metadataOf(args.metadata)) return 'metadata 无效';
    if (args.kind === 'link' && !httpUrl(args.uri)) return '链接资料需要网址';
    if (args.kind === 'thread') {
      const metadata = metadataOf(args.metadata);
      if (!metadata || !COMPLETENESS.includes(String(metadata.completeness) as (typeof COMPLETENESS)[number])) return '会话必须标明 full、excerpt 或 summary';
      if (!text(args.content)) return '会话内容不能为空';
    }
  }
  if (action === 'update') {
    if (args.title !== undefined && (!text(args.title) || text(args.title).length > 300)) return '标题需要 1 到 300 个字符';
    if (args.content !== undefined && (typeof args.content !== 'string' || args.content.length > 500_000)) return '正文不能超过 500000 字';
    if (args.uri !== undefined && args.uri !== null && (typeof args.uri !== 'string' || args.uri.length > 4000)) return '链接无效';
    if (args.taskId !== undefined && args.taskId !== null && !text(args.taskId)) return 'taskId 无效';
    if (args.reason !== undefined && (typeof args.reason !== 'string' || args.reason.length > 1000)) return '原因不能超过 1000 字';
    if (args.metadata !== undefined && !metadataOf(args.metadata)) return 'metadata 无效';
    if (args.title === undefined && args.content === undefined && args.uri === undefined && args.taskId === undefined && args.metadata === undefined) return 'update 需要标题、正文、链接、任务或元信息';
  }
  if (action === 'archive' && typeof args.archived !== 'boolean') return 'archive 需要 archived 布尔值';
  if (action === 'organize' && args.folderId === undefined && args.tagIds === undefined) return 'organize 需要 folderId 或 tagIds';
  if (action === 'organize' && args.folderId !== undefined && args.folderId !== null && !text(args.folderId)) return 'folderId 无效';
  if (action === 'links') {
    const add = idList(args.addTaskIds ?? [], 50);
    const remove = idList(args.removeTaskIds ?? [], 50);
    if (!add || !remove) return '任务 id 无效';
    if (!add.length && !remove.length) return 'links 需要要关联或解除的任务';
    if (typeof args.removeInlineReferences !== 'boolean') return 'links 需要 removeInlineReferences';
    if (args.expectedTaskRevisions !== undefined && !revisionMap(args.expectedTaskRevisions)) return 'expectedTaskRevisions 无效';
  }
  if (action === 'folder_create' || action === 'folder_update') {
    if (action === 'folder_create' && args.parentId !== null && !text(args.parentId)) return 'parentId 无效';
    if (action === 'folder_update' && args.parentId !== undefined && args.parentId !== null && !text(args.parentId)) return 'parentId 无效';
  }
  if (['folder_create', 'folder_update', 'tag_create', 'tag_update'].includes(action) && action !== 'folder_update') {
    const name = text(args.name);
    if (!name || codePointLength(name) > 80) return '名称需要 1 到 80 个字符';
  }
  if (action === 'folder_update') {
    if (!text(args.folderId)) return 'folderId 无效';
    if (args.name === undefined && args.parentId === undefined) return 'folder_update 需要名称或父文件夹';
    if (args.name !== undefined && (!text(args.name) || codePointLength(text(args.name)) > 80)) return '名称需要 1 到 80 个字符';
  }
  if (action === 'folder_delete' && !text(args.folderId)) return 'folderId 无效';
  if ((action === 'tag_update' || action === 'tag_delete') && !text(args.tagId)) return 'tagId 无效';
  if (action === 'reference') {
    const ids = idList(args.materialIds, 20);
    if (!ids?.length) return 'reference 至少需要一份资料';
    if (!integer(args.from, 0) || !integer(args.to, 0)) return '插入位置无效';
    if (!revisionMap(args.expectedMaterialRevisions) || !revisionMap(args.expectedOrganizationRevisions)) return '需要资料版本和整理版本';
  }
  if (action === 'undo' && (!text(args.changeId) || text(args.changeId).length > 80)) return 'changeId 无效';
  if (['list', 'search', 'ask', 'task_materials'].includes(action) && args.archived !== undefined && typeof args.archived !== 'string') return '列出资料时 archived 用 exclude、only 或 include';
  return null;
}

function hitFields(hit: unknown) {
  const row = hit && typeof hit === 'object' ? hit as { snippet?: unknown; chunkId?: unknown; locator?: unknown } : {};
  return {
    chunkId: typeof row.chunkId === 'string' ? row.chunkId : undefined,
    locator: row.locator,
    snippet: clip(typeof row.snippet === 'string' ? row.snippet : '', TEXT_CLIP),
  };
}

function brief(item: { id: string; title: string; kind: string; revision: number; organizationRevision: number; folderId: string | null; extraction?: { status?: string }; hits?: unknown[] }) {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    revision: item.revision,
    organizationRevision: item.organizationRevision,
    folderId: item.folderId,
    extraction: { status: item.extraction?.status ?? 'queued' },
    ...(item.hits ? { hits: item.hits.slice(0, 3).map(hitFields) } : {}),
  };
}

async function readLibrary(action: LibraryAction, args: Record<string, unknown>) {
  if (action === 'document') return readResourceDocument(ownerActor, args);
  if (action === 'folders') return library.folders(ownerActor);
  if (action === 'tags') return library.tags(ownerActor);
  if (action === 'list' || action === 'search' || action === 'task_materials' || action === 'linked_tasks' || action === 'content') {
    const page = paging(args, action === 'content' ? CONTENT_PAGE : LIST_PAGE);
    if (!page) throw failure('INVALID_TOOL_ARGUMENTS', '分页参数无效', 400);
    if (action === 'list') {
      const listed = await library.materials(ownerActor, filtersFrom(args), page.cursor, page.limit);
      return { items: listed.items.map((item) => brief(item)), total: listed.total, nextCursor: listed.nextCursor };
    }
    if (action === 'search') {
      const found = await library.search(ownerActor, text(args.q), filtersFrom(args), page.cursor, page.limit);
      return { items: found.items.slice(0, page.limit).map((item) => brief(item)), total: found.total, nextCursor: found.nextCursor };
    }
    if (action === 'linked_tasks') {
      const tasks = await library.materialTasks(ownerActor, text(args.materialId), page.cursor, page.limit);
      return { items: tasks.items.map((item) => ({ id: item.id, title: item.title, topicId: item.topicId, revision: item.revision, status: item.status })), total: tasks.total, nextCursor: tasks.nextCursor };
    }
    if (action === 'task_materials') {
      const archived = typeof args.archived === 'string' ? args.archived as 'exclude' | 'only' | 'include' : undefined;
      const rows = await library.taskMaterials(ownerActor, text(args.taskId), { archived }, page.cursor, page.limit);
      return { items: rows.items.map((item) => brief(item)), total: rows.total, nextCursor: rows.nextCursor };
    }
    const chunks = await library.content(ownerActor, text(args.materialId), Number(args.revision), page.cursor, page.limit);
    return {
      revision: Number(args.revision),
      items: chunks.items.map((item) => ({ id: item.id, ordinal: item.ordinal, text: clip(item.text, CONTENT_CLIP), method: item.method, locator: item.locator })),
      total: chunks.total,
      nextCursor: chunks.nextCursor,
    };
  }
  if (action === 'read') {
    const row = await library.material(ownerActor, text(args.materialId));
    return {
      id: row.id, title: row.title, kind: row.kind, revision: row.revision, organizationRevision: row.organizationRevision,
      folderId: row.folderId, topicId: row.topicId, uri: row.uri ? clip(row.uri, 300) : null, archived: Boolean(row.archivedAt),
      extraction: { status: row.extraction.status },
      tags: row.tags.map((tag) => ({ id: tag.id, name: tag.name })),
      versions: row.versions.slice(0, 12).map((version) => ({ revision: version.revision, extraction: { status: version.extraction.status } })),
    };
  }
  const { askLibrary } = await import('./library/ask.js');
  const answer = await askLibrary(ownerActor, randomUUID(), text(args.question), filtersFrom(args));
  if (answer.status === 'model_unavailable') return { status: 'model_unavailable', message: '模型不可用', paragraphs: [], citations: [] };
  return {
    status: answer.status,
    paragraphs: answer.paragraphs.map((paragraph) => ({ text: clip(paragraph.text, 500), citationIds: paragraph.citationIds })),
    citations: answer.citations.map((citation) => ({ materialId: citation.materialId, revision: citation.revision, chunkId: citation.chunkId, title: citation.titleSnapshot, quote: clip(citation.quote, TEXT_CLIP), locator: citation.locator })),
  };
}

export function commandFor(action: LibraryAction, args: Record<string, unknown>): Command {
  const materialId = text(args.materialId);
  const revision = Number(args.revision);
  if (action === 'document_create' || action === 'document_save') {
    const input = { format: args.format, schemaVersion: args.schemaVersion, content: args.document ?? args.content, relativeReferences: args.relativeReferences };
    return action === 'document_create'
      ? { kind: 'resource.create', input: { ...input, title: args.title, topicId: args.topicId ?? null, folderId: args.folderId ?? null } }
      : { kind: 'resource.save', targetId: materialId, expectedRevision: revision, input };
  }
  if (action === 'create') {
    return { kind: 'material.create', input: { topicId: args.topicId === undefined ? null : args.topicId, kind: args.kind, title: text(args.title), content: typeof args.content === 'string' ? args.content : '', ...(args.uri !== undefined ? { uri: args.uri } : {}), ...(args.metadata !== undefined ? { metadata: args.metadata } : {}) } };
  }
  if (action === 'update') {
    const input = { ...(args.title !== undefined ? { title: text(args.title) } : {}), ...(args.content !== undefined ? { content: args.content } : {}), ...(args.uri !== undefined ? { uri: args.uri } : {}), ...(args.taskId !== undefined ? { taskId: args.taskId } : {}), ...(args.reason !== undefined ? { reason: args.reason } : {}), ...(args.metadata !== undefined ? { metadata: args.metadata } : {}) };
    return { kind: 'material.update', targetId: materialId, expectedRevision: revision, input };
  }
  if (action === 'archive') return { kind: 'material.archive', targetId: materialId, expectedRevision: revision, input: { archived: args.archived } };
  if (action === 'organize') return { kind: 'material.organize', targetId: materialId, expectedRevision: revision, input: { expectedOrganizationRevision: args.organizationRevision, ...(args.folderId !== undefined ? { folderId: args.folderId } : {}), ...(args.tagIds !== undefined ? { tagIds: args.tagIds } : {}) } };
  if (action === 'links') return { kind: 'material.links', targetId: materialId, expectedRevision: revision, input: { expectedOrganizationRevision: args.organizationRevision, addTaskIds: args.addTaskIds ?? [], removeTaskIds: args.removeTaskIds ?? [], removeInlineReferences: args.removeInlineReferences, expectedTaskRevisions: args.expectedTaskRevisions ?? {} } };
  if (action === 'reextract') return { kind: 'material.reextract', targetId: materialId, expectedRevision: revision, input: {} };
  if (action === 'folder_create') return { kind: 'libraryFolder.create', input: { parentId: args.parentId, name: text(args.name) } };
  if (action === 'folder_update') return { kind: 'libraryFolder.update', targetId: text(args.folderId), expectedRevision: revision, input: { ...(args.parentId !== undefined ? { parentId: args.parentId } : {}), ...(args.name !== undefined ? { name: text(args.name) } : {}) } };
  if (action === 'folder_delete') return { kind: 'libraryFolder.delete', targetId: text(args.folderId), expectedRevision: revision, input: {} };
  if (action === 'tag_create') return { kind: 'libraryTag.create', input: { name: text(args.name) } };
  if (action === 'tag_update') return { kind: 'libraryTag.update', targetId: text(args.tagId), expectedRevision: revision, input: { name: text(args.name) } };
  if (action === 'tag_delete') return { kind: 'libraryTag.delete', targetId: text(args.tagId), expectedRevision: revision, input: {} };
  return { kind: 'task.reference_materials', targetId: text(args.taskId), expectedRevision: revision, input: { materialIds: args.materialIds, from: args.from, to: args.to, expectedMaterialRevisions: args.expectedMaterialRevisions, expectedOrganizationRevisions: args.expectedOrganizationRevisions } };
}

export async function submitLibraryProposal(args: Record<string, unknown>, context: AgentLibraryContext = {}) {
  const invalid = validateLibraryArguments(args);
  if (invalid) throw failure('INVALID_TOOL_ARGUMENTS', invalid, 400);
  const action = args.action as LibraryAction;
  if (action === 'undo' || isLibraryReadAction(action)) throw failure('INVALID_TOOL_ARGUMENTS', '这个动作不生成资料提议', 400);
  const command = commandFor(action, args);
  // Folder and tag commands reject the builtin actor. Submit them as the owner and keep the proposal pending.
  const actor = command.kind.startsWith('library') ? ownerActor : internalActor;
  try {
    const response = await new CommandService().submit(actor, { requestId: `builtin:${randomUUID()}`, commands: [command] }, { forceProposal: true, audit: { conversationId: context.conversationId, approvalId: context.approvalId } });
    if (response.status !== 'pending_approval') throw failure('APPROVAL_REQUIRED', '资料修改必须等待确认', 409);
    return { proposalId: response.proposalId as string, proposalRevision: response.proposalRevision as number };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (error instanceof ZodError) throw failure('INVALID_TOOL_ARGUMENTS', error.issues.map((issue) => issue.message).join('；'), 400);
    throw error;
  }
}

export async function storeLibraryUndo(args: Record<string, unknown>) {
  const invalid = validateLibraryArguments(args);
  if (invalid) throw failure('INVALID_TOOL_ARGUMENTS', invalid, 400);
  const changeId = text(args.changeId);
  const record = await prisma.changeRecord.findUnique({ where: { id: changeId } });
  if (!record) throw failure('NOT_FOUND', '变更记录不存在', 404);
  if (record.undoneAt || record.operation.startsWith('undo:') || record.entityType === 'execution') throw failure('CHANGE_NOT_REVERSIBLE', '该变更不可撤销', 400);
  return { undoChangeId: changeId };
}

export async function runAgentLibraryTool(call: { name: string; arguments: Record<string, unknown> }): Promise<ToolPayload> {
  try {
    const invalid = validateLibraryArguments(call.arguments);
    if (invalid) return { success: false, error: invalid, code: 'INVALID_TOOL_ARGUMENTS' };
    const action = call.arguments.action as LibraryAction;
    if (!isLibraryReadAction(action)) return { success: false, error: '资料修改必须经过审核', code: 'APPROVAL_REQUIRED' };
    return { success: true, data: await readLibrary(action, call.arguments) };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    return { success: false, error: error instanceof Error ? error.message : '项目资料读取失败', ...(code ? { code } : {}) };
  }
}
