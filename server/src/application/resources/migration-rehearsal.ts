import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { migrateDatabase } from '../../db-migrate.js';
import { migrateDocumentResources } from './migrate.js';
import { versionContent, versionProjection } from './version.js';

const migrationRoot = fileURLToPath(new URL('../../../prisma/migrations/', import.meta.url));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type Inventory = {
  materials: number; versions: number; images: number; references: number; aliases: number;
  versionRows: Array<{ id: string; digest: string; original: string | null }>;
  imageRows: Array<{ id: string; digest: string; original: string }>;
  blobs: Array<{ hash: string; bytes: number | null; actualHash: string | null }>;
};

async function inventory(file: string, blobs: string): Promise<Inventory> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
    const versions = db.prepare('SELECT id, materialId, revision, content, contentHash, metadata, attachmentPath, mimeType, fileName, createdAt FROM MaterialVersion ORDER BY id').all() as Array<Record<string, unknown>>;
    const images = db.prepare('SELECT id, task_id, mime_type, byte_size, path, created_at FROM task_images ORDER BY id').all() as Array<Record<string, unknown>>;
    const hashes = [...new Set([...versions.map((row) => row.attachmentPath), ...images.map((row) => row.path)].filter((hash): hash is string => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)))].sort();
    const blobRows = [];
    for (const hash of hashes) {
      const bytes = await readFile(join(blobs, hash)).catch(() => null);
      blobRows.push({ hash, bytes: bytes?.byteLength ?? null, actualHash: bytes ? sha(bytes) : null });
    }
    const count = (table: string) => tables.has(table) ? Number((db.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as { count: number }).count) : 0;
    return {
      materials: count('Material'), versions: versions.length, images: images.length, references: count('ResourceReference'), aliases: count('ResourceLegacyAlias'),
      versionRows: versions.map((row) => ({ id: String(row.id), digest: sha(JSON.stringify(row)), original: row.attachmentPath as string | null })),
      imageRows: images.map((row) => ({ id: String(row.id), digest: sha(JSON.stringify(row)), original: String(row.path) })), blobs: blobRows,
    };
  } finally { db.close(); }
}

async function synthetic(file: string, blobs: string) {
  const names = readdirSync(migrationRoot).filter((name) => name !== 'migration_lock.toml' && name < '20261107000000_document_resources').sort();
  const db = new DatabaseSync(file);
  try {
    for (const name of names) db.exec(readFileSync(join(migrationRoot, name, 'migration.sql'), 'utf8'));
    db.exec('CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, finished_at DATETIME, migration_name TEXT NOT NULL, logs TEXT, rolled_back_at DATETIME, started_at DATETIME NOT NULL DEFAULT current_timestamp, applied_steps_count INTEGER NOT NULL DEFAULT 0)');
    const addMigration = db.prepare('INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, ?, ?, 1)');
    for (const name of names) addMigration.run(randomUUID(), sha(readFileSync(join(migrationRoot, name, 'migration.sql'))), '2026-10-30 00:00:00', name);
    const now = '2026-10-30T00:00:00.000Z';
    db.prepare('INSERT INTO topics (id,name) VALUES (?,?)').run('fixture-topic', '合成迁移清单');
    db.prepare('INSERT INTO tasks (id,topic_id,title,description) VALUES (?,?,?,?)').run('fixture-task', 'fixture-topic', '合成任务', '![旧图](/api/tasks/fixture-task/images/fixture-image)');
    const originals = [Buffer.from('\ufeff# Markdown 来源\r\n\r\n|甲|乙|\r\n|-|-|\r\n|1|2|\r\n'), Buffer.from([0xff, 0xd8, 0xff, 7, 8, 9]), Buffer.from('历史文件原件')];
    for (const bytes of originals) await writeFile(join(blobs, sha(bytes)), bytes);
    const addMaterial = db.prepare('INSERT INTO Material (id,topicId,kind,title,revision,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)');
    addMaterial.run('fixture-markdown', 'fixture-topic', 'attachment', '混合旧资料', 2, now, now);
    addMaterial.run('fixture-text', null, 'text', '旧纯文本', 1, now, now);
    const addVersion = db.prepare('INSERT INTO MaterialVersion (id,materialId,revision,content,contentHash,metadata,attachmentPath,mimeType,fileName,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
    addVersion.run('fixture-v1', 'fixture-markdown', 1, '旧版本补充说明', 'historical-hash-1', '{"source":"legacy"}', sha(originals[2]), 'application/octet-stream', '原始.bin', now);
    addVersion.run('fixture-v2', 'fixture-markdown', 2, '当前版本补充说明', 'historical-hash-2', '{"source":"legacy"}', sha(originals[0]), 'text/markdown', '来源.md', now);
    addVersion.run('fixture-v3', 'fixture-text', 1, '# 这是纯文本，不应自动当成 Markdown', 'historical-hash-3', '{}', null, null, null, now);
    db.prepare('INSERT INTO task_images (id,task_id,mime_type,byte_size,path,created_at) VALUES (?,?,?,?,?,?)').run('fixture-image', 'fixture-task', 'image/jpeg', originals[1].byteLength, sha(originals[1]), now);
  } finally { db.close(); }
}

/** A source is opened read-only and cloned with SQLite backup. Only the isolated clone is migrated. */
export async function rehearseDocumentMigration(options: { sourceDatabase?: string; sourceBlobs?: string; outputDirectory?: string } = {}) {
  if (Boolean(options.sourceDatabase) !== Boolean(options.sourceBlobs)) throw new Error('Both sourceDatabase and sourceBlobs are required');
  const directory = options.outputDirectory ? resolve(options.outputDirectory) : await mkdtemp('/tmp/dovun-document-migration-');
  if (!directory.startsWith('/tmp/')) throw new Error('Migration rehearsal output must be under /tmp/');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'rehearsal.db');
  const blobs = join(directory, 'blobs');
  await mkdir(blobs, { recursive: true });
  if (options.sourceDatabase && options.sourceBlobs) {
    execFileSync('sqlite3', ['-readonly', resolve(options.sourceDatabase), `.backup '${file.replaceAll("'", "''")}'`], { timeout: 60_000, stdio: 'pipe' });
    const source = await inventory(file, resolve(options.sourceBlobs));
    for (const blob of source.blobs) if (blob.bytes !== null) await copyFile(join(resolve(options.sourceBlobs), blob.hash), join(blobs, blob.hash));
  } else await synthetic(file, blobs);
  const before = await inventory(file, blobs);
  const previousRoot = process.env.KNOWLEDGE_STORAGE_ROOT;
  process.env.KNOWLEDGE_STORAGE_ROOT = blobs;
  const db = new PrismaClient({ datasourceUrl: `file:${file}` });
  try {
    await migrateDatabase(`file:${file}`);
    const after = await inventory(file, blobs);
    const versions = new Map(after.versionRows.map((row) => [row.id, row.digest]));
    const images = new Map(after.imageRows.map((row) => [row.id, row.digest]));
    const bytes = new Map(after.blobs.map((row) => [row.hash, row]));
    const preservedVersions = before.versionRows.every((row) => versions.get(row.id) === row.digest);
    const preservedImages = before.imageRows.every((row) => images.get(row.id) === row.digest);
    const preservedBlobs = before.blobs.every((row) => JSON.stringify(bytes.get(row.hash)) === JSON.stringify(row));
    if (!preservedVersions || !preservedImages || !preservedBlobs) throw new Error('Migration changed legacy version, image or blob evidence');
    const secondRun = await migrateDocumentResources(db);
    const repeated = await inventory(file, blobs);
    if (JSON.stringify(after) !== JSON.stringify(repeated)) throw new Error('Second migration was not idempotent');
    const mapped = await db.resourceLegacyAlias.count({ where: { sourceKind: 'task-image' } });
    const current = await db.materialVersion.findFirst({ where: { materialId: 'fixture-markdown', revision: 2 } });
    const compatibilityRead = current ? {
      format: current.format, unchangedEvidenceHash: current.contentHash === 'historical-hash-2',
      mainBodyHash: sha(String(versionContent('attachment', current))), supplementHash: sha(current.supplementalContent ?? ''),
      projectionHash: sha(versionProjection('attachment', current)),
    } : null;
    const report = { ok: true, fixture: options.sourceDatabase ? 'read-only-source-snapshot' : 'synthetic-legacy-mixed-content', before, after, secondRun, mappedTaskImages: mapped, preservedVersions, preservedImages, preservedBlobs, compatibilityRead, limitation: 'This verifies additive migration and compatibility reads. It does not claim an older installed client or mobile device has passed rollback acceptance.' };
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
    return { directory, report };
  } finally {
    await db.$disconnect();
    if (previousRoot === undefined) delete process.env.KNOWLEDGE_STORAGE_ROOT; else process.env.KNOWLEDGE_STORAGE_ROOT = previousRoot;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceAt = process.argv.indexOf('--source');
  const blobsAt = process.argv.indexOf('--blobs');
  rehearseDocumentMigration({ ...(sourceAt < 0 ? {} : { sourceDatabase: process.argv[sourceAt + 1] }), ...(blobsAt < 0 ? {} : { sourceBlobs: process.argv[blobsAt + 1] }) })
    .then(({ directory, report }) => console.log(JSON.stringify({ directory, ok: report.ok, before: { materials: report.before.materials, versions: report.before.versions, images: report.before.images, bytes: report.before.blobs.reduce((sum, row) => sum + (row.bytes ?? 0), 0) }, after: { materials: report.after.materials, versions: report.after.versions, aliases: report.after.aliases }, secondRun: report.secondRun, preservedVersions: report.preservedVersions, preservedImages: report.preservedImages, preservedBlobs: report.preservedBlobs }, null, 2)))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
