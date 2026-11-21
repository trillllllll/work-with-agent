import { opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { assertAllowed, inside } from './git.js';
import { DIRECTORY_LIMIT, type DirectoryPage, type DirectoryTask } from './directory-protocol.js';

const entry = (path: string, name = basename(path) || path) => ({ name, path });

export async function readDirectory({ path, inspectOnly }: Pick<DirectoryTask, 'path' | 'inspectOnly'>, roots: string[]): Promise<DirectoryPage> {
  const canonical = await Promise.all(roots.map(async (root) => {
    const actual = await realpath(root).catch(() => null);
    return actual && (await stat(actual).catch(() => null))?.isDirectory() ? actual : null;
  }));
  const allowed = [...new Set(canonical.filter((root): root is string => root !== null))];
  if (path === null) return { directory: null, parent: null, entries: allowed.map((root) => entry(root)), truncated: false };
  const actual = await assertAllowed(path, allowed);
  if (!(await stat(actual)).isDirectory()) throw new Error('所选路径不是文件夹');
  const parent = dirname(actual);
  const page: DirectoryPage = { directory: entry(actual), parent: parent !== actual && allowed.some((root) => inside(root, parent)) ? parent : null, entries: [], truncated: false };
  if (inspectOnly) return page;
  let scanned = 0;
  for await (const child of await opendir(actual)) {
    if (++scanned > 5000) { page.truncated = true; break; }
    if (child.name.startsWith('.')) continue;
    const childPath = join(actual, child.name);
    if (!child.isDirectory()) {
      if (!child.isSymbolicLink()) continue;
      const target = await assertAllowed(childPath, allowed).catch(() => null);
      if (!target || !(await stat(target).catch(() => null))?.isDirectory()) continue;
    }
    if (page.entries.length === DIRECTORY_LIMIT) { page.truncated = true; break; }
    page.entries.push(entry(childPath, child.name));
  }
  page.entries.sort((a, b) => a.name.localeCompare(b.name));
  return page;
}
