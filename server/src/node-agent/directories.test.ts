import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readDirectory } from './directories.js';

it('browses the paired roots one level at a time and checks typed paths on the computer', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dovun-picker-'));
  const base = await realpath(temp);
  const root = join(base, 'workspace'), project = join(root, 'folder without git'), outside = join(base, 'other');
  try {
    await mkdir(project, { recursive: true });
    await mkdir(outside);
    await mkdir(join(root, '.config'));
    await writeFile(join(root, 'notes.md'), 'text');
    await symlink(outside, join(root, 'external'), 'dir');
    await symlink(project, join(root, 'internal'), 'dir');
    const read = (path: string | null, inspectOnly = false) => readDirectory({ path, inspectOnly }, [root]);
    expect((await read(null)).entries).toEqual([{ name: 'workspace', path: root }]);
    const children = await read(root);
    expect(children.parent).toBeNull();
    expect(children.entries.map((row) => row.name)).toEqual(['folder without git', 'internal']);
    expect(await read(join(root, 'internal'), true)).toMatchObject({ directory: { path: project }, parent: root, entries: [] });
    await expect(read(join(root, 'external'), true)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(read(join(root, 'missing'), true)).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' });
    await expect(read(join(root, 'notes.md'), true)).rejects.toThrow('所选路径不是文件夹');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
