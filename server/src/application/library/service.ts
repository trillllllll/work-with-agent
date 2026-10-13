import type { Material, MaterialExtraction } from '@prisma/client';
import { prisma } from '../../infrastructure/prisma.js';
import type { Actor } from '../security.js';
import { assertOwner } from '../security.js';
import { libraryError, libraryNow, readableMaterial, topicVisible } from './access.js';
import { locatorSchema, type LibraryFilters } from './schema.js';
import { librarySearch } from './search.js';

const week = 7 * 24 * 60 * 60 * 1000;
type ExtractionStatus = 'queued' | 'running' | 'ready' | 'partial' | 'blocked' | 'failed' | 'unsupported';

function taskGrant(actor: Actor) {
  if (actor.topicIds === 'all') return actor.includeInbox ? { deletedAt: null } : { deletedAt: null, topicId: { not: null } };
  const topics = actor.topicIds.length ? [{ topicId: { in: actor.topicIds } }] : [];
  const inbox = actor.includeInbox ? [{ topicId: null }] : [];
  const grants = [...topics, ...inbox];
  if (!grants.length) return { deletedAt: null, id: '__none__' };
  return { deletedAt: null, OR: grants };
}

function archivedMode(filters: LibraryFilters) {
  if (filters.archived) return filters.archived;
  if (filters.view === 'archived') return 'only' as const;
  return 'exclude' as const;
}

async function folderIds(folderId: string, recursive: boolean) {
  if (!recursive) return [folderId];
  const rows = await prisma.libraryFolder.findMany({ select: { id: true, parentId: true } });
  const ids = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) { ids.add(row.id); grew = true; }
  }
  return [...ids];
}

export async function materialWhere(actor: Actor, filters: LibraryFilters) {
  const archived = archivedMode(filters);
  const recursive = filters.recursive !== false;
  const where: Record<string, unknown> = {};
  if (actor.topicIds === 'all') {
    if (!actor.includeInbox) where.topicId = { not: null };
  } else {
    const topics = actor.topicIds.length ? [{ topicId: { in: actor.topicIds } }] : [];
    const inbox = actor.includeInbox ? [{ topicId: null }] : [];
    const grants = [...topics, ...inbox];
    if (!grants.length) where.id = '__none__';
    else where.OR = grants;
  }
  if (archived === 'exclude') where.archivedAt = null;
  if (archived === 'only') where.archivedAt = { not: null };
  if (filters.view === 'recent') where.createdAt = { gte: new Date(Date.now() - week).toISOString() };
  if (filters.view === 'unfiled' || filters.folderId === 'unfiled') where.folderId = null;
  if (filters.folderId && filters.folderId !== 'unfiled') where.folderId = { in: await folderIds(filters.folderId, recursive) };
  if (filters.kind) where.kind = filters.kind;
  if (filters.tagIds?.length) where.AND = [...new Set(filters.tagIds)].map((tagId) => ({ tags: { some: { tagId } } }));
  if (filters.taskId || filters.taskTopicId) {
    where.taskLinks = { some: { ...(filters.taskId ? { taskId: filters.taskId } : {}), task: { ...taskGrant(actor), ...(filters.taskTopicId ? { topicId: filters.taskTopicId === 'inbox' ? null : filters.taskTopicId } : {}) } } };
  }
  return where;
}

async function summaries(actor: Actor, rows: Material[]) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [tags, extractions, counts, versions] = await Promise.all([
    prisma.materialTag.findMany({ where: { materialId: { in: ids } }, include: { tag: true } }),
    prisma.materialExtraction.findMany({ where: { OR: rows.map((row) => ({ materialId: row.id, revision: row.revision })) } }),
    prisma.materialTaskLink.groupBy({ by: ['materialId'], where: { materialId: { in: ids }, task: taskGrant(actor) }, _count: { _all: true } }),
    prisma.materialVersion.findMany({ where: { OR: rows.map((row) => ({ materialId: row.id, revision: row.revision })) }, select: { materialId: true, fileName: true, mimeType: true } }),
  ]);
  const tagMap = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of tags) {
    const list = tagMap.get(row.materialId) ?? [];
    list.push({ id: row.tag.id, name: row.tag.name });
    tagMap.set(row.materialId, list);
  }
  const extractionMap = new Map(extractions.map((row) => [`${row.materialId}:${row.revision}`, row]));
  const countMap = new Map(counts.map((row) => [row.materialId, row._count._all]));
  const fileMap = new Map(versions.map((row) => [row.materialId, row]));
  return rows.map((row) => summarize(actor, row, tagMap.get(row.id) ?? [], extractionMap.get(`${row.id}:${row.revision}`), countMap.get(row.id) ?? 0, fileMap.get(row.id) ?? null));
}

function summarize(actor: Actor, row: Material, tags: Array<{ id: string; name: string }>, extraction: MaterialExtraction | undefined, linkedTaskCount: number, file: { fileName: string | null; mimeType: string | null } | null) {
  return {
    id: row.id, title: row.title, kind: row.kind as 'text' | 'markdown' | 'link' | 'thread' | 'attachment',
    revision: row.revision, organizationRevision: row.organizationRevision, topicId: row.topicId,
    folderId: row.folderId, fileName: file?.fileName ?? null, mimeType: file?.mimeType ?? null,
    archivedAt: row.archivedAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
    tags: tags.sort((left, right) => left.name.localeCompare(right.name)), linkedTaskCount,
    extraction: { status: (extraction?.status ?? 'queued') as ExtractionStatus, errorCode: extraction?.errorCode ?? null, errors: parseErrors(extraction?.errorsJson) },
  };
}

function parseErrors(value: string | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function libraryRows<T extends { id: string }>(items: T[], score: number | null = null, hits: unknown[] = []) {
  return items.map((item) => ({ ...item, score, hits }));
}

export class LibraryService {
  async materials(actor: Actor, filters: LibraryFilters, cursor = 0, limit = 40) {
    const where = await materialWhere(actor, filters);
    const [rows, total] = await Promise.all([
      prisma.material.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: cursor, take: limit }),
      prisma.material.count({ where }),
    ]);
    const items = libraryRows(await summaries(actor, rows));
    return { items, total, nextCursor: cursor + items.length < total ? cursor + items.length : null };
  }

  async material(actor: Actor, id: string) {
    const row = await readableMaterial(prisma, actor, id);
    const [item] = await summaries(actor, [row]);
    const versions = await prisma.materialVersion.findMany({ where: { materialId: id }, orderBy: { revision: 'desc' } });
    const extractions = await prisma.materialExtraction.findMany({ where: { materialId: id } });
    const byRevision = new Map(extractions.map((entry) => [entry.revision, entry]));
    const current = versions.find((version) => version.revision === row.revision);
    return {
      ...item,
      uri: row.uri,
      content: current ? { revision: current.revision, fileName: current.fileName, mimeType: current.mimeType, hasAttachment: Boolean(current.attachmentPath), contentHash: current.contentHash } : null,
      versions: versions.map((version) => ({
        revision: version.revision, createdAt: version.createdAt, fileName: version.fileName, mimeType: version.mimeType,
        hasAttachment: Boolean(version.attachmentPath), extraction: { status: (byRevision.get(version.revision)?.status ?? 'queued') as ExtractionStatus, errorCode: byRevision.get(version.revision)?.errorCode ?? null, errors: parseErrors(byRevision.get(version.revision)?.errorsJson) },
      })),
    };
  }

  async materialTasks(actor: Actor, id: string, cursor = 0, limit = 40) {
    await readableMaterial(prisma, actor, id);
    const where = { materialId: id, task: taskGrant(actor) };
    const [rows, total] = await Promise.all([
      prisma.materialTaskLink.findMany({ where, include: { task: true }, orderBy: { taskId: 'asc' }, skip: cursor, take: limit }),
      prisma.materialTaskLink.count({ where }),
    ]);
    const items = rows.map((row) => ({ id: row.task.id, title: row.task.title, topicId: row.task.topicId, revision: row.task.revision, status: row.task.status, manual: row.manual, legacy: row.legacy }));
    return { items, total, nextCursor: cursor + items.length < total ? cursor + items.length : null };
  }

  async taskMaterials(actor: Actor, taskId: string, filters: Pick<LibraryFilters, 'archived'>, cursor = 0, limit = 40) {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.deletedAt || !topicVisible(actor, task.topicId)) throw libraryError('NOT_FOUND', '任务不存在', 404);
    const archived = filters.archived ?? 'exclude';
    const where = {
      taskId,
      material: {
        ...(actor.topicIds === 'all' ? (actor.includeInbox ? {} : { topicId: { not: null } }) : { OR: [{ topicId: { in: actor.topicIds } }, ...(actor.includeInbox ? [{ topicId: null }] : [])] }),
        ...(archived === 'exclude' ? { archivedAt: null } : archived === 'only' ? { archivedAt: { not: null } } : {}),
      },
    };
    const [rows, total] = await Promise.all([
      prisma.materialTaskLink.findMany({ where, include: { material: true }, orderBy: { materialId: 'asc' }, skip: cursor, take: limit }),
      prisma.materialTaskLink.count({ where }),
    ]);
    return { items: libraryRows(await summaries(actor, rows.map((row) => row.material))), total, nextCursor: cursor + rows.length < total ? cursor + rows.length : null };
  }

  async content(actor: Actor, id: string, revision: number, cursor = 0, limit = 40) {
    await readableMaterial(prisma, actor, id);
    const extraction = await prisma.materialExtraction.findUnique({ where: { materialId_revision: { materialId: id, revision } } });
    if (!extraction) throw libraryError('NOT_FOUND', '该版本还没有正文', 404);
    const where = { extractionId: extraction.id, generation: extraction.indexedGeneration };
    const [rows, total] = await Promise.all([
      prisma.materialChunk.findMany({ where, orderBy: { ordinal: 'asc' }, skip: cursor, take: limit }),
      prisma.materialChunk.count({ where }),
    ]);
    const items = rows.map((row) => ({ id: row.id, ordinal: row.ordinal, text: row.text, method: row.method, locator: locatorSchema.parse(JSON.parse(row.locatorJson)) }));
    return { items, total, nextCursor: cursor + items.length < total ? cursor + items.length : null };
  }

  async chunk(actor: Actor, id: string) {
    const chunk = await prisma.materialChunk.findUnique({ where: { id }, include: { extraction: true } });
    if (!chunk) throw libraryError('NOT_FOUND', '正文片段不存在', 404);
    await readableMaterial(prisma, actor, chunk.extraction.materialId);
    return { id: chunk.id, materialId: chunk.extraction.materialId, revision: chunk.extraction.revision, generation: chunk.generation, ordinal: chunk.ordinal, text: chunk.text, method: chunk.method, locator: locatorSchema.parse(JSON.parse(chunk.locatorJson)) };
  }

  async folders(actor: Actor) {
    assertOwner(actor);
    const items = await prisma.libraryFolder.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    return { items: items.map((folder) => ({ id: folder.id, parentId: folder.parentId, name: folder.name, revision: folder.revision })) };
  }

  async tags(actor: Actor) {
    assertOwner(actor);
    const items = await prisma.libraryTag.findMany({ orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }] });
    return { items: items.map((tag) => ({ id: tag.id, name: tag.name, revision: tag.revision })) };
  }

  async search(actor: Actor, q: string, filters: LibraryFilters, cursor = 0, limit = 40, history = false) {
    const page = await librarySearch(actor, q, filters, cursor, limit, history);
    const ids = [...new Set(page.items.map((item) => item.id))];
    const materials = ids.length ? await prisma.material.findMany({ where: { id: { in: ids } } }) : [];
    const summaryRows = await summaries(actor, materials);
    const byId = new Map(summaryRows.map((row) => [row.id, row]));
    const items = page.items.flatMap((item) => {
      const summary = byId.get(item.id);
      return summary ? [{ ...summary, score: item.score, hits: item.hits }] : [];
    });
    return { items, total: page.total, nextCursor: page.nextCursor };
  }

  async source(actor: Actor, id: string, revision: number) {
    await readableMaterial(prisma, actor, id);
    const version = await prisma.materialVersion.findUnique({ where: { materialId_revision: { materialId: id, revision } } });
    if (!version) throw libraryError('NOT_FOUND', '资料版本不存在', 404);
    if (version.attachmentPath) return { kind: 'attachment' as const, materialId: id, revision: version.revision, fileName: version.fileName, mimeType: version.mimeType };
    return { kind: 'text' as const, content: version.content, revision: version.revision };
  }

  async duplicates(actor: Actor, sha256: string) {
    const versions = await prisma.materialVersion.findMany({ where: { attachmentPath: sha256 }, select: { materialId: true, revision: true } });
    if (!versions.length) return [];
    const materials = await prisma.material.findMany({ where: { id: { in: versions.map((version) => version.materialId) } } });
    const current = materials.filter((material) => topicVisible(actor, material.topicId) && versions.some((version) => version.materialId === material.id && version.revision === material.revision));
    return summaries(actor, current);
  }

  async answer(actor: Actor, id: string) {
    assertOwner(actor);
    const row = await prisma.libraryAnswer.findUnique({ where: { id } });
    if (!row || row.actorId !== actor.id) throw libraryError('NOT_FOUND', '回答不存在', 404);
    return { id: row.id, question: row.question, filters: JSON.parse(row.filtersJson), status: row.status, result: JSON.parse(row.resultJson), createdAt: row.createdAt };
  }
}

export const libraryClock = libraryNow;
