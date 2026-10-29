import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/prisma.js';
import type { Actor } from '../security.js';
import { libraryError } from './access.js';
import { locatorSchema, normMapSchema, parseJson, type LibraryFilters, type Locator } from './schema.js';
import { codePointLength, queryPlan, sliceCodePoints } from './text.js';

export type LibrarySearchHit = {
  chunkId: string;
  revision: number;
  locator: Locator;
  method: 'native' | 'ocr';
  snippet: string;
  highlightStart: number;
  highlightEnd: number;
};

export type LibrarySearchItem = {
  id: string;
  revision: number;
  score: number;
  title: string;
  updatedAt: string;
  hits: LibrarySearchHit[];
};

const week = 7 * 24 * 60 * 60 * 1000;

function materialAuth(actor: Actor) {
  if (actor.topicIds === 'all') return actor.includeInbox ? Prisma.sql`1 = 1` : Prisma.sql`m.topicId IS NOT NULL`;
  const parts: Prisma.Sql[] = [];
  if (actor.topicIds.length) parts.push(Prisma.sql`m.topicId IN (${Prisma.join(actor.topicIds)})`);
  if (actor.includeInbox) parts.push(Prisma.sql`m.topicId IS NULL`);
  if (!parts.length) return Prisma.sql`0 = 1`;
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

function taskVisible(actor: Actor) {
  if (actor.topicIds === 'all') return actor.includeInbox ? Prisma.sql`1 = 1` : Prisma.sql`t.topic_id IS NOT NULL`;
  const parts: Prisma.Sql[] = [];
  if (actor.topicIds.length) parts.push(Prisma.sql`t.topic_id IN (${Prisma.join(actor.topicIds)})`);
  if (actor.includeInbox) parts.push(Prisma.sql`t.topic_id IS NULL`);
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

function scoreSql(q: string, terms: string[]) {
  const parts: Prisma.Sql[] = [
    Prisma.sql`CASE WHEN d.titleNorm = ${q} THEN 10000 ELSE 0 END`,
    Prisma.sql`CASE WHEN d.fileNameNorm = ${q} THEN 9000 ELSE 0 END`,
  ];
  for (const term of terms) {
    parts.push(Prisma.sql`CASE WHEN instr(d.titleNorm, ${term}) > 0 THEN 500 ELSE 0 END`);
    parts.push(Prisma.sql`CASE WHEN instr(d.fileNameNorm, ${term}) > 0 THEN 400 ELSE 0 END`);
    parts.push(Prisma.sql`CASE WHEN instr(d.tagsNorm, ${term}) > 0 THEN 200 ELSE 0 END`);
    parts.push(Prisma.sql`CASE WHEN instr(d.bodyNorm, ${term}) > 0 THEN 50 ELSE 0 END`);
  }
  return Prisma.join(parts, ' + ');
}

function termSql(terms: string[]) {
  return Prisma.join(terms.map((term) => Prisma.sql`(instr(d.titleNorm, ${term}) > 0 OR instr(d.fileNameNorm, ${term}) > 0 OR instr(d.tagsNorm, ${term}) > 0 OR instr(d.bodyNorm, ${term}) > 0)`), ' AND ');
}

async function tuneSearchConnection() {
  // temp_store cannot change while a transaction is open. Set it before BEGIN.
  await prisma.$queryRawUnsafe('PRAGMA cache_size = -262144');
  await prisma.$queryRawUnsafe('PRAGMA mmap_size = 2147418112');
  try {
    await prisma.$queryRawUnsafe('PRAGMA temp_store = MEMORY');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('temporary storage cannot be changed')) throw error;
  }
}

export async function librarySearch(actor: Actor, q: string, filters: LibraryFilters, cursor = 0, limit = 40, history = false) {
  const plan = queryPlan(q);
  if (!plan) throw libraryError('INVALID_QUERY', '请输入 1 至 200 个字符的检索内容', 400);
  const archived = filters.archived ?? (filters.view === 'archived' ? 'only' : 'exclude');
  const recursive = filters.recursive !== false;
  const materialClauses: Prisma.Sql[] = [materialAuth(actor), Prisma.sql`m.sourceTaskId IS NULL`];
  if (archived === 'exclude') materialClauses.push(Prisma.sql`m.archivedAt IS NULL`);
  if (archived === 'only') materialClauses.push(Prisma.sql`m.archivedAt IS NOT NULL`);
  if (filters.view === 'recent') materialClauses.push(Prisma.sql`m.createdAt >= ${new Date(Date.now() - week).toISOString()}`);
  if (filters.view === 'unfiled' || filters.folderId === 'unfiled') materialClauses.push(Prisma.sql`m.folderId IS NULL`);
  if (filters.folderId && filters.folderId !== 'unfiled') {
    const ids = await folderScope(filters.folderId, recursive);
    materialClauses.push(Prisma.sql`m.folderId IN (${Prisma.join(ids)})`);
  }
  if (filters.kind) materialClauses.push(Prisma.sql`m.kind = ${filters.kind}`);
  if (filters.tagIds?.length) {
    const ids = [...new Set(filters.tagIds)];
    materialClauses.push(Prisma.sql`(SELECT COUNT(DISTINCT mt.tagId) FROM MaterialTag mt WHERE mt.materialId = m.id AND mt.tagId IN (${Prisma.join(ids)})) = ${ids.length}`);
  }
  if (filters.taskId) materialClauses.push(Prisma.sql`EXISTS (SELECT 1 FROM MaterialTaskLink l JOIN tasks t ON t.id = l.taskId WHERE l.materialId = m.id AND l.taskId = ${filters.taskId} AND t.deleted_at IS NULL AND ${taskVisible(actor)})`);
  if (filters.taskTopicId) {
    const topic = filters.taskTopicId === 'inbox' ? Prisma.sql`t.topic_id IS NULL` : Prisma.sql`t.topic_id = ${filters.taskTopicId}`;
    materialClauses.push(Prisma.sql`EXISTS (SELECT 1 FROM MaterialTaskLink l JOIN tasks t ON t.id = l.taskId WHERE l.materialId = m.id AND ${topic} AND t.deleted_at IS NULL AND ${taskVisible(actor)})`);
  }
  const liveRevision = history ? Prisma.sql`1 = 1` : Prisma.sql`d.revision = am.liveRevision`;
  const score = scoreSql(plan.q, plan.terms);
  await tuneSearchConnection();
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE TEMP TABLE IF NOT EXISTS library_search_auth (
      materialId TEXT PRIMARY KEY,
      liveRevision INTEGER NOT NULL,
      updatedAt TEXT NOT NULL
    ) WITHOUT ROWID`);
    await tx.$executeRawUnsafe('DELETE FROM library_search_auth');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO library_search_auth (materialId, liveRevision, updatedAt)
      SELECT m.id, m.revision, m.updatedAt
      FROM Material m
      WHERE ${Prisma.join(materialClauses, ' AND ')}
    `);
    return tx.$queryRaw<Array<{ materialId: string | null; revision: number | null; score: number | bigint | null; updatedAt: string | null; title: string | null; total: number | bigint }>>(Prisma.sql`
      WITH candidates AS MATERIALIZED (
        SELECT p.documentId AS documentId
        FROM LibrarySearchPosting p INDEXED BY sqlite_autoindex_LibrarySearchPosting_1
        JOIN library_search_auth am ON am.materialId = p.materialId
        WHERE p.token IN (${Prisma.join(plan.tokens)})
        GROUP BY p.documentId
        HAVING COUNT(DISTINCT p.token) = ${plan.tokens.length}
      ),
      verified AS MATERIALIZED (
        SELECT d.materialId AS materialId, d.revision AS revision, am.updatedAt AS updatedAt, (${score}) AS score
        FROM candidates cand
        JOIN LibrarySearchDocument d ON d.id = cand.documentId
        JOIN library_search_auth am ON am.materialId = d.materialId
        LEFT JOIN MaterialChunk c ON c.id = d.chunkId
        LEFT JOIN MaterialExtraction e ON e.materialId = d.materialId AND e.revision = d.revision
        WHERE ${liveRevision}
          AND (d.chunkId IS NULL OR c.generation = e.indexedGeneration)
          AND ${termSql(plan.terms)}
      ),
      grouped AS MATERIALIZED (
        SELECT materialId, revision, MAX(score) AS score, MAX(updatedAt) AS updatedAt
        FROM verified
        GROUP BY materialId, revision
      )
      SELECT materialId, revision, score, updatedAt, title, total FROM (
        SELECT g.materialId AS materialId, g.revision AS revision, g.score AS score, g.updatedAt AS updatedAt, m.title AS title,
               (SELECT COUNT(*) FROM grouped) AS total
        FROM grouped g
        JOIN Material m ON m.id = g.materialId
        ORDER BY g.score DESC, g.updatedAt DESC, g.materialId ASC, g.revision DESC
        LIMIT ${limit} OFFSET ${cursor}
      )
      UNION ALL
      SELECT NULL, NULL, NULL, NULL, NULL, (SELECT COUNT(*) FROM grouped)
      WHERE NOT EXISTS (
        SELECT 1 FROM grouped g2
        LIMIT ${limit} OFFSET ${cursor}
      )
    `);
  }, { timeout: 60_000 });
  const total = Number(rows[0]?.total ?? 0);
  const page = rows.flatMap((row) => row.materialId && row.revision != null && row.score != null && row.updatedAt && row.title != null
    ? [{ id: row.materialId, revision: Number(row.revision), score: Number(row.score), title: row.title, updatedAt: row.updatedAt }]
    : []);
  const hits = await pageHits(plan.terms, page);
  const items: LibrarySearchItem[] = page.map((item) => ({ ...item, hits: hits.get(`${item.id}\u0000${item.revision}`) ?? [] }));
  return { items, total, nextCursor: cursor + items.length < total ? cursor + items.length : null };
}

async function pageHits(terms: string[], page: Array<{ id: string; revision: number; score: number }>) {
  const grouped = new Map<string, LibrarySearchHit[]>();
  if (!page.length) return grouped;
  const body = Prisma.join(terms.map((term) => Prisma.sql`instr(d.bodyNorm, ${term}) > 0`), ' OR ');
  const pages = Prisma.join(page.map((item) => Prisma.sql`(d.materialId = ${item.id} AND d.revision = ${item.revision})`), ' OR ');
  const score = Prisma.join(terms.map((term) => Prisma.sql`CASE WHEN instr(d.bodyNorm, ${term}) > 0 THEN 50 ELSE 0 END`), ' + ');
  const rows = await prisma.$queryRaw<Array<{ materialId: string; revision: number; chunkId: string; bodyNorm: string; normalizationMapJson: string }>>(Prisma.sql`
    SELECT materialId, revision, chunkId, bodyNorm, normalizationMapJson FROM (
      SELECT d.materialId AS materialId, d.revision AS revision, d.chunkId AS chunkId,
             d.bodyNorm AS bodyNorm, COALESCE(nm.normalizationMapJson, d.normalizationMapJson) AS normalizationMapJson,
             ROW_NUMBER() OVER (
               PARTITION BY d.materialId, d.revision
               ORDER BY (${score}) DESC, c.ordinal ASC, c.id ASC
             ) AS rn
      FROM LibrarySearchDocument d
      JOIN MaterialChunk c ON c.id = d.chunkId
      JOIN MaterialExtraction e ON e.materialId = d.materialId AND e.revision = d.revision AND c.generation = e.indexedGeneration
      LEFT JOIN LibrarySearchNormMap nm ON nm.documentId = d.id
      WHERE d.chunkId IS NOT NULL AND (${pages}) AND (${body})
    ) WHERE rn <= 3
  `);
  const chunks = rows.length ? await prisma.materialChunk.findMany({ where: { id: { in: rows.map((row) => row.chunkId) } } }) : [];
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  for (const row of rows) {
    const chunk = byId.get(row.chunkId);
    if (!chunk) continue;
    const term = terms.find((candidate) => row.bodyNorm.includes(candidate)) ?? terms[0]!;
    const located = locate(chunk.text, row.bodyNorm, parseJson(normMapSchema, row.normalizationMapJson, []), term);
    const key = `${row.materialId}\u0000${row.revision}`;
    const list = grouped.get(key) ?? [];
    list.push({
      chunkId: chunk.id,
      revision: Number(row.revision),
      locator: locatorSchema.parse(JSON.parse(chunk.locatorJson)),
      method: chunk.method === 'ocr' ? 'ocr' : 'native',
      ...located,
    });
    grouped.set(key, list);
  }
  return grouped;
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
