import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { knowledgeStorageRoot } from '../knowledge-blobs.js';
import { libraryNow } from './access.js';
import { writeMetaDocument } from './index-docs.js';
import { codePointLength, displayName } from './text.js';

const migrationName = 'library-organization-v1';
const rootId = 'migration-library-root-v1';

function clippedName(base: string, suffix: string) {
  const normalized = base.normalize('NFKC').trim().replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, ' ');
  const room = 80 - codePointLength(suffix);
  const clipped = Array.from(normalized).slice(0, Math.max(0, room)).join('').trim() || '资料';
  return displayName(`${clipped}${suffix}`, 1, 80);
}

function siblingName(base: string, source: string, taken: Set<string>) {
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const hashSuffix = ` [${digest}]`;
  let named = clippedName(base, hashSuffix);
  let serial = 2;
  while (!named || taken.has(named.normalizedName)) {
    named = clippedName(base, `${hashSuffix} ${serial}`);
    serial += 1;
  }
  return named;
}

export type LibraryMigrationReport = {
  materialCountBefore: number;
  materialCountAfter: number;
  versionCountBefore: number;
  versionCountAfter: number;
  migratedLinkCount: number;
  danglingLegacyTaskIds: string[];
  missingBlobHashes: string[];
};

export async function migrateLibrary(prisma: PrismaClient) {
  const ready = await prisma.$queryRaw<Array<{ name: string }>>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'LibraryFolder'`;
  if (!ready.length) return null;
  const done = await prisma.$queryRaw<Array<{ name: string }>>`SELECT name FROM app_data_migrations WHERE name = ${migrationName}`;
  if (done.length) return null;
  const report = await prisma.$transaction(async (tx) => {
    const again = await tx.$queryRaw<Array<{ name: string }>>`SELECT name FROM app_data_migrations WHERE name = ${migrationName}`;
    if (again.length) return null;
    const materialCountBefore = await tx.material.count();
    const versionCountBefore = await tx.materialVersion.count();
    const timestamp = libraryNow();
    const rootName = displayName('原有资料', 1, 80)!;
    await tx.libraryFolder.upsert({ where: { id: rootId }, create: { id: rootId, parentId: null, ...rootName, createdAt: timestamp, updatedAt: timestamp }, update: {} });
    const materials = await tx.material.findMany();
    const topicIds = [...new Set(materials.map((material) => material.topicId))].sort((left, right) => (left ?? '').localeCompare(right ?? ''));
    const folderByTopic = new Map<string, string>();
    const taken = new Set((await tx.libraryFolder.findMany({ where: { parentId: rootId }, select: { normalizedName: true } })).map((folder) => folder.normalizedName));
    for (const topicId of topicIds) {
      const key = topicId ?? '';
      const id = topicId ? `migration-library-topic-${createHash('sha256').update(topicId).digest('hex').slice(0, 24)}` : 'migration-library-inbox-v1';
      const existing = await tx.libraryFolder.findUnique({ where: { id } });
      if (existing) {
        taken.add(existing.normalizedName);
        folderByTopic.set(key, id);
        continue;
      }
      const topic = topicId ? await tx.topic.findUnique({ where: { id: topicId } }) : null;
      const base = topic?.name ?? (topicId ? `原清单 ${topicId}` : '收集箱');
      let named = displayName(base, 1, 80) ?? displayName('原有资料', 1, 80)!;
      if (taken.has(named.normalizedName)) named = siblingName(base, topicId ?? 'inbox', taken);
      taken.add(named.normalizedName);
      await tx.libraryFolder.create({ data: { id, parentId: rootId, ...named, createdAt: timestamp, updatedAt: timestamp } });
      folderByTopic.set(key, id);
    }
    const dangling = new Set<string>();
    let migratedLinkCount = 0;
    const missing = new Set<string>();
    for (const material of materials) {
      const folderId = folderByTopic.get(material.topicId ?? '') ?? rootId;
      await tx.material.update({ where: { id: material.id }, data: { folderId, organizationRevision: 1 } });
      if (material.taskId) {
        const task = await tx.task.findUnique({ where: { id: material.taskId } });
        if (!task) dangling.add(material.taskId);
        else {
          const existing = await tx.materialTaskLink.findUnique({ where: { materialId_taskId: { materialId: material.id, taskId: task.id } } });
          if (!existing) {
            await tx.materialTaskLink.create({ data: { materialId: material.id, taskId: task.id, manual: false, legacy: true, createdAt: material.createdAt || timestamp, createdBy: 'migration' } });
            migratedLinkCount += 1;
          }
        }
      }
      const versions = await tx.materialVersion.findMany({ where: { materialId: material.id } });
      for (const version of versions) {
        let failed = false;
        if (version.attachmentPath) {
          const hash = version.attachmentPath;
          if (!/^[a-f0-9]{64}$/.test(hash)) { failed = true; missing.add(hash); }
          else {
            try { await access(resolve(knowledgeStorageRoot(), hash)); }
            catch { failed = true; missing.add(hash); }
          }
        }
        await tx.materialExtraction.upsert({
          where: { materialId_revision: { materialId: material.id, revision: version.revision } },
          create: { id: randomUUID(), materialId: material.id, revision: version.revision, status: failed ? 'failed' : 'queued', errorCode: failed ? 'MISSING_BLOB' : null, errorsJson: '[]', nextAttemptAt: timestamp, createdAt: timestamp, updatedAt: timestamp },
          update: {},
        });
        await writeMetaDocument(tx, material, version, []);
      }
    }
    const body: LibraryMigrationReport = {
      materialCountBefore, materialCountAfter: await tx.material.count(),
      versionCountBefore, versionCountAfter: await tx.materialVersion.count(),
      migratedLinkCount, danglingLegacyTaskIds: [...dangling].sort(), missingBlobHashes: [...missing].sort(),
    };
    const databases = await tx.$queryRaw<Array<{ name: string; file: string }>>`PRAGMA database_list`;
    const source = databases.find((db) => db.name === 'main')?.file;
    let reportPath: string | null = null;
    if (source && source !== '') {
      const directory = join(dirname(source), 'library-migration');
      await mkdir(directory, { recursive: true });
      reportPath = join(directory, 'report.json');
      await writeFile(reportPath, JSON.stringify(body, null, 2));
    }
    await tx.$executeRaw`INSERT INTO app_data_migrations (name, completed_at, report_path) VALUES (${migrationName}, ${timestamp}, ${reportPath})`;
    return body;
  }, { timeout: 120_000 });
  return report;
}
