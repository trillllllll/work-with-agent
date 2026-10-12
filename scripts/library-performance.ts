import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir, cpus, platform, release, arch } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (!Object.is(actual, expected)) throw new Error(`expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    },
    toBeLessThanOrEqual(expected: number) {
      if (typeof actual !== 'number' || actual > expected) throw new Error(`expected ${String(actual)} <= ${expected}`);
    },
  };
}

async function main() {
const directory = await mkdtemp(join(tmpdir(), 'wwa-library-perf-'));
const file = join(directory, 'perf.db');
const databaseUrl = `file:${file}`;
process.env.DATABASE_URL = databaseUrl;
process.env.KNOWLEDGE_STORAGE_ROOT = join(directory, 'blobs');

const materialCount = 10_000;
const chunksPerMaterial = 4;
const chunkWidth = 1200;

function p95(searchDurationsMs: number[]) {
  const sorted = [...searchDurationsMs].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
}

try {
  const { migrateDatabase } = await import('../server/src/db-migrate.ts');
  await migrateDatabase(databaseUrl);
  const { indexTokens, normalizeWithMap } = await import('../server/src/application/library/text.ts');
  const cycle = Array.from('海盐蓝鲸abc合同甲乙丙丁');
  const bodyUnits: string[] = [];
  while (bodyUnits.length < chunkWidth) bodyUnits.push(cycle[bodyUnits.length % cycle.length]!);
  const body = bodyUnits.join('');
  const bodyNorm = normalizeWithMap(body).normalized;
  const stamp = '2026-10-13T00:00:00.000Z';
  const tagNames = ['标签甲', '标签乙', '标签丙', '标签丁', '标签戊', '标签己', '标签庚', '标签辛'];
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN');
    const tag = db.prepare('INSERT INTO LibraryTag (id, name, normalizedName, revision, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)');
    tagNames.forEach((name, index) => tag.run(`perf-tag-${index}`, name, name, stamp, stamp));
    db.prepare('INSERT INTO topics (id, name) VALUES (?, ?)').run('perf-topic', '性能清单');
    const task = db.prepare('INSERT INTO tasks (id, topic_id, title) VALUES (?, ?, ?)');
    for (let index = 0; index < 4; index += 1) task.run(`perf-task-${index}`, 'perf-topic', `性能任务${index}`);
    const material = db.prepare('INSERT INTO Material (id, topicId, taskId, kind, title, revision, organizationRevision, archivedAt, createdAt, updatedAt) VALUES (?, NULL, NULL, ?, ?, 1, 1, NULL, ?, ?)');
    const version = db.prepare('INSERT INTO MaterialVersion (id, materialId, revision, content, contentHash, metadata, fileName, mimeType, createdAt) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)');
    const extraction = db.prepare(`INSERT INTO MaterialExtraction (id, materialId, revision, parserVersion, status, generation, indexedGeneration, attempts, nextAttemptAt, errorsJson, createdAt, updatedAt) VALUES (?, ?, 1, 'library-v1', 'ready', 1, 1, 1, ?, '[]', ?, ?)`);
    const chunk = db.prepare(`INSERT INTO MaterialChunk (id, extractionId, generation, ordinal, text, textHash, locatorJson, method, createdAt) VALUES (?, ?, 1, ?, ?, ?, ?, 'native', ?)`);
    const link = db.prepare(`INSERT INTO MaterialTaskLink (materialId, taskId, manual, legacy, createdAt, createdBy) VALUES (?, ?, 1, 0, ?, 'perf')`);
    const tagLink = db.prepare('INSERT INTO MaterialTag (materialId, tagId) VALUES (?, ?)');
    const document = db.prepare('INSERT INTO LibrarySearchDocument (id, materialId, revision, chunkId, titleNorm, fileNameNorm, tagsNorm, bodyNorm, normalizationMapJson) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)');
    const posting = db.prepare('INSERT INTO LibrarySearchPosting (token, documentId) VALUES (?, ?)');
    const contentHash = 'f'.repeat(64);
    for (let index = 0; index < materialCount; index += 1) {
      const id = `perf-m-${String(index).padStart(5, '0')}`;
      const title = `资料${String(index).padStart(5, '0')}`;
      const fileName = `${title}.txt`;
      const tags = [tagNames[index % tagNames.length]!, tagNames[(index + 3) % tagNames.length]!];
      material.run(id, 'text', title, stamp, stamp);
      version.run(`perf-v-${id}`, id, body, contentHash, '{}', fileName, 'text/plain', stamp);
      extraction.run(`perf-e-${id}`, id, stamp, stamp, stamp);
      const titleNorm = normalizeWithMap(title).normalized;
      const fileNameNorm = normalizeWithMap(fileName).normalized;
      const tagsNorm = normalizeWithMap(tags.join(' ')).normalized;
      const metaId = `perf-d-${id}`;
      document.run(metaId, id, null, titleNorm, fileNameNorm, tagsNorm, '', '[]');
      const metaTokens = new Set([...indexTokens(titleNorm), ...indexTokens(fileNameNorm), ...indexTokens(tagsNorm)]);
      for (const token of metaTokens) posting.run(token, metaId);
      for (let ordinal = 0; ordinal < chunksPerMaterial; ordinal += 1) {
        const chunkId = `perf-c-${id}-${ordinal}`;
        chunk.run(chunkId, `perf-e-${id}`, ordinal, body, contentHash, JSON.stringify({ kind: 'line', startLine: ordinal + 1, endLine: ordinal + 1, start: 0, end: chunkWidth }), stamp);
        const documentId = `perf-d-${chunkId}`;
        document.run(documentId, id, chunkId, titleNorm, fileNameNorm, tagsNorm, bodyNorm, '[]');
        const tokens = new Set<string>([...indexTokens(titleNorm), ...indexTokens(fileNameNorm), ...indexTokens(tagsNorm), ...indexTokens(bodyNorm)]);
        for (const token of tokens) posting.run(token, documentId);
      }
      tagLink.run(id, `perf-tag-${index % tagNames.length}`);
      tagLink.run(id, `perf-tag-${(index + 3) % tagNames.length}`);
      const linkCount = index % 4;
      for (let taskIndex = 0; taskIndex < linkCount; taskIndex += 1) link.run(id, `perf-task-${taskIndex}`, stamp);
      if (index > 0 && index % 2000 === 0) process.stderr.write(`indexed ${index}\n`);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }

  const { prisma } = await import('../server/src/infrastructure/prisma.ts');
  const { librarySearch } = await import('../server/src/application/library/search.ts');
  const { ownerActor } = await import('../server/src/application/security.ts');
  const outsider = { id: 'perf-outsider', kind: 'connection' as const, topicIds: ['perf-hidden-topic'], includeInbox: false, autoActions: [] as string[], revision: 1 };
  const queries = Array.from({ length: 100 }, (_, index) => `资料${String(index).padStart(5, '0')}`);
  try {
    for (let index = 0; index < 20; index += 1) await librarySearch(ownerActor, queries[index % queries.length]!, {}, 0, 40, false);
    const searchDurationsMs: number[] = [];
    const results = [];
    for (const query of queries) {
      const started = performance.now();
      const result = await librarySearch(ownerActor, query, {}, 0, 40, false);
      searchDurationsMs.push(performance.now() - started);
      results.push(result);
    }
    let unauthorizedResultCount = 0;
    for (const query of queries) unauthorizedResultCount += (await librarySearch(outsider, query, {}, 0, 40, false)).items.length;
    expect(p95(searchDurationsMs)).toBeLessThanOrEqual(1000);
    expect(results.every((result) => result.total >= result.items.length)).toBe(true);
    expect(unauthorizedResultCount).toBe(0);
    const fileSize = (await stat(file)).size;
    const postings = await prisma.librarySearchPosting.count();
    console.log(JSON.stringify({
      ok: true,
      os: `${platform()} ${release()} ${arch()}`,
      cpu: cpus()[0]?.model ?? 'unknown',
      node: process.version,
      materialCount,
      chunkCount: materialCount * chunksPerMaterial,
      postingCount: postings,
      indexBytes: fileSize,
      p95Ms: p95(searchDurationsMs),
      maxMs: Math.max(...searchDurationsMs),
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
}

main();
