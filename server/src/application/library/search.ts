import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/prisma.js';
import type { Actor } from '../security.js';
import { libraryError } from './access.js';
import { locatorSchema, normMapSchema, parseJson, type LibraryFilters } from './schema.js';
import { codePointLength, queryPlan, sliceCodePoints } from './text.js';

type Hit = { chunkId: string; locator: ReturnType<typeof locatorSchema.parse>; method: 'native' | 'ocr'; snippet: string; highlightStart: number; highlightEnd: number };
export type LibrarySearchHit = {
  id: string;
  revision: number;
  score: number;
  title: string;
  updatedAt: string;
  hits: Hit[];
};

const week = 7 * 24 * 60 * 60 * 1000;

function authSql(actor: Actor) {
  if (actor.topicIds === 'all') return Prisma.sql`1 = 1`;
  const parts: Prisma.Sql[] = [];
  if (actor.topicIds.length) parts.push(Prisma.sql`m.topicId IN (${Prisma.join(actor.topicIds)})`);
  if (actor.includeInbox) parts.push(Prisma.sql`m.topicId IS NULL`);
  if (!parts.length) return Prisma.sql`0 = 1`;
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

async function folderScope(folderId: string, recursive: boolean) {
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

async function matchingDocumentIds(tokens: string[]) {
  const counts = await prisma.$queryRaw<Array<{ token: string; total: bigint | number }>>(Prisma.sql`
    SELECT p.token as token, COUNT(*) as total
    FROM LibrarySearchPosting p
    WHERE p.token IN (${Prisma.join(tokens)})
    GROUP BY p.token
  `);
  if (counts.length !== new Set(tokens).size) return [];
  const ordered = counts.sort((left, right) => Number(left.total) - Number(right.total));
  let sql = Prisma.sql`SELECT documentId as id FROM LibrarySearchPosting WHERE token = ${ordered[0]!.token}`;
  for (const row of ordered.slice(1)) sql = Prisma.sql`${sql} INTERSECT SELECT documentId as id FROM LibrarySearchPosting WHERE token = ${row.token}`;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(sql);
  return rows.map((row) => row.id);
}

export async function librarySearch(actor: Actor, q: string, filters: LibraryFilters, cursor = 0, limit = 40, history = false) {
  const plan = queryPlan(q);
  if (!plan) throw libraryError('INVALID_QUERY', '请输入 1 至 200 个字符的检索内容', 400);
  const documentIds = await matchingDocumentIds(plan.tokens);
  if (!documentIds.length) return { items: [], total: 0, nextCursor: null };
  const archived = filters.archived ?? (filters.view === 'archived' ? 'only' : 'exclude');
  const recursive = filters.recursive !== false;
  const clauses: Prisma.Sql[] = [authSql(actor)];
  if (!history) clauses.push(Prisma.sql`m.revision = d.revision`);
  clauses.push(Prisma.sql`(d.chunkId IS NULL OR c.generation = e.indexedGeneration)`);
  if (archived === 'exclude') clauses.push(Prisma.sql`m.archivedAt IS NULL`);
  if (archived === 'only') clauses.push(Prisma.sql`m.archivedAt IS NOT NULL`);
  if (filters.view === 'recent') clauses.push(Prisma.sql`m.createdAt >= ${new Date(Date.now() - week).toISOString()}`);
  if (filters.view === 'unfiled' || filters.folderId === 'unfiled') clauses.push(Prisma.sql`m.folderId IS NULL`);
  if (filters.folderId && filters.folderId !== 'unfiled') {
    const ids = await folderScope(filters.folderId, recursive);
    clauses.push(Prisma.sql`m.folderId IN (${Prisma.join(ids)})`);
  }
  if (filters.kind) clauses.push(Prisma.sql`m.kind = ${filters.kind}`);
  if (filters.tagIds?.length) {
    const ids = [...new Set(filters.tagIds)];
    clauses.push(Prisma.sql`(SELECT COUNT(DISTINCT mt.tagId) FROM MaterialTag mt WHERE mt.materialId = m.id AND mt.tagId IN (${Prisma.join(ids)})) = ${ids.length}`);
  }
  if (filters.taskId) clauses.push(Prisma.sql`EXISTS (SELECT 1 FROM MaterialTaskLink l JOIN tasks t ON t.id = l.taskId WHERE l.materialId = m.id AND l.taskId = ${filters.taskId} AND t.deletedAt IS NULL AND ${taskVisible('t', actor)})`);
  if (filters.taskTopicId) {
    const topic = filters.taskTopicId === 'inbox' ? Prisma.sql`t.topicId IS NULL` : Prisma.sql`t.topicId = ${filters.taskTopicId}`;
    clauses.push(Prisma.sql`EXISTS (SELECT 1 FROM MaterialTaskLink l JOIN tasks t ON t.id = l.taskId WHERE l.materialId = m.id AND ${topic} AND t.deletedAt IS NULL AND ${taskVisible('t', actor)})`);
  }
  const rows: Array<{
    id: string; materialId: string; revision: number; chunkId: string | null; titleNorm: string; fileNameNorm: string; tagsNorm: string; bodyNorm: string; normalizationMapJson: string; updatedAt: string; title: string;
  }> = [];
  for (let index = 0; index < documentIds.length; index += 400) {
    const slice = documentIds.slice(index, index + 400);
    rows.push(...await prisma.$queryRaw<typeof rows>(Prisma.sql`
      SELECT d.id as id, d.materialId as materialId, d.revision as revision, d.chunkId as chunkId,
             d.titleNorm as titleNorm, d.fileNameNorm as fileNameNorm, d.tagsNorm as tagsNorm,
             d.bodyNorm as bodyNorm, d.normalizationMapJson as normalizationMapJson,
             m.updatedAt as updatedAt, m.title as title
      FROM LibrarySearchDocument d
      JOIN Material m ON m.id = d.materialId
      LEFT JOIN MaterialChunk c ON c.id = d.chunkId
      LEFT JOIN MaterialExtraction e ON e.materialId = d.materialId AND e.revision = d.revision
      WHERE d.id IN (${Prisma.join(slice)}) AND ${Prisma.join(clauses, ' AND ')}
    `));
  }
  const grouped = new Map<string, { id: string; revision: number; score: number; title: string; updatedAt: string; hits: Array<{ chunkId: string; bodyNorm: string; map: string }> }>();
  for (const row of rows) {
    const fields = [row.titleNorm, row.fileNameNorm, row.tagsNorm, row.bodyNorm];
    if (!plan.terms.every((term) => fields.some((field) => field.includes(term)))) continue;
    let score = (row.titleNorm === plan.q ? 10000 : 0) + (row.fileNameNorm === plan.q ? 9000 : 0);
    for (const term of plan.terms) {
      if (row.titleNorm.includes(term)) score += 500;
      if (row.fileNameNorm.includes(term)) score += 400;
      if (row.tagsNorm.includes(term)) score += 200;
      if (row.bodyNorm.includes(term)) score += 50;
    }
    const key = `${row.materialId}\u0000${row.revision}`;
    const bodyHit = Boolean(row.chunkId && plan.terms.some((term) => row.bodyNorm.includes(term)));
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        id: row.materialId, revision: row.revision, score, title: row.title, updatedAt: row.updatedAt,
        hits: bodyHit && row.chunkId ? [{ chunkId: row.chunkId, bodyNorm: row.bodyNorm, map: row.normalizationMapJson }] : [],
      });
    } else {
      if (score > current.score) current.score = score;
      if (bodyHit && row.chunkId && current.hits.length < 3 && !current.hits.some((hit) => hit.chunkId === row.chunkId)) {
        current.hits.push({ chunkId: row.chunkId, bodyNorm: row.bodyNorm, map: row.normalizationMapJson });
      }
    }
  }
  const merged = [...grouped.values()].sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id) || right.revision - left.revision);
  const page = merged.slice(cursor, cursor + limit);
  const chunkIds = page.flatMap((item) => item.hits.map((hit) => hit.chunkId));
  const chunks = chunkIds.length ? await prisma.materialChunk.findMany({ where: { id: { in: chunkIds } } }) : [];
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const items: LibrarySearchHit[] = page.map((item) => ({
    id: item.id, revision: item.revision, score: item.score, title: item.title, updatedAt: item.updatedAt,
    hits: item.hits.flatMap((hit) => {
      const chunk = byId.get(hit.chunkId);
      if (!chunk) return [];
      const term = plan.terms.find((candidate) => hit.bodyNorm.includes(candidate)) ?? plan.terms[0];
      const located = locate(chunk.text, hit.bodyNorm, parseJson(normMapSchema, hit.map, []), term);
      return [{ chunkId: chunk.id, locator: locatorSchema.parse(JSON.parse(chunk.locatorJson)), method: chunk.method === 'ocr' ? 'ocr' as const : 'native' as const, ...located }];
    }),
  }));
  return { items, total: merged.length, nextCursor: cursor + items.length < merged.length ? cursor + items.length : null };
}

function taskVisible(alias: string, actor: Actor) {
  if (actor.topicIds === 'all') return Prisma.sql`1 = 1`;
  const parts: Prisma.Sql[] = [];
  if (actor.topicIds.length) parts.push(Prisma.sql`${Prisma.raw(alias)}.topicId IN (${Prisma.join(actor.topicIds)})`);
  if (actor.includeInbox) parts.push(Prisma.sql`${Prisma.raw(alias)}.topicId IS NULL`);
  if (!parts.length) return Prisma.sql`0 = 1`;
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

function locate(text: string, normalized: string, map: Array<{ out: number; inStart: number; inEnd: number }>, term: string) {
  const units = Array.from(normalized);
  const needle = Array.from(term);
  let found = -1;
  for (let index = 0; index <= units.length - needle.length; index += 1) {
    if (needle.every((char, offset) => units[index + offset] === char)) { found = index; break; }
  }
  if (found < 0 || !map[found]) return { snippet: sliceCodePoints(text, 0, 180), highlightStart: 0, highlightEnd: 0 };
  const start = map[found].inStart;
  const end = map[Math.min(map.length - 1, found + needle.length - 1)]?.inEnd ?? map[found].inEnd;
  const from = Math.max(0, start - 60);
  const to = Math.min(codePointLength(text), end + 180);
  return { snippet: sliceCodePoints(text, from, to), highlightStart: start - from, highlightEnd: end - from };
}
