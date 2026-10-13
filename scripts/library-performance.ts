import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir, cpus, platform, release, arch } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import type { Actor } from '../server/src/application/security.ts';
import type { LibraryFilters } from '../server/src/application/library/schema.ts';

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (!Object.is(actual, expected)) throw new Error(`expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    },
    toBeLessThanOrEqual(expected: number) {
      if (typeof actual !== 'number' || actual > expected) throw new Error(`expected ${String(actual)} <= ${expected}`);
    },
    toEqual(expected: unknown) {
      const left = JSON.stringify(actual);
      const right = JSON.stringify(expected);
      if (left !== right) throw new Error(`expected ${right}, received ${left}`);
    },
  };
}

function p95(durationsMs: number[]) {
  const sorted = [...durationsMs].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
}

type Audience = 'owner' | 'limited';

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'wwa-library-perf-'));
  const file = join(directory, 'perf.db');
  const databaseUrl = `file:${file}`;
  if (databaseUrl.includes('agent-studio')) throw new Error('refusing to use a work database');
  process.env.DATABASE_URL = databaseUrl;
  process.env.KNOWLEDGE_STORAGE_ROOT = join(directory, 'blobs');

  const materialCount = 10_000;
  const chunksPerMaterial = 4;
  const chunkWidth = 1200;
  const visibleUntil = 5_000;
  const inboxUntil = 7_500;

  try {
    const { migrateDatabase } = await import('../server/src/db-migrate.ts');
    await migrateDatabase(databaseUrl);
    const { indexTokens, normalizeWithMap } = await import('../server/src/application/library/text.ts');
    const cycle = Array.from('海盐蓝鲸abc合同甲乙丙丁');
    const bodyUnits: string[] = [];
    while (bodyUnits.length < chunkWidth) bodyUnits.push(cycle[bodyUnits.length % cycle.length]!);
    const commonBody = bodyUnits.join('');
    if (Array.from(commonBody).length !== chunkWidth) throw new Error('common body is not 1200 code points');
    const commonMapped = normalizeWithMap(commonBody);
    const emptyMapped = normalizeWithMap('');
    const mappedCache = new Map<string, { normalized: string; mapJson: string; tokens: string[] }>();
    const mappedText = (text: string) => {
      const cached = mappedCache.get(text);
      if (cached) return cached;
      const mapped = text === commonBody ? commonMapped : text === '' ? emptyMapped : normalizeWithMap(text);
      const stored = { normalized: mapped.normalized, mapJson: JSON.stringify(mapped.map), tokens: [...indexTokens(mapped.normalized)] };
      mappedCache.set(text, stored);
      return stored;
    };
    mappedText(commonBody);
    mappedText('');
    const rareTerm = (slot: number) => String.fromCodePoint(0xE000 + slot * 4, 0xE001 + slot * 4, 0xE002 + slot * 4, 0xE003 + slot * 4);
    const rareByIndex = new Map<number, string>();
    for (let slot = 0; slot < 10; slot += 1) {
      rareByIndex.set(slot, rareTerm(slot));
      rareByIndex.set(9000 + slot, rareTerm(100 + slot));
    }
    const bodyFor = (index: number) => {
      const rare = rareByIndex.get(index);
      if (!rare) return commonBody;
      const body = rare + commonBody.slice(rare.length);
      if (Array.from(body).length !== chunkWidth) throw new Error(`body ${index} is not 1200 code points`);
      return body;
    };
    const topicOf = (index: number) => (index < visibleUntil ? 'perf-topic' : index < inboxUntil ? null : 'perf-secret');
    const folderOf = (index: number) => (index % 2 === 0 ? 'perf-folder-0' : 'perf-folder-1');
    const tagIdsOf = (index: number) => [`perf-tag-${index % 8}`, `perf-tag-${(index + 3) % 8}`];
    const taskIdsOf = (index: number) => Array.from({ length: index % 4 }, (_, taskIndex) => `perf-task-${taskIndex}`);
    const matches = (index: number, filters: LibraryFilters, audience: Audience) => {
      if (audience === 'limited' && topicOf(index) !== 'perf-topic') return false;
      if (filters.folderId && folderOf(index) !== filters.folderId) return false;
      if (filters.tagIds?.length && !filters.tagIds.every((id) => tagIdsOf(index).includes(id))) return false;
      if (filters.taskId && !taskIdsOf(index).includes(filters.taskId)) return false;
      if (filters.taskTopicId === 'inbox') return false;
      if (filters.taskTopicId && filters.taskTopicId !== 'perf-topic') return false;
      if (filters.taskTopicId && taskIdsOf(index).length === 0) return false;
      return true;
    };
    const countMatches = (filters: LibraryFilters, audience: Audience) => {
      let count = 0;
      for (let index = 0; index < materialCount; index += 1) if (matches(index, filters, audience)) count += 1;
      return count;
    };

    const stamp = '2026-10-13T00:00:00.000Z';
    const tagNames = ['标签甲', '标签乙', '标签丙', '标签丁', '标签戊', '标签己', '标签庚', '标签辛'];
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('BEGIN');
      const topic = db.prepare('INSERT INTO topics (id, name) VALUES (?, ?)');
      topic.run('perf-topic', '性能清单');
      topic.run('perf-secret', '隐藏清单');
      topic.run('perf-hidden-topic', '无权清单');
      const folder = db.prepare('INSERT INTO LibraryFolder (id, parentId, name, normalizedName, revision, createdAt, updatedAt) VALUES (?, NULL, ?, ?, 1, ?, ?)');
      folder.run('perf-folder-0', '文件夹甲', '文件夹甲', stamp, stamp);
      folder.run('perf-folder-1', '文件夹乙', '文件夹乙', stamp, stamp);
      const tag = db.prepare('INSERT INTO LibraryTag (id, name, normalizedName, revision, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)');
      tagNames.forEach((name, index) => tag.run(`perf-tag-${index}`, name, name, stamp, stamp));
      const task = db.prepare('INSERT INTO tasks (id, topic_id, title) VALUES (?, ?, ?)');
      for (let index = 0; index < 4; index += 1) task.run(`perf-task-${index}`, 'perf-topic', `性能任务${index}`);
      const material = db.prepare('INSERT INTO Material (id, topicId, taskId, folderId, kind, title, revision, organizationRevision, archivedAt, createdAt, updatedAt) VALUES (?, ?, NULL, ?, ?, ?, 1, 1, NULL, ?, ?)');
      const version = db.prepare('INSERT INTO MaterialVersion (id, materialId, revision, content, contentHash, metadata, fileName, mimeType, createdAt) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)');
      const extraction = db.prepare(`INSERT INTO MaterialExtraction (id, materialId, revision, parserVersion, status, generation, indexedGeneration, attempts, nextAttemptAt, errorsJson, createdAt, updatedAt) VALUES (?, ?, 1, 'library-v1', 'ready', 1, 1, 1, ?, '[]', ?, ?)`);
      const chunk = db.prepare(`INSERT INTO MaterialChunk (id, extractionId, generation, ordinal, text, textHash, locatorJson, method, createdAt) VALUES (?, ?, 1, ?, ?, ?, ?, 'native', ?)`);
      const link = db.prepare(`INSERT INTO MaterialTaskLink (materialId, taskId, manual, legacy, createdAt, createdBy) VALUES (?, ?, 1, 0, ?, 'perf')`);
      const tagLink = db.prepare('INSERT INTO MaterialTag (materialId, tagId) VALUES (?, ?)');
      const document = db.prepare('INSERT INTO LibrarySearchDocument (id, materialId, revision, chunkId, titleNorm, fileNameNorm, tagsNorm, bodyNorm, normalizationMapJson) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)');
      const normMap = db.prepare('INSERT INTO LibrarySearchNormMap (documentId, normalizationMapJson) VALUES (?, ?)');
      const posting = db.prepare('INSERT INTO LibrarySearchPosting (token, documentId, materialId) VALUES (?, ?, ?)');
      const contentHash = 'f'.repeat(64);
      for (let index = 0; index < materialCount; index += 1) {
        const id = `perf-m-${String(index).padStart(5, '0')}`;
        const title = `资料${String(index).padStart(5, '0')}`;
        const fileName = `${title}.txt`;
        const tags = tagIdsOf(index).map((tagId) => tagNames[Number(tagId.slice('perf-tag-'.length))]!);
        const body = bodyFor(index);
        const bodyMapped = mappedText(body);
        material.run(id, topicOf(index), folderOf(index), 'text', title, stamp, stamp);
        version.run(`perf-v-${id}`, id, body, contentHash, '{}', fileName, 'text/plain', stamp);
        extraction.run(`perf-e-${id}`, id, stamp, stamp, stamp);
        const titleMapped = mappedText(title);
        const fileNameMapped = mappedText(fileName);
        const tagsMapped = mappedText(tags.join(' '));
        const metaId = `perf-d-${id}`;
        document.run(metaId, id, null, titleMapped.normalized, fileNameMapped.normalized, tagsMapped.normalized, emptyMapped.normalized, '[]');
        const metaTokens = new Set([...titleMapped.tokens, ...fileNameMapped.tokens, ...tagsMapped.tokens]);
        for (const token of metaTokens) posting.run(token, metaId, id);
        for (let ordinal = 0; ordinal < chunksPerMaterial; ordinal += 1) {
          const chunkId = `perf-c-${id}-${ordinal}`;
          chunk.run(chunkId, `perf-e-${id}`, ordinal, body, contentHash, JSON.stringify({ kind: 'line', startLine: ordinal + 1, endLine: ordinal + 1, start: 0, end: chunkWidth }), stamp);
          const documentId = `perf-d-${chunkId}`;
          document.run(documentId, id, chunkId, titleMapped.normalized, fileNameMapped.normalized, tagsMapped.normalized, bodyMapped.normalized, '[]');
          normMap.run(documentId, bodyMapped.mapJson);
          const tokens = new Set<string>([...titleMapped.tokens, ...fileNameMapped.tokens, ...tagsMapped.tokens, ...bodyMapped.tokens]);
          for (const token of tokens) posting.run(token, documentId, id);
        }
        for (const tagId of tagIdsOf(index)) tagLink.run(id, tagId);
        for (const taskId of taskIdsOf(index)) link.run(id, taskId, stamp);
        if (index > 0 && index % 500 === 0) {
          db.exec('COMMIT');
          db.exec('BEGIN');
          process.stderr.write(`indexed ${index}\n`);
        }
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }

    const { prisma } = await import('../server/src/infrastructure/prisma.ts');
    const { librarySearch } = await import('../server/src/application/library/search.ts');
    const { ownerActor } = await import('../server/src/application/security.ts');
    const limited: Actor = { id: 'perf-limited', kind: 'connection', topicIds: ['perf-topic'], includeInbox: false, autoActions: [], revision: 1 };
    const outsider: Actor = { id: 'perf-outsider', kind: 'connection', topicIds: ['perf-hidden-topic'], includeInbox: false, autoActions: [], revision: 1 };
    const commonTerms = ['海盐蓝鲸', '盐蓝鲸a', '蓝鲸ab', '鲸abc', 'abc合', 'bc合同', 'c合同甲', '合同甲乙', '同甲乙丙', '甲乙丙丁', '乙丙丁海', '丙丁海盐', '丁海盐蓝', '海盐蓝', '盐蓝鲸', '蓝鲸a', '合同甲', '甲乙丙', '乙丙丁', '丙丁海'];
    const filtered: LibraryFilters[] = [
      { folderId: 'perf-folder-0' },
      { folderId: 'perf-folder-1' },
      { tagIds: ['perf-tag-0'] },
      { tagIds: ['perf-tag-1'] },
      { tagIds: ['perf-tag-2'] },
      { tagIds: ['perf-tag-3'] },
      { tagIds: ['perf-tag-4'] },
      { tagIds: ['perf-tag-5'] },
      { tagIds: ['perf-tag-6'] },
      { tagIds: ['perf-tag-7'] },
      { taskId: 'perf-task-0' },
      { taskId: 'perf-task-1' },
      { taskId: 'perf-task-2' },
      { taskTopicId: 'perf-topic' },
      { folderId: 'perf-folder-0', taskId: 'perf-task-0' },
      { folderId: 'perf-folder-1', taskId: 'perf-task-0' },
      { folderId: 'perf-folder-0', taskTopicId: 'perf-topic' },
      { folderId: 'perf-folder-1', taskId: 'perf-task-1' },
      { tagIds: ['perf-tag-1'], taskId: 'perf-task-0' },
      { folderId: 'perf-folder-0', tagIds: ['perf-tag-2'], taskId: 'perf-task-0' },
    ];
    const exactIndexes = [0, 100, 250, 500, 750, 1000, 2000, 3000, 4000, 4999, 5000, 6000, 7000, 7499, 8000, 8500, 9000, 9500, 9900, 9999];
    type Sample = { query: string; filters: LibraryFilters; actor: Actor; expectedTotal: number; expectedId?: string };
    const groups: Array<{ name: string; samples: Sample[] }> = [
      {
        name: 'exactFilename',
        samples: exactIndexes.map((index) => ({
          query: `资料${String(index).padStart(5, '0')}.txt`,
          filters: {},
          actor: ownerActor,
          expectedTotal: 1,
          expectedId: `perf-m-${String(index).padStart(5, '0')}`,
        })),
      },
      {
        name: 'rareBody',
        samples: [...rareByIndex.entries()].sort((left, right) => left[0] - right[0]).map(([index, query]) => ({
          query,
          filters: {},
          actor: ownerActor,
          expectedTotal: 1,
          expectedId: `perf-m-${String(index).padStart(5, '0')}`,
        })),
      },
      {
        name: 'commonBody',
        samples: commonTerms.map((query) => ({ query, filters: {}, actor: ownerActor, expectedTotal: materialCount })),
      },
      {
        name: 'filteredBody',
        samples: filtered.map((filters) => ({ query: '海盐蓝鲸', filters, actor: ownerActor, expectedTotal: countMatches(filters, 'owner') })),
      },
      {
        name: 'limitedConnection',
        samples: [
          ...Array.from({ length: 14 }, () => ({ query: '海盐蓝鲸', filters: {} as LibraryFilters, actor: limited, expectedTotal: visibleUntil })),
          ...[0, 1, 2].map((index) => ({ query: rareByIndex.get(index)!, filters: {} as LibraryFilters, actor: limited, expectedTotal: 1, expectedId: `perf-m-${String(index).padStart(5, '0')}` })),
          ...[9000, 9001, 9002].map((index) => ({ query: rareByIndex.get(index)!, filters: {} as LibraryFilters, actor: limited, expectedTotal: 0 })),
        ],
      },
    ];
    if (groups.some((group) => group.samples.length !== 20)) throw new Error('each performance group must contain 20 queries');
    if (groups.find((group) => group.name === 'filteredBody')!.samples.some((sample) => sample.expectedTotal < 1000)) {
      throw new Error(`filtered totals collapsed: ${groups.find((group) => group.name === 'filteredBody')!.samples.map((sample) => sample.expectedTotal).join(',')}`);
    }

    try {
      for (let index = 0; index < 20; index += 1) {
        const sample = groups[index % groups.length]!.samples[index % 20]!;
        await librarySearch(sample.actor, sample.query, sample.filters, 0, 40, false);
      }
      const measurements = [];
      const actualTotals: number[] = [];
      const expectedTotals: number[] = [];
      const identityMismatches: string[] = [];
      for (const group of groups) {
        const durationsMs: number[] = [];
        for (const sample of group.samples) {
          const started = performance.now();
          const result = await librarySearch(sample.actor, sample.query, sample.filters, 0, 40, false);
          durationsMs.push(performance.now() - started);
          actualTotals.push(result.total);
          expectedTotals.push(sample.expectedTotal);
          if (result.total !== sample.expectedTotal) process.stderr.write(`total mismatch ${group.name} ${sample.query} ${JSON.stringify(sample.filters)} expected ${sample.expectedTotal} actual ${result.total}\n`);
          if (sample.expectedId && result.items[0]?.id !== sample.expectedId) identityMismatches.push(`${group.name} ${sample.query} expected ${sample.expectedId} received ${result.items[0]?.id ?? 'none'}`);
          if (result.items.length > 40 || result.total < result.items.length) identityMismatches.push(`${group.name} ${sample.query} page ${result.items.length} total ${result.total}`);
        }
        const groupP95 = p95(durationsMs);
        measurements.push({ name: group.name, queries: group.samples.length, p95Ms: groupP95, maxMs: Math.max(...durationsMs), expectedTotals: group.samples.map((sample) => sample.expectedTotal) });
        process.stderr.write(`group ${group.name} p95 ${groupP95.toFixed(1)} max ${Math.max(...durationsMs).toFixed(1)}\n`);
      }
      let unauthorizedResultCount = 0;
      for (const group of groups) {
        for (const sample of group.samples) {
          const hidden = await librarySearch(outsider, sample.query, sample.filters, 0, 40, false);
          unauthorizedResultCount += hidden.items.length;
          expect(hidden.total).toBe(0);
        }
      }
      const fileSize = (await stat(file)).size;
      const postings = await prisma.librarySearchPosting.count();
      const report = {
        ok: measurements.every((group) => group.p95Ms <= 1000) && unauthorizedResultCount === 0 && JSON.stringify(actualTotals) === JSON.stringify(expectedTotals),
        os: `${platform()} ${release()} ${arch()}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        node: process.version,
        materialCount,
        chunkCount: materialCount * chunksPerMaterial,
        chunkWidth,
        postingCount: postings,
        indexBytes: fileSize,
        preFixBodyP95Ms: 3247,
        preFixNote: '修复前正文查询“海盐蓝鲸”的 P95，是本轮基线，不是生产用户延迟统计',
        unauthorizedResultCount,
        identityMismatches,
        groups: measurements,
      };
      console.log(JSON.stringify(report, null, 2));
      for (const group of measurements) expect(group.p95Ms).toBeLessThanOrEqual(1000);
      expect(unauthorizedResultCount).toBe(0);
      expect(actualTotals).toEqual(expectedTotals);
      expect(identityMismatches).toEqual([]);
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
