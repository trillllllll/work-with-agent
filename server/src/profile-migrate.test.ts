import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateProfileTree, profileRoots } from './profile-migrate.js';
async function fixture(run: (source: string, target: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dovun-profile-')); const source = join(root, 'old profile'), target = join(root, 'new profile');
  try { await mkdir(join(source, 'WebsiteData/IndexedDB'), { recursive: true }); await writeFile(join(source, 'WebsiteData/IndexedDB/origin-scope'), 'original service / user / unsent draft'); await writeFile(join(source, 'WebsiteData/salt'), 'origin hash salt'); await run(source, target); }
  finally { await rm(root, { recursive: true, force: true }); }
}
describe('new application identity profile handoff', () => {
  it('backs up and copies complete browser state, retaining origin salts and original files', async () => fixture(async (source, target) => {
    const result = await migrateProfileTree(source, target); expect(result.status).toBe('migrated');
    expect(await readFile(join(target, 'WebsiteData/IndexedDB/origin-scope'), 'utf8')).toContain('unsent draft');
    expect(await readFile(join(target, 'WebsiteData/salt'))).toEqual(await readFile(join(source, 'WebsiteData/salt')));
    expect(await readFile(join(result.backup!, 'WebsiteData/salt'))).toEqual(await readFile(join(source, 'WebsiteData/salt')));
    await writeFile(join(target, 'new work'), 'new'); expect((await migrateProfileTree(source, target)).status).toBe('already-migrated');
  }));
  it('stops on an existing new profile without overwriting either side', async () => fixture(async (source, target) => {
    await mkdir(target); await writeFile(join(target, 'current'), 'keep');
    await expect(migrateProfileTree(source, target)).rejects.toThrow('Both browser profiles'); expect(await readFile(join(target, 'current'), 'utf8')).toBe('keep');
  }));
  it('aborts an interrupted or changing source and permits a clean retry', async () => fixture(async (source, target) => {
    await expect(migrateProfileTree(source, target, async () => { throw new Error('interrupted'); })).rejects.toThrow('interrupted');
    await expect(readdir(target)).rejects.toThrow();
    await expect(migrateProfileTree(source, target, async () => { await writeFile(join(source, 'late'), 'late write'); })).rejects.toThrow('changed');
    expect((await migrateProfileTree(source, target)).status).toBe('migrated');
  }));
  it('selects established native profile roots on both supported platforms', () => {
    expect(profileRoots('darwin', '/Users/test')[0]).toEqual({ source: '/Users/test/Library/WebKit/app.workwithagent.desktop', target: '/Users/test/Library/WebKit/app.dovun.desktop' });
    expect(profileRoots('win32', 'ignored', 'C:/Users/test user/AppData/Local')[0].target.replace(/\\/g,'/')).toContain('app.dovun.desktop');
    expect(win32.basename('C:\\Users\\test user\\AppData\\Local\\app.dovun.desktop')).toBe('app.dovun.desktop');
    expect(() => profileRoots('win32', 'ignored')).toThrow('LOCALAPPDATA');
  });
});
