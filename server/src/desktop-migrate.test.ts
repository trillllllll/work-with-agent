import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { registerDataWriter } from './shared/data-guard.js';
import { migrateDesktopData } from './desktop-migrate.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dovun-migration-')); roots.push(root);
  const source = join(root, 'old workspace'), target = join(root, 'dovun');
  await mkdir(join(source, 'knowledge-blobs'), { recursive: true });
  const db = new DatabaseSync(join(source, 'agent-studio.db'));
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT); INSERT INTO tasks VALUES ('same-id', '中文正文');"); db.close();
  await writeFile(join(source, 'knowledge-blobs', 'original.bin'), Buffer.from([0, 1, 255]));
  await writeFile(join(source, 'launcher.json'), '{"mode":"local"}');
  await mkdir(join(source, 'bin')); await writeFile(join(source, 'bin', 'wwa-mcp'), '#!/bin/sh\nold launcher');
  await mkdir(join(source, 'runner')); await writeFile(join(source, 'runner', 'event.json'), '{"kept":true}');
  const probe = createServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(done => probe.close(() => done()));
  return { root, source, target, port };
}
describe('offline Dovun data migration', () => {
  it('copies database, blobs, execution and launcher state exactly; reruns preserve subsequent new data', async () => {
    const f = await fixture(); const before = await readFile(join(f.source, 'agent-studio.db'));
    const result = await migrateDesktopData(f);
    expect(result.status).toBe('migrated');
    expect(await readFile(join(f.target, 'dovun.db'))).toEqual(before);
    expect(await readFile(join(f.source, 'agent-studio.db'))).toEqual(before);
    expect(await readFile(join(result.backup!, 'agent-studio.db'))).toEqual(before);
    expect(await readFile(join(f.target, 'knowledge-blobs', 'original.bin'))).toEqual(Buffer.from([0, 1, 255]));
    expect(await readFile(join(f.target, 'runner', 'event.json'), 'utf8')).toBe('{"kept":true}');
    const db = new DatabaseSync(join(f.target, 'dovun.db')); db.exec("INSERT INTO tasks VALUES ('new-id', 'new work')"); db.close();
    await writeFile(join(f.source, 'bin', 'wwa-mcp'), '#!/bin/sh\nnew compatibility launcher');
    expect((await migrateDesktopData(f)).status).toBe('already-migrated');
    const check = new DatabaseSync(join(f.target, 'dovun.db')); expect(check.prepare('SELECT count(*) AS n FROM tasks').get()!.n).toBe(2); check.close();
  });
  it('retains the old workspace and verified backup after interruption, then retries cleanly', async () => {
    const f = await fixture();
    await expect(migrateDesktopData({ ...f, failAfterCopy: true })).rejects.toThrow('Injected interruption');
    expect(await readdir(f.root)).not.toContain('dovun');
    expect((await readdir(f.root)).some(name => name.startsWith('old workspace.backup-'))).toBe(true);
    expect((await migrateDesktopData(f)).status).toBe('migrated');
  });
  it('stops on conflicting workspaces without overwriting either source', async () => {
    const f = await fixture(); await mkdir(f.target); await writeFile(join(f.target, 'important.txt'), 'keep');
    await expect(migrateDesktopData(f)).rejects.toThrow('Both old and new data exist');
    expect(await readFile(join(f.target, 'important.txt'), 'utf8')).toBe('keep');
  });
  it('rejects invalid databases and nested targets, and never treats partial old data as fresh', async () => {
    const f = await fixture();
    await expect(migrateDesktopData({ ...f, target: join(f.source, 'nested') })).rejects.toThrow('separate folders');
    await writeFile(join(f.source, 'agent-studio.db'), 'broken');
    await expect(migrateDesktopData(f)).rejects.toThrow();
    await rm(join(f.source, 'agent-studio.db'));
    await expect(migrateDesktopData(f)).rejects.toThrow('database is missing');
  });
  it('detects a running local service before copying', async () => {
    const f = await fixture(); const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    try { await expect(migrateDesktopData({ ...f, port: (server.address() as { port: number }).port })).rejects.toThrow('Stop the local workspace'); }
    finally { await new Promise<void>(done => server.close(() => done())); }
  });
  it('migrates a remote-only launcher without inventing a local database', async () => {
    const f = await fixture(); await rm(f.source, { recursive: true }); await mkdir(f.source);
    await writeFile(join(f.source, 'launcher.json'), '{"mode":"remote","remoteUrl":"https://workspace.example"}');
    expect((await migrateDesktopData(f)).status).toBe('migrated');
    expect(await readdir(f.target)).not.toContain('dovun.db');
  });
  it('rejects database and blob links before creating a backup', async () => {
    const f = await fixture(); await symlink(join(f.source, 'agent-studio.db'), join(f.source, 'linked.db'));
    await expect(migrateDesktopData(f)).rejects.toThrow('symbolic link');
    expect((await readdir(f.root)).some(name => name.includes('backup-'))).toBe(false);
  });
  it('preserves relative executor dependency links without reading outside the worktree', async () => {
    const f = await fixture();
    const dependency = join(f.source, 'node/worktrees/project/attempt/node_modules');
    await mkdir(join(dependency, '.bin'), { recursive: true });
    await mkdir(join(dependency, 'tool')); await writeFile(join(dependency, 'tool/cli.js'), 'inert dependency');
    await symlink('../tool/cli.js', join(dependency, '.bin/tool'));
    expect((await migrateDesktopData(f)).status).toBe('migrated');
    expect(await readFile(join(f.target, 'node/worktrees/project/attempt/node_modules/.bin/tool'), 'utf8')).toBe('inert dependency');
  });
  it('rejects executor links escaping their own worktree', async () => {
    const f = await fixture(); const dir = join(f.source, 'node/worktrees/project/attempt');
    await mkdir(dir, { recursive: true }); await symlink('../../../../agent-studio.db', join(dir, 'escape'));
    await expect(migrateDesktopData(f)).rejects.toThrow('symbolic link');
  });
  it('blocks startup for the full migration', async () => {
    const f = await fixture();
    const result = await migrateDesktopData({ ...f, beforeVerify: async () => {
      await expect(registerDataWriter(f.source)).rejects.toThrow('migration is in progress');
      await expect(registerDataWriter(f.target)).rejects.toThrow('migration is in progress');

    } });
    expect(result.status).toBe('migrated');
    const release = await registerDataWriter(f.target); release();
  });
  it('does not migrate while a desktop executor holds its lifetime lease', async () => {
    const f = await fixture(); const release = await registerDataWriter(f.source);
    try { await expect(migrateDesktopData(f)).rejects.toThrow('Stop all workspace services and executors'); }
    finally { release(); }
    expect((await migrateDesktopData(f)).status).toBe('migrated');
  });
  it('detects an uncoordinated legacy blob write and aborts the switch', async () => {
    const f = await fixture();
    await expect(migrateDesktopData({ ...f, beforeVerify: async () => { await writeFile(join(f.source, 'runner', 'late.json'), 'new'); } })).rejects.toThrow('verification failed');
    expect(await readdir(f.root)).not.toContain('dovun');
    expect(await readFile(join(f.source, 'runner', 'late.json'), 'utf8')).toBe('new');
  });
  it('preserves an unclean WAL source byte for byte and can repeat after migration', async () => {
    const f = await fixture();
    const code = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA journal_mode=WAL; INSERT INTO tasks VALUES ('wal-only','pending WAL work')"); process.send('ready'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', code, join(f.source, 'agent-studio.db')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await once(child, 'message'); child.kill('SIGKILL'); await once(child, 'exit');
    const names = ['agent-studio.db', 'agent-studio.db-wal', 'agent-studio.db-shm'];
    const before = await Promise.all(names.map(name => readFile(join(f.source, name))));
    expect((await migrateDesktopData(f)).status).toBe('migrated');
    expect(await Promise.all(names.map(name => readFile(join(f.source, name))))).toEqual(before);
    expect((await migrateDesktopData(f)).status).toBe('already-migrated');
    const db = new DatabaseSync(join(f.target, 'dovun.db')); expect(db.prepare("SELECT title FROM tasks WHERE id='wal-only'").get()!.title).toBe('pending WAL work'); db.close();
  });
  it('recovers the OS mutex after a forced process exit', async () => {
    const f = await fixture(); const lock = `${f.target}.dovun-guard.db`;
    const code = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('CREATE TABLE guard(id INTEGER);BEGIN IMMEDIATE');process.send('ready');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', code, lock], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await once(child, 'message');
    await expect(migrateDesktopData(f)).rejects.toThrow('migration is in progress');
    child.kill('SIGKILL'); await once(child, 'exit');
    expect((await migrateDesktopData(f)).status).toBe('migrated');
  });
  it('imports an already Dovun-named database and rejects two source database names', async () => {
    const f = await fixture(); await rename(join(f.source, 'agent-studio.db'), join(f.source, 'dovun.db'));
    expect((await migrateDesktopData(f)).status).toBe('migrated');
    await writeFile(join(f.source, 'agent-studio.db'), 'ambiguous');
    await expect(migrateDesktopData(f)).rejects.toThrow('Both source database names');
  });
  it('rejects nested destinations reached through an aliased parent', async () => {
    if (process.platform === 'win32') return;
    const f = await fixture(); const alias = join(f.root, 'alias'); await symlink(f.source, alias);
    await expect(migrateDesktopData({ ...f, target: join(alias, 'nested') })).rejects.toThrow('separate folders');
  });
  it('recognizes a fresh install and supports platform paths with spaces', async () => {
    const f = await fixture(); await rm(f.source, { recursive: true });
    expect((await migrateDesktopData(f)).status).toBe('fresh');
    expect(win32.join('C:\\Users\\test user\\AppData\\Local', 'dovun', 'dovun.db')).toBe('C:\\Users\\test user\\AppData\\Local\\dovun\\dovun.db');
  });
});
