import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileGrants } from '../infrastructure/controlled-execution.js';
import { prisma } from '../infrastructure/prisma.js';

const fileUrlPattern = /file:\/\/[^\s<>"'`]+/gi;
const absolutePattern = /(?:^|[\s"'`(（])((?:\/|[A-Za-z]:[\\/])[^\s"'`<>|\n\r]+)/g;
const trailingPunctuation = /[),.;:，。；、）]+$/;

function pathInside(root: string, target: string) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function segmentCount(dir: string) {
  return resolve(dir).split(sep).filter(Boolean).filter((part) => !/^[A-Za-z]:$/.test(part)).length;
}

/** Home, and directories three or fewer segments from the root, are too wide to open as a folder. */
export function isBroadDirectory(dir: string, home = homedir()) {
  const resolved = resolve(dir);
  if (resolved === resolve(home)) return true;
  return segmentCount(resolved) <= 3;
}

function fileUrlPath(raw: string) {
  try {
    const path = fileURLToPath(raw.replace(trailingPunctuation, ''));
    return isAbsolute(path) ? resolve(path) : null;
  } catch {
    return null;
  }
}

export function pathsInText(text: string) {
  const found = new Set<string>();
  for (const match of text.matchAll(fileUrlPattern)) {
    const path = fileUrlPath(match[0]);
    if (path) found.add(path);
  }
  for (const match of text.matchAll(absolutePattern)) {
    const raw = match[1].replace(trailingPunctuation, '');
    if (isAbsolute(raw)) found.add(resolve(raw));
  }
  return [...found];
}

async function realInsideParent(candidate: string, real: string) {
  const parent = dirname(resolve(candidate));
  let parentReal = parent;
  try { parentReal = await realpath(parent); } catch { return false; }
  return pathInside(parentReal, real);
}

export async function taskFileGrants(): Promise<FileGrants> {
  const tasks = await prisma.task.findMany({ where: { deletedAt: null }, select: { title: true, description: true } });
  const candidates = new Set<string>();
  for (const task of tasks) for (const path of pathsInText(`${task.title}\n${task.description}`)) candidates.add(path);
  const files: string[] = [];
  const directories: string[] = [];
  let homeReal = resolve(homedir());
  try { homeReal = await realpath(homeReal); } catch { /* Keep the lexical home when it cannot be resolved. */ }
  for (const candidate of candidates) {
    let info;
    try { info = await stat(candidate); } catch { continue; }
    let real = candidate;
    try { real = await realpath(candidate); } catch { continue; }
    if (!(await realInsideParent(candidate, real))) continue;
    if (info.isDirectory()) {
      if (isBroadDirectory(candidate) || isBroadDirectory(real) || real === homeReal) continue;
      directories.push(resolve(candidate));
      continue;
    }
    if (!info.isFile()) continue;
    files.push(resolve(candidate));
    const parent = dirname(resolve(candidate));
    let parentReal = parent;
    try { parentReal = await realpath(parent); } catch { continue; }
    if (isBroadDirectory(parent) || isBroadDirectory(parentReal) || parentReal === homeReal || parent === resolve(homedir())) continue;
    directories.push(parent);
  }
  return { files: [...new Set(files)], directories: [...new Set(directories)] };
}
