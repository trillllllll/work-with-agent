import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from '../domain/task.js';

export type SnapshotMergeCounts = { inserted: number; skipped: number };

const mergeScript = String.raw`
import { DatabaseSync } from 'node:sqlite';

const livePath = process.argv[2];
const incomingPath = process.argv[3];
const db = new DatabaseSync(livePath);
const skip = new Set(['_prisma_migrations', 'LocalSession', 'local_sessions', 'app_settings', 'LibraryUpload', 'RequestReceipt', 'app_data_migrations', 'sync_ops', 'sync_devices', 'sync_conflicts', 'sync_outbox', 'sync_state']);
const derived = new Set(['MaterialExtraction', 'MaterialChunk', 'LibrarySearchDocument', 'LibrarySearchNormMap', 'LibrarySearchPosting']);

function q(name) {
  return '"' + String(name).replaceAll('"', '""') + '"';
}
function names(schema) {
  return db.prepare("SELECT name FROM " + schema + ".sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
}
function columns(schema, table) {
  return db.prepare('PRAGMA ' + schema + '.table_info(' + q(table) + ')').all().map((row) => row.name);
}
function count(schema, table) {
  return db.prepare('SELECT COUNT(*) AS n FROM ' + schema + '.' + q(table)).get().n;
}

const before = new Map();
const incomingCount = new Map();
const touched = [];
let mainTables = new Set();
let incomingTables = new Set();

function insert(table, whereSql) {
  if (!mainTables.has(table) || !incomingTables.has(table)) return;
  const liveColumns = columns('main', table);
  const incomingColumns = columns('incoming', table);
  if (liveColumns.join('\0') !== incomingColumns.join('\0')) throw new Error('表 ' + table + ' 的列与当前库不一致');
  const cols = liveColumns.map(q).join(', ');
  before.set(table, count('main', table));
  incomingCount.set(table, count('incoming', table));
  touched.push(table);
  db.prepare('INSERT OR IGNORE INTO main.' + q(table) + ' (' + cols + ') SELECT ' + cols + ' FROM incoming.' + q(table) + ' AS src ' + whereSql).run();
}

try {
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec("ATTACH DATABASE '" + incomingPath.replaceAll("'", "''") + "' AS incoming");
  mainTables = new Set(names('main'));
  incomingTables = new Set(names('incoming'));
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  if (mainTables.has('MaterialVersion')) {
    db.exec('CREATE TEMP TABLE versions_before (id TEXT PRIMARY KEY)');
    db.exec('INSERT INTO versions_before SELECT id FROM main."MaterialVersion"');
  }
  for (const table of mainTables) {
    if (skip.has(table) || derived.has(table) || !incomingTables.has(table)) continue;
    insert(table, '');
  }
  db.exec('CREATE TEMP TABLE merged_material_versions (id TEXT PRIMARY KEY, materialId TEXT, revision INTEGER)');
  if (mainTables.has('MaterialVersion')) {
    db.exec('INSERT INTO merged_material_versions (id, materialId, revision) SELECT id, materialId, revision FROM main."MaterialVersion" WHERE id NOT IN (SELECT id FROM versions_before)');
  }
  if (mainTables.has('MaterialExtraction')) {
    db.exec('CREATE TEMP TABLE extractions_before (id TEXT PRIMARY KEY)');
    db.exec('INSERT INTO extractions_before SELECT id FROM main."MaterialExtraction"');
  }
  insert('MaterialExtraction', 'WHERE EXISTS (SELECT 1 FROM merged_material_versions v WHERE v.materialId = src.materialId AND v.revision = src.revision)');
  db.exec('CREATE TEMP TABLE merged_extractions (id TEXT PRIMARY KEY)');
  if (mainTables.has('MaterialExtraction')) {
    db.exec('INSERT INTO merged_extractions SELECT id FROM main."MaterialExtraction" WHERE id NOT IN (SELECT id FROM extractions_before)');
  }
  insert('MaterialChunk', 'WHERE src.extractionId IN (SELECT id FROM merged_extractions)');
  if (mainTables.has('LibrarySearchDocument')) {
    db.exec('CREATE TEMP TABLE search_docs_before (id TEXT PRIMARY KEY)');
    db.exec('INSERT INTO search_docs_before SELECT id FROM main."LibrarySearchDocument"');
  }
  insert('LibrarySearchDocument', 'WHERE EXISTS (SELECT 1 FROM merged_material_versions v WHERE v.materialId = src.materialId AND v.revision = src.revision)');
  db.exec('CREATE TEMP TABLE merged_search_docs (id TEXT PRIMARY KEY)');
  if (mainTables.has('LibrarySearchDocument')) {
    db.exec('INSERT INTO merged_search_docs SELECT id FROM main."LibrarySearchDocument" WHERE id NOT IN (SELECT id FROM search_docs_before)');
  }
  insert('LibrarySearchNormMap', 'WHERE src.documentId IN (SELECT id FROM merged_search_docs)');
  insert('LibrarySearchPosting', 'WHERE src.documentId IN (SELECT id FROM merged_search_docs)');
  for (let pass = 0; pass < 10; pass += 1) {
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (!bad.length) break;
    for (const row of bad) db.prepare('DELETE FROM main.' + q(row.table) + ' WHERE rowid = ?').run(row.rowid);
  }
  const left = db.prepare('PRAGMA foreign_key_check').all();
  if (left.length) throw new Error('并入后仍有 ' + left.length + ' 条外键错误');
  let inserted = 0;
  let skipped = 0;
  for (const table of touched) {
    const gained = Math.max(0, count('main', table) - before.get(table));
    inserted += gained;
    skipped += Math.max(0, incomingCount.get(table) - gained);
  }
  db.exec('COMMIT');
  process.stdout.write(JSON.stringify({ inserted, skipped }));
} catch (error) {
  try { db.exec('ROLLBACK'); } catch { /* The transaction may not have started. */ }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  db.close();
}
`;

/** Inserts snapshot rows whose primary key is absent. Runs in a child process so node:sqlite can open the live file. */
export async function mergeSnapshotDatabase(livePath: string, incomingPath: string): Promise<SnapshotMergeCounts> {
  const directory = await mkdtemp(join(tmpdir(), 'wwa-merge-script-'));
  const script = join(directory, 'merge.mjs');
  try {
    await writeFile(script, mergeScript);
    const stdout = execFileSync(process.execPath, ['--experimental-sqlite', script, livePath, incomingPath], { encoding: 'utf8' });
    const parsed = JSON.parse(stdout) as Partial<SnapshotMergeCounts>;
    if (typeof parsed.inserted !== 'number' || typeof parsed.skipped !== 'number') throw new Error('并入结果缺少计数');
    return { inserted: parsed.inserted, skipped: parsed.skipped };
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error && error.stderr ? String(error.stderr).trim() : error instanceof Error ? error.message : String(error);
    throw new DomainError('SNAPSHOT_MERGE_FAILED', `并入快照失败：${detail}`, 500);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
