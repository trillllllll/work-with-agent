import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { migrateDatabase } from '../../db-migrate.js';
import { migrateLibrary } from './migrate.js';

const migrations = fileURLToPath(new URL('../../../prisma/migrations/', import.meta.url));
const libraryMigration = '20261013000000_library';

export type LibraryMigrationRehearsal = {
  report: {
    materialCountBefore: number;
    materialCountAfter: number;
    versionCountBefore: number;
    versionCountAfter: number;
    migratedLinkCount: number;
    danglingLegacyTaskIds: string[];
    missingBlobHashes: string[];
  };
  folderCountBefore: number;
  folderCountAfter: number;
  linkCountBefore: number;
  linkCountAfter: number;
  secondRun: LibraryMigrationRehearsal['report'];
  thirdRun: null;
};

function applySchemaBeforeLibrary(file: string) {
  const names = readdirSync(migrations).filter((name) => name !== 'migration_lock.toml' && name < libraryMigration).sort();
  const db = new DatabaseSync(file);
  try {
    for (const name of names) db.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'));
    db.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )`);
    const insert = db.prepare('INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)');
    for (const name of names) {
      const checksum = createHash('sha256').update(readFileSync(join(migrations, name, 'migration.sql'))).digest('hex');
      insert.run(randomUUID(), checksum, '2026-10-01 00:00:00', name, '2026-10-01 00:00:00');
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function applyMigrationsBeforeLibrary(file: string) {
  const db = applySchemaBeforeLibrary(file);
  try {
    const missingBlob = 'ab'.repeat(32);
    db.prepare('INSERT INTO topics (id, name) VALUES (?, ?)').run('migration-topic-1', '迁移清单');
    db.prepare('INSERT INTO tasks (id, topic_id, title) VALUES (?, ?, ?)').run('migration-task-1', 'migration-topic-1', '迁移任务');
    const material = db.prepare('INSERT INTO Material (id, topicId, taskId, kind, title, revision, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
    material.run('migration-material-linked', 'migration-topic-1', 'migration-task-1', 'text', '已关联资料', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    material.run('migration-material-dangling', null, 'missing-legacy-task', 'text', '悬空关联', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    material.run('migration-material-blob', null, null, 'attachment', '缺原件', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    const version = db.prepare('INSERT INTO MaterialVersion (id, materialId, revision, content, contentHash, metadata, attachmentPath, createdAt) VALUES (?, ?, 1, ?, ?, ?, ?, ?)');
    version.run('migration-version-linked', 'migration-material-linked', '已关联正文', 'c'.repeat(64), '{}', null, '2026-10-01T00:00:00.000Z');
    version.run('migration-version-dangling', 'migration-material-dangling', '悬空正文', 'd'.repeat(64), '{}', null, '2026-10-01T00:00:00.000Z');
    version.run('migration-version-blob', 'migration-material-blob', '', 'e'.repeat(64), '{}', missingBlob, '2026-10-01T00:00:00.000Z');
    return missingBlob;
  } finally {
    db.close();
  }
}

/** Upgrade an isolated pre-library database, then run the data migration again. */
export async function rehearseLibraryMigration(): Promise<LibraryMigrationRehearsal> {
  const directory = await mkdtemp(join(tmpdir(), 'wwa-library-migration-'));
  const file = join(directory, 'migrate.db');
  const databaseUrl = `file:${file}`;
  const previousKnowledge = process.env.KNOWLEDGE_STORAGE_ROOT;
  process.env.KNOWLEDGE_STORAGE_ROOT = join(directory, 'blobs');
  const missingBlob = applyMigrationsBeforeLibrary(file);
  try {
    await migrateDatabase(databaseUrl);
    const reportPath = join(directory, 'library-migration', 'report.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as LibraryMigrationRehearsal['report'];
    if (report.materialCountBefore !== 3 || report.materialCountAfter !== 3) throw new Error(`资料数量变化：${report.materialCountBefore} -> ${report.materialCountAfter}`);
    if (report.versionCountBefore !== 3 || report.versionCountAfter !== 3) throw new Error('版本数量变化');
    if (report.migratedLinkCount !== 1) throw new Error(`关联数量不是 1：${report.migratedLinkCount}`);
    if (!report.danglingLegacyTaskIds.includes('missing-legacy-task')) throw new Error('没有记录悬空旧任务');
    if (!report.missingBlobHashes.includes(missingBlob)) throw new Error('没有记录缺失原件');
    const client = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      const linked = await client.material.findUniqueOrThrow({ where: { id: 'migration-material-linked' } });
      const dangling = await client.material.findUniqueOrThrow({ where: { id: 'migration-material-dangling' } });
      if (linked.taskId !== 'migration-task-1' || dangling.taskId !== 'missing-legacy-task') throw new Error('迁移改写了旧 taskId');
      if (await client.materialTaskLink.count({ where: { materialId: 'migration-material-dangling' } }) !== 0) throw new Error('悬空任务被做成了关联');
      const link = await client.materialTaskLink.findUniqueOrThrow({ where: { materialId_taskId: { materialId: 'migration-material-linked', taskId: 'migration-task-1' } } });
      if (link.manual || !link.legacy) throw new Error('旧关联标志不正确');
      const failed = await client.materialExtraction.findUniqueOrThrow({ where: { materialId_revision: { materialId: 'migration-material-blob', revision: 1 } } });
      if (failed.status !== 'failed' || failed.errorCode !== 'MISSING_BLOB') throw new Error('缺失原件没有标成解析失败');
      const folderCountBefore = await client.libraryFolder.count();
      const linkCountBefore = await client.materialTaskLink.count();
      await migrateDatabase(databaseUrl);
      if (await client.libraryFolder.count() !== folderCountBefore || await client.materialTaskLink.count() !== linkCountBefore) throw new Error('再次执行数据库升级制造了重复数据');
      await client.$executeRaw`DELETE FROM app_data_migrations WHERE name = 'library-organization-v1'`;
      const secondRun = await migrateLibrary(client);
      if (!secondRun || secondRun.migratedLinkCount !== 0) throw new Error('删掉迁移标记后再次执行又新增了关联');
      const folderCountAfter = await client.libraryFolder.count();
      const linkCountAfter = await client.materialTaskLink.count();
      const thirdRun = await migrateLibrary(client);
      if (thirdRun !== null) throw new Error('迁移标记还在时又执行了一次');
      return { report, folderCountBefore, folderCountAfter, linkCountBefore, linkCountAfter, secondRun, thirdRun };
    } finally {
      await client.$disconnect();
    }
  } finally {
    if (previousKnowledge === undefined) delete process.env.KNOWLEDGE_STORAGE_ROOT;
    else process.env.KNOWLEDGE_STORAGE_ROOT = previousKnowledge;
    await rm(directory, { recursive: true, force: true });
  }
}

function topicFolderId(topicId: string) {
  return `migration-library-topic-${createHash('sha256').update(topicId).digest('hex').slice(0, 24)}`;
}

export type SameNameMigrationRehearsal = {
  identicalNames: string[];
  longNames: string[];
  nfkcNames: string[];
  report: LibraryMigrationRehearsal['report'];
  secondRun: null;
  renamedName: string;
  materialFolderId: string | null;
};

/** Three identical names, two 80-character names, and an NFKC pair stay unique without moving a later rename. */
export async function rehearseSameNameLibraryMigration(): Promise<SameNameMigrationRehearsal> {
  const directory = await mkdtemp(join(tmpdir(), 'wwa-library-same-name-'));
  const file = join(directory, 'same-name.db');
  const databaseUrl = `file:${file}`;
  const previousKnowledge = process.env.KNOWLEDGE_STORAGE_ROOT;
  process.env.KNOWLEDGE_STORAGE_ROOT = join(directory, 'blobs');
  const longName = '长'.repeat(80);
  const topics = [
    ['long-a', longName],
    ['long-b', longName],
    ['nfkc-a', 'ABC同名'],
    ['nfkc-b', 'ＡＢＣ同名'],
    ['same-a', '同名清单'],
    ['same-b', '同名清单'],
    ['same-c', '同名清单'],
  ] as const;
  const db = applySchemaBeforeLibrary(file);
  try {
    const topic = db.prepare('INSERT INTO topics (id, name) VALUES (?, ?)');
    const material = db.prepare('INSERT INTO Material (id, topicId, taskId, kind, title, revision, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
    const version = db.prepare('INSERT INTO MaterialVersion (id, materialId, revision, content, contentHash, metadata, attachmentPath, createdAt) VALUES (?, ?, 1, ?, ?, ?, ?, ?)');
    for (const [id, name] of topics) {
      topic.run(id, name);
      material.run(`material-${id}`, id, null, 'text', `资料${id}`, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
      version.run(`version-${id}`, `material-${id}`, `正文${id}`, 'f'.repeat(64), '{}', null, '2026-10-01T00:00:00.000Z');
    }
  } finally {
    db.close();
  }
  try {
    await migrateDatabase(databaseUrl);
    const client = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      const reportPath = join(directory, 'library-migration', 'report.json');
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as LibraryMigrationRehearsal['report'];
      const namesFor = async (ids: string[]) => {
        const folders = await Promise.all(ids.map((id) => client.libraryFolder.findUniqueOrThrow({ where: { id: topicFolderId(id) } })));
        return folders.map((folder) => folder.name);
      };
      const identicalNames = await namesFor(['same-a', 'same-b', 'same-c']);
      const longNames = await namesFor(['long-a', 'long-b']);
      const nfkcNames = await namesFor(['nfkc-a', 'nfkc-b']);
      const renamedId = topicFolderId('same-a');
      await client.libraryFolder.update({ where: { id: renamedId }, data: { name: '用户后来整理的文件夹', normalizedName: '用户后来整理的文件夹' } });
      await client.material.update({ where: { id: 'material-same-a' }, data: { folderId: null } });
      const secondRun = await migrateLibrary(client);
      const renamed = await client.libraryFolder.findUniqueOrThrow({ where: { id: renamedId } });
      const moved = await client.material.findUniqueOrThrow({ where: { id: 'material-same-a' } });
      return {
        identicalNames, longNames, nfkcNames, report,
        secondRun: secondRun as null,
        renamedName: renamed.name,
        materialFolderId: moved.folderId,
      };
    } finally {
      await client.$disconnect();
    }
  } finally {
    if (previousKnowledge === undefined) delete process.env.KNOWLEDGE_STORAGE_ROOT;
    else process.env.KNOWLEDGE_STORAGE_ROOT = previousKnowledge;
    await rm(directory, { recursive: true, force: true });
  }
}
