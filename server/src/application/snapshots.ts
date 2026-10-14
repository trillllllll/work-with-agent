import { existsSync, readdirSync, renameSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import type { Readable } from 'node:stream';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
import { serverVersion } from './security.js';
import { desktopDataDir } from './desktop-paths.js';
import { knowledgeStorageRoot } from './knowledge-blobs.js';
import { mergeSnapshotDatabase } from './snapshot-merge.js';

const appVersion = serverVersion;

/** Everything a restore needs to prove compatibility before touching live data. */
export type SnapshotManifest = {
  appVersion: string;
  schemaVersion: string;
  exportedAt: string;
};

function serverRoot() {
  // src/application/snapshots.ts and dist/application/snapshots.js both resolve two levels up to the server package.
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function migrationsRoot() {
  return join(serverRoot(), 'prisma', 'migrations');
}

/** The newest migration shipped with this build, e.g. 20261013020000_library_search_layout. */
export function localSchemaVersion() {
  const names = existsSync(migrationsRoot()) ? readdirSync(migrationsRoot()).filter((name) => /^\d{14}_/.test(name)).sort() : [];
  return names.at(-1) ?? 'unknown';
}

export function databasePath() {
  const url = process.env.DATABASE_URL ?? '';
  const filePath = url.startsWith('file:') ? url.slice('file:'.length) : url;
  if (!filePath) throw new DomainError('DATABASE_URL_MISSING', '未配置数据库路径', 500);
  return resolve(serverRoot(), filePath);
}

export function snapshotsDir() {
  return join(desktopDataDir(), 'snapshots');
}

function manifestOf(): SnapshotManifest {
  return { appVersion, schemaVersion: localSchemaVersion(), exportedAt: new Date().toISOString() };
}

export function snapshotFileName(manifest: SnapshotManifest) {
  const stamp = manifest.exportedAt.replace(/[:.]/g, '-');
  return `wwa-snapshot-${stamp}.zip`;
}

async function vacuumIntoCopy(target: string) {
  const literal = `'${target.replace(/'/g, "''")}'`;
  await prisma.$executeRawUnsafe(`VACUUM INTO ${literal}`);
}

/** Builds a full workspace snapshot in memory: manifest, consistent SQLite copy, and all knowledge blobs. */
export async function createSnapshot(): Promise<{ bytes: Buffer; manifest: SnapshotManifest }> {
  const manifest = manifestOf();
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const staging = await mkdtemp(join(tmpdir(), 'wwa-snapshot-'));
  try {
    const dbCopy = join(staging, 'agent-studio.db');
    await vacuumIntoCopy(dbCopy);
    zip.file('agent-studio.db', await readFile(dbCopy));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const blobsRoot = knowledgeStorageRoot();
  if (existsSync(blobsRoot)) {
    for (const name of await readdir(blobsRoot)) {
      const info = await stat(join(blobsRoot, name)).catch(() => null);
      if (info?.isFile() && !name.startsWith('.')) zip.file(`knowledge-blobs/${name}`, await readFile(join(blobsRoot, name)));
    }
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 3 } });
  return { bytes, manifest };
}

/** Keeps a copy of the live workspace in the data directory before a destructive operation. */
export async function writeBackupSnapshot(label: string) {
  const { bytes, manifest } = await createSnapshot();
  const directory = snapshotsDir();
  await mkdir(directory, { recursive: true });
  const file = join(directory, `before-${label}-${snapshotFileName(manifest)}`);
  await writeFile(file, bytes);
  return file;
}

async function readManifest(zip: JSZip): Promise<SnapshotManifest> {
  const entry = zip.file('manifest.json');
  if (!entry) throw new DomainError('SNAPSHOT_INVALID', '快照缺少 manifest.json', 400);
  const parsed = JSON.parse(await entry.async('string')) as Partial<SnapshotManifest>;
  if (!parsed.schemaVersion || !parsed.appVersion) throw new DomainError('SNAPSHOT_INVALID', '快照信息不完整', 400);
  return { appVersion: parsed.appVersion, schemaVersion: parsed.schemaVersion, exportedAt: parsed.exportedAt ?? '' };
}

function assertCompatible(manifest: SnapshotManifest) {
  if (manifest.schemaVersion > localSchemaVersion()) {
    throw new DomainError('SNAPSHOT_NEWER_SCHEMA', `快照来自更新的版本（${manifest.schemaVersion}），请先把本服务升级到同版本再导入`, 400);
  }
}

type ImportOptions = { backup?: boolean; mode?: 'merge' | 'replace' };

async function copySnapshotBlobs(zip: JSZip) {
  const blobsRoot = knowledgeStorageRoot();
  await mkdir(blobsRoot, { recursive: true });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.startsWith('knowledge-blobs/') && !entry.name.slice('knowledge-blobs/'.length).includes('/'));
  for (const entry of entries) {
    const name = entry.name.slice('knowledge-blobs/'.length);
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const target = join(blobsRoot, name);
    if (existsSync(target)) continue;
    await writeFile(target, await entry.async('nodebuffer'));
  }
}

/**
 * Validates a snapshot and either stages a full database replace or merges rows
 * into the live database. Replace finishes in {@link applyPendingImport} on the
 * next startup, because the open SQLite file cannot be swapped on Windows.
 * Merge keeps existing primary keys, adds missing rows, and leaves live-only rows.
 */
export async function importSnapshot(zipBytes: Buffer, options: ImportOptions = {}) {
  const mode = options.mode ?? 'replace';
  const zip = await JSZip.loadAsync(zipBytes).catch(() => { throw new DomainError('SNAPSHOT_INVALID', '无法读取快照文件', 400); });
  const manifest = await readManifest(zip);
  assertCompatible(manifest);
  const dbEntry = zip.file('agent-studio.db');
  if (!dbEntry) throw new DomainError('SNAPSHOT_INVALID', '快照缺少数据库文件', 400);
  if (options.backup !== false) await writeBackupSnapshot('import');
  const live = databasePath();
  await mkdir(dirname(live), { recursive: true });
  const dbBytes = await dbEntry.async('nodebuffer');
  await copySnapshotBlobs(zip);
  if (mode === 'merge') {
    if (!existsSync(live)) throw new DomainError('SNAPSHOT_MERGE_FAILED', '当前数据库不存在，无法并入', 500);
    const staging = await mkdtemp(join(tmpdir(), 'wwa-snapshot-merge-'));
    try {
      const incoming = join(staging, 'incoming.db');
      await writeFile(incoming, dbBytes);
      const { migrateDatabase } = await import('../db-migrate.js');
      await migrateDatabase(`file:${incoming}`);
      const counts = await mergeSnapshotDatabase(live, incoming);
      return { manifest, mode, ...counts };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await writeFile(`${live}.pending-import`, dbBytes);
  return { manifest, mode, inserted: 0, skipped: 0 };
}

/** Moves a staged import into place. Called at startup, when no SQLite connection exists yet. */
export function applyPendingImport() {
  const live = databasePath();
  const pending = `${live}.pending-import`;
  if (!existsSync(pending)) return false;
  try { renameSync(live, `${live}.before-import`); } catch { /* First boot has no live database. */ }
  renameSync(pending, live);
  console.log('已应用导入的快照数据库');
  return true;
}

/** First deployment convenience: seed.zip in the snapshots directory restores before the first migration runs. */
export async function maybeSeedSnapshot() {
  const seed = join(snapshotsDir(), 'seed.zip');
  if (!existsSync(seed) || existsSync(databasePath())) return null;
  const result = await importSnapshot(await readFile(seed), { backup: false });
  applyPendingImport();
  await unlink(seed).catch(() => {});
  console.log(`已从 seed.zip 导入工作区（导出版本 ${result.manifest.appVersion}）`);
  return result;
}

/** Streams an upload body to a file, refusing bodies larger than the cap. */
export function streamToDisk(stream: Readable, target: string, maxBytes: number) {
  return new Promise<void>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy();
        reject(new DomainError('SNAPSHOT_TOO_LARGE', `快照文件不能超过 ${Math.floor(maxBytes / 1_048_576)} MiB`, 413));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => { void writeFile(target, Buffer.concat(chunks)).then(resolvePromise, reject); });
    stream.on('error', reject);
  });
}

/** Lists operator-created snapshots (backups and seeds) with size and time. */
export async function listSnapshots() {
  const directory = snapshotsDir();
  if (!existsSync(directory)) return [];
  const names = (await readdir(directory)).filter((name) => name.endsWith('.zip')).sort().reverse();
  return Promise.all(names.map(async (name) => {
    const info = await stat(join(directory, name));
    return { name, size: info.size, createdAt: info.mtime.toISOString() };
  }));
}

const snapshotScheduleMs = 24 * 60 * 60_000;

/** Exit with a dedicated code so container restart policies bring the service back on the new database. */
export function scheduleRestart() {
  if (process.env.VITEST) return;
  setTimeout(() => process.exit(75), 1_000).unref();
}

/** Optional daily snapshots into WWA_SNAPSHOT_DIR, keeping the newest WWA_SNAPSHOT_KEEP files. */
export function startSnapshotScheduler() {
  const configured = process.env.WWA_SNAPSHOT_DIR?.trim();
  if (!configured) return () => {};
  const target = resolve(desktopDataDir(), configured);
  const keep = Math.max(1, Number(process.env.WWA_SNAPSHOT_KEEP) || 7);
  const run = async () => {
    try {
      const { bytes, manifest } = await createSnapshot();
      await mkdir(target, { recursive: true });
      await writeFile(join(target, snapshotFileName(manifest)), bytes);
      const stale = (await readdir(target)).filter((name) => name.endsWith('.zip')).sort().slice(0, -keep);
      for (const name of stale) await unlink(join(target, name)).catch(() => {});
      console.log(`已创建定时快照 ${snapshotFileName(manifest)}（保留 ${keep} 份）`);
    } catch (error) {
      console.error('定时快照失败：', error);
    }
  };
  const timer = setInterval(() => { void run(); }, snapshotScheduleMs);
  timer.unref();
  setTimeout(() => { void run(); }, 60_000).unref();
  return () => clearInterval(timer);
}
