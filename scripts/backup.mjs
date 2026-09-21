import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, cp, access, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Stop the API and runner first so attachment and database snapshots describe the same point in time.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: resolve(root, 'server/.env') });
const databaseUrl = process.env.DATABASE_URL ?? 'file:../data/agent-studio.db';
if (!databaseUrl.startsWith('file:')) throw new Error('Only local SQLite databases are supported');
const source = resolve(root, 'server/prisma', databaseUrl.slice(5));
await access(source);
const destination = resolve(root, '.backups', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(destination, { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, resolve(destination, 'workspace.db')); } finally { db.close(); }
const directories = [
  { name: 'knowledge-blobs', path: resolve(process.env.KNOWLEDGE_STORAGE_ROOT ?? resolve(root, 'server/data/knowledge-blobs')) },
  { name: 'runner', path: resolve(process.env.WWA_RUNNER_DIR ?? resolve(root, 'server/runtime/runner')) },
];
const copied = [];
for (const entry of directories) {
  try { await access(entry.path); } catch { continue; }
  await cp(entry.path, resolve(destination, entry.name), { recursive: true, errorOnExist: true, force: false });
  copied.push(entry);
}
const restored = new DatabaseSync(resolve(destination, 'workspace.db'), { readOnly: true });
let counts;
try {
  const integrity = restored.prepare('PRAGMA integrity_check').get();
  if (Object.values(integrity)[0] !== 'ok') throw new Error('Backup failed SQLite integrity check');
  if (restored.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup has foreign-key errors');
  const tables = restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  counts = Object.fromEntries(tables.map(({ name }) => [name, restored.prepare(`SELECT COUNT(*) AS count FROM "${String(name).replaceAll('"', '""')}"`).get().count]));
} finally { restored.close(); }
await writeFile(resolve(destination, 'manifest.json'), JSON.stringify({ source, databaseFile: 'workspace.db', originalName: basename(source), directories: copied, counts, verifiedAt: new Date().toISOString(), restore: 'Stop API and all runners. Preserve current files separately. Copy workspace.db to source and restore each directory to its original path. Never restore while an execution is running.' }, null, 2));
console.log(`Backup verified: ${destination}`);
