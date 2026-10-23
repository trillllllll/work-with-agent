import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exclusiveDataGuard } from './shared/data-guard.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

async function fileHash(path: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }

type Entry = { path: string; sha256?: string; link?: string };
type Receipt = { version: 1; source: string; backup: string; entries: Entry[]; createdAt: string };
const receiptName = '.dovun-migration.json';
async function exists(path: string) { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
function mapped(path: string) { return path.replace(/^agent-studio\.db(?=$|-)/, 'dovun.db'); }
function durableEntries(entries: Entry[]) {
  // The shell refreshes this compatibility launcher only after a successful migration.
  return entries.filter(entry => entry.path.replace(/\\/g, '/') !== 'bin/wwa-mcp');
}
async function manifest(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  async function visit(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      if (dir === root && name === receiptName) continue;
      const path = join(dir, name), stat = await lstat(path), key = relative(root, path);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isSymbolicLink()) throw new Error(`Migration cannot safely copy a symbolic link: ${key}. Materialize it in a separate offline source copy first.`);
      else if (stat.isFile()) entries.push({ path: key, sha256: await fileHash(path) });
      else throw new Error(`Migration cannot copy an active special file: ${key}. Stop all local services first.`);
    }
  }
  await visit(root);
  return entries;
}
function assertDatabase(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA quick_check').get();
    if (!check || Object.values(check)[0] !== 'ok') throw new Error('Database integrity check failed.');
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()) throw new Error('Source is not a workspace database.');
  } finally { db.close(); }
}
function verify(actual: Entry[], expected: Entry[]) {
  const sorted = (entries: Entry[]) => [...entries].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected))) throw new Error('Migration verification failed; the original folder has been retained.');
}
async function ensureLegacyExecutorStopped(source: string) {
  const exec = promisify(execFile);
  let output: string;
  if (process.platform === 'win32') {
    const encoded = Buffer.from(source, 'utf8').toString('base64');
    const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -and $_.CommandLine.Contains('--data') -and $_.CommandLine.Contains($p) } | ForEach-Object { $_.ProcessId }`;
    output = (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })).stdout.trim();
  } else {
    const lines = (await exec('ps', ['-axo', 'pid=,args='])).stdout.split('\n');
    output = lines.filter(line => { const pid = Number(line.trim().split(/\s+/, 1)[0]); return pid !== process.pid && line.includes('--data') && line.includes(join(source, 'node')); }).map(line => line.trim().split(/\s+/, 1)[0]).join(',');
  }
  if (output) throw new Error('Stop the old desktop executor before migrating. No data was switched.');
}
async function ensureStopped(port: number) {
  const busy = await new Promise<boolean>((done, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', (e: NodeJS.ErrnoException) => { if (e.code === 'ECONNREFUSED') done(false); else reject(e); });
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Cannot verify that the local service has stopped.')); });
  });
  if (busy) throw new Error('Stop the local workspace before migrating data.');
}

async function canonicalFolder(path: string): Promise<string> {
  if (await exists(path)) return realpath(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return join(await canonicalFolder(parent), basename(path));
}

/** Offline copy-and-verify migration. Never merges two workspaces or modifies the source. */
export async function migrateDesktopData(input: { source: string; target: string; port?: number; failAfterCopy?: boolean; beforeVerify?: () => Promise<void> }) {
  const requested = [resolve(input.source), resolve(input.target)];
  for (const path of requested) if (await exists(path) && (await lstat(path)).isSymbolicLink()) throw new Error('Migration roots cannot be symbolic links.');
  const [source, target] = await Promise.all(requested.map(canonicalFolder));
  const inside = (parent: string, child: string) => { const rel = relative(parent, child); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); };
  if (inside(source, target) || inside(target, source)) throw new Error('Source and target must be separate folders.');
  await ensureStopped(input.port ?? 47316);
  await mkdir(dirname(target), { recursive: true });
  const releaseGuard = await exclusiveDataGuard([source, target]);
  const stage = `${target}.migration-${randomUUID()}`;
  try {
    await ensureLegacyExecutorStopped(source);
    const hasLegacyDatabase = await exists(join(source, 'agent-studio.db'));
    const hasCurrentDatabase = await exists(join(source, 'dovun.db'));
    if (hasLegacyDatabase && hasCurrentDatabase) throw new Error('Both source database names exist; back up both and choose a source.');
    const hasDatabase = hasLegacyDatabase || hasCurrentDatabase;
    if (!hasDatabase) {
      // Never silently start an empty workspace over an unrecognized old folder.
      if (!await exists(source) || !(await readdir(source)).length) return { status: 'fresh' as const, target };
      let launcher: { mode?: string } = {};
      try { launcher = JSON.parse(await readFile(join(source, 'launcher.json'), 'utf8')); } catch { /* Unknown data is not a fresh install. */ }
      if (!['local', 'remote'].includes(launcher.mode ?? '') || (await readdir(source)).some(name => !['launcher.json', 'node', 'logs', 'bin'].includes(name))) throw new Error('Old data exists but its database is missing. Inspect the source before continuing.');
    }
    const entries = await manifest(source);
    if (await exists(target) && (await readdir(target)).length) {
      let receipt: Receipt | null = null;
      try { receipt = JSON.parse(await readFile(join(target, receiptName), 'utf8')); } catch { /* A preexisting workspace is a conflict. */ }
      if (receipt?.version === 1 && receipt.source === source && JSON.stringify(durableEntries(receipt.entries)) === JSON.stringify(durableEntries(entries))) {
        if (hasDatabase) assertDatabase(join(target, 'dovun.db'));
        return { status: 'already-migrated' as const, target, backup: receipt.backup };
      }
      throw new Error('Both old and new data exist. Choose the source explicitly after backing up both; automatic merging or replacement is disabled.');
    }
    const backup = `${source}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    await cp(source, backup, { recursive: true, preserveTimestamps: true, dereference: false, verbatimSymlinks: true });
    verify(await manifest(backup), entries);
    await cp(backup, stage, { recursive: true, preserveTimestamps: true, dereference: false, verbatimSymlinks: true });
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const old = join(stage, `agent-studio.db${suffix}`);
      if (await exists(old)) await rename(old, join(stage, `dovun.db${suffix}`));
    }
    verify(await manifest(stage), entries.map(item => ({ ...item, path: mapped(item.path) })).sort((a,b) => a.path.localeCompare(b.path, 'en')));
    await input.beforeVerify?.();
    await ensureLegacyExecutorStopped(source);
    await ensureStopped(input.port ?? 47316);
    verify(await manifest(source), entries);
    if (hasDatabase) assertDatabase(join(stage, 'dovun.db'));
    if (input.failAfterCopy) throw new Error('Injected interruption before switching folders.');
    const receipt: Receipt = { version: 1, source, backup, entries, createdAt: new Date().toISOString() };
    await writeFile(join(stage, receiptName), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    // This only removes a previously verified empty directory; never a workspace.
    if (await exists(target)) await rmdir(target);
    await rename(stage, target);
    return { status: 'migrated' as const, target, backup, files: entries.length };
  } finally {
    await releaseGuard();
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, target, portText] = process.argv.slice(2);
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid service port');
  if (!source || !target) throw new Error('Usage: desktop-migrate <old-folder> <new-folder>');
  migrateDesktopData({ source, target, port }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
