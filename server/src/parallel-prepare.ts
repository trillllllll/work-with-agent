import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
/** A copied device credential must never automatically join the old executor or sync account. */
export async function isolateImportedBindings(data: string) {
  if (!await exists(join(data, '.dovun-migration.json'))) return;
  const marker = join(data, '.dovun-independent.json');
  if (await exists(marker)) {
    if (JSON.parse(await readFile(marker, 'utf8')).version !== 1) throw new Error('Invalid independent workspace receipt');
    return;
  }
  const archive = join(data, 'migration-disabled-bindings');
  await mkdir(archive, { recursive: true, mode: 0o700 });
  for (const [old, name] of [['node/config.json', 'node-config.json'], ['sync-device.json', 'sync-device.json']]) {
    const source = join(data, old), target = join(archive, name);
    if (await exists(source)) {
      if (await exists(target)) throw new Error('Imported binding archive conflicts with current binding. No credentials were overwritten.');
      await rename(source, target);
    }
  }
  const migration = JSON.parse(await readFile(join(data, '.dovun-migration.json'), 'utf8'));
  const changes: Record<string, number> = {};
  if (await exists(join(data, 'dovun.db'))) {
    const db = new DatabaseSync(join(data, 'dovun.db'));
    try {
      db.exec('BEGIN IMMEDIATE');
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      for (const table of ['ReviewRule', 'AutoMemoryScope']) {
        if (tables.has(table)) changes[table] = Number(db.prepare(`UPDATE "${table}" SET enabled=0 WHERE enabled=1`).run().changes);
      }
      // History paths stored by the runner must resolve to the independent copy.
      if (tables.has('Artifact') && typeof migration.source === 'string') {
        const rows = db.prepare('SELECT id, path FROM Artifact WHERE path IS NOT NULL').all();
        for (const row of rows) {
          if (typeof row.path === 'string' && row.path.startsWith(migration.source + '/')) {
            db.prepare('UPDATE Artifact SET path=? WHERE id=?').run(data + row.path.slice(migration.source.length), row.id as string);
          }
        }
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { db.close(); }
  }
  await writeFile(marker, JSON.stringify({ version: 1, disabled: ['executor binding', 'replica sync binding', 'scheduled reviews', 'automatic memory'], changes, completedAt: new Date().toISOString() }), { mode: 0o600 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = process.argv[2]; if (!data) throw new Error('Missing data directory');
  await isolateImportedBindings(data);
}
