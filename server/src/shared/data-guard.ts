import { mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }

/** SQLite owns the interprocess mutex: process death releases it without deleting another owner's lock. */
async function claim(root: string) {
  const file = `${resolve(root)}.dovun-guard.db`;
  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS guard (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE'); }
  catch { db.close(); throw new Error(`Workspace startup or migration is in progress. Retry after it finishes. Guard: ${file}`); }
  return () => db.close();
}
/** Guards live beside each data folder and never change the source tree. */
export async function exclusiveDataGuard(roots: string[]) {
  const held: Array<() => void> = [];
  try {
    for (const root of [...new Set(roots.map(path => resolve(path)))].sort()) {
      held.push(await claim(root));
      const leases = `${root}.dovun-writers`;
      if (existsSync(leases)) for (const file of await readdir(leases)) {
        const pid = Number(file.split('-')[0]);
        if (!pid || alive(pid)) throw new Error(`Stop all workspace services and executors before migration. Writer lease: ${leases}/${file}`);
        await rm(`${leases}/${file}`, { force: true });
      }
    }
    return async () => { for (const release of held.reverse()) release(); };
  } catch (error) { for (const release of held.reverse()) release(); throw error; }
}
/** Startup registers a lifetime lease while holding the same mutex as migration. */
export async function registerDataWriter(root: string) {
  const absolute = resolve(root), releaseGuard = await claim(absolute);
  try {
    const leases = `${absolute}.dovun-writers`; await mkdir(leases, { recursive: true });
    const file = `${leases}/${process.pid}-${randomUUID()}`;
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    const release = () => { rmSync(file, { force: true }); };
    process.once('exit', release);
    return release;
  } finally { releaseGuard(); }
}
