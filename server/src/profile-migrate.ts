import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { exclusiveDataGuard } from './shared/data-guard.js';

const receiptName = '.dovun-profile-migration.json';
type Entry = { path: string; sha256: string };
async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function entries(root: string): Promise<Entry[]> {
  const result: Entry[] = [];
  async function visit(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      if (dir === root && name === receiptName) continue;
      const path = join(dir, name), info = await lstat(path);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
        result.push({ path: relative(root, path), sha256: hash.digest('hex') });
      } else throw new Error('Profile contains a link or active special file. Stop the old app and inspect an offline copy.');
    }
  }
  await visit(root); return result;
}
async function canonical(path: string): Promise<string> {
  if (await exists(path)) return realpath(path);
  const parent = dirname(path); return parent === path ? path : join(await canonical(parent), basename(path));
}
const equal = (a: Entry[], b: Entry[]) => JSON.stringify(a) === JSON.stringify(b);

/** Whole browser profiles retain origin salts, local/session storage, IndexedDB and cookies together. */
export async function migrateProfileTree(sourcePath: string, targetPath: string, beforeSwitch?: () => Promise<void>) {
  if (!await exists(sourcePath)) return { status: 'absent' as const };
  if ((await lstat(sourcePath)).isSymbolicLink() || (await exists(targetPath) && (await lstat(targetPath)).isSymbolicLink())) throw new Error('Profile roots cannot be links.');
  const source = await realpath(sourcePath);
  const target = await canonical(resolve(targetPath));
  for (const [a, b] of [[source, target], [target, source]]) {
    const rel = relative(a, b); if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Profile roots must be separate.');
  }
  await mkdir(dirname(target), { recursive: true });
  const release = await exclusiveDataGuard([source, target]);
  const stage = `${target}.migration-${randomUUID()}`;
  try {
    const original = await entries(source);
    if (await exists(target) && (await readdir(target)).length) {
      let receipt: { source: string; entries: Entry[] } | undefined;
      try { receipt = JSON.parse(await readFile(join(target, receiptName), 'utf8')); } catch { /* Existing new state is never overwritten. */ }
      if (receipt?.source === source && equal(original, receipt.entries)) return { status: 'already-migrated' as const };
      throw new Error('Both browser profiles contain state. Back up both and choose a source; automatic overwrite is disabled.');
    }
    const backup = `${source}.backup-${randomUUID()}`;
    await cp(source, backup, { recursive: true, preserveTimestamps: true });
    if (!equal(original, await entries(backup))) throw new Error('Browser profile backup verification failed.');
    await cp(backup, stage, { recursive: true, preserveTimestamps: true });
    if (!equal(original, await entries(stage))) throw new Error('Browser profile copy verification failed.');
    await beforeSwitch?.();
    if (!equal(original, await entries(source))) throw new Error('Old browser profile changed during migration. Close the old app and retry.');
    await writeFile(join(stage, receiptName), JSON.stringify({ version: 1, source, backup, entries: original }), { mode: 0o600 });
    if (await exists(target)) await rmdir(target);
    await rename(stage, target);
    return { status: 'migrated' as const, backup, files: original.length };
  } finally { await release(); await rm(stage, { recursive: true, force: true }); }
}

export function profileRoots(platform: string, home: string, localAppData?: string) {
  if (platform === 'darwin') return ['WebKit', 'Application Support'].map(kind => ({ source: join(home, 'Library', kind, 'app.workwithagent.desktop'), target: join(home, 'Library', kind, 'app.dovun.desktop') }));
  if (platform === 'win32') {
    if (!localAppData) throw new Error('LOCALAPPDATA is required to restore the Windows browser profile.');
    return [{ source: join(localAppData, 'app.workwithagent.desktop'), target: join(localAppData, 'app.dovun.desktop') }];
  }
  throw new Error('Native browser profile migration is supported on macOS and Windows only.');
}
async function ensureOldAppStopped(parentPid: number) {
  const exec = promisify(execFile);
  if (process.platform === 'win32') {
    const script = `Get-Process -Name 'work-with-agent','dovun' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${parentPid} } | ForEach-Object { $_.Id }`;
    if ((await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })).stdout.trim()) throw new Error('Quit the previous desktop app before restoring browser state.');
  } else {
    const lines = (await exec('ps', ['-axo', 'pid=,comm='])).stdout.split('\n');
    if (lines.some(line => { const [pid, ...parts] = line.trim().split(/\s+/); const name = parts.join(' ').split('/').pop(); return Number(pid) !== parentPid && ['work-with-agent', 'dovun'].includes(name ?? ''); })) throw new Error('Quit the previous desktop app before restoring browser state.');
  }
}
export async function prepareNativeProfiles(pairs: Array<{ source: string; target: string }>, marker: string, ensureStopped: () => Promise<void>) {
  if (await exists(marker)) {
    const receipt = JSON.parse(await readFile(marker, 'utf8'));
    if (receipt.version !== 1 || JSON.stringify(receipt.pairs) !== JSON.stringify(pairs)) throw new Error('Invalid native profile migration receipt.');
    for (const target of receipt.importedTargets ?? []) if (!await exists(target)) throw new Error('An imported browser profile is missing. Restore its backup before starting.');
    return;
  }
  await ensureStopped();
  const importedTargets: string[] = [];
  for (const pair of pairs) {
    const result = await migrateProfileTree(pair.source, pair.target, ensureStopped);
    if (result.status !== 'absent') importedTargets.push(pair.target);
  }
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({ version: 1, pairs, importedTargets, completedAt: new Date().toISOString() }), { mode: 0o600 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parentPid = Number(process.argv[2]);
  if (!Number.isInteger(parentPid) || parentPid < 1) throw new Error('Missing desktop process identity.');
  const { homedir } = await import('node:os');
  const pairs = profileRoots(process.platform, homedir(), process.env.LOCALAPPDATA);
  const marker = join(dirname(pairs[pairs.length - 1].target), '.dovun-native-profiles.json');
  await prepareNativeProfiles(pairs, marker, () => ensureOldAppStopped(parentPid));
  console.log('Dovun browser profile prepared.');
}
