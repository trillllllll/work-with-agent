import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { assertAllowed } from './git.js';
import { HARNESS_ARTIFACTS, HARNESS_SVG_LIMIT, type HarnessArtifact, type HarnessMessage } from './harness-protocol.js';

type MarkdownNode = { type: string; url?: string; children?: MarkdownNode[] };

function svgPath(href: string, cwd: string) {
  try {
    const target = href.split('#', 1)[0];
    if (target.startsWith('//')) return null;
    const path = target.startsWith('file:') ? fileURLToPath(target) : decodeURIComponent(target);
    if (!path || (!isAbsolute(path) && /^[a-z][a-z0-9+.-]*:/i.test(path))) return null;
    return extname(path).toLowerCase() === '.svg' ? resolve(cwd, path) : null;
  } catch { return null; }
}

async function readSvg(path: string, roots: string[]) {
  const actual = await assertAllowed(path, roots);
  if (extname(actual).toLowerCase() !== '.svg') return null;
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || !info.size || info.size > HARNESS_SVG_LIMIT || await realpath(actual) !== actual) return null;
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) return null;
    const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    if (/<!DOCTYPE|<!ENTITY/i.test(source) || !/^\s*(?:<\?xml[^?]*\?>\s*)?<svg[\s/>]/i.test(source)) return null;
    return source;
  } finally { await file.close(); }
}

/** Only files explicitly linked in a reply and inside this computer's paired roots are published. */
export async function readHarnessArtifacts(message: HarnessMessage, cwd: string, roots: string[]): Promise<HarnessArtifact[]> {
  const hrefs = new Set<string>();
  function walk(node: MarkdownNode) {
    if (hrefs.size === HARNESS_ARTIFACTS) return;
    if ((node.type === 'link' || node.type === 'image') && node.url && node.url.length <= 4_096 && svgPath(node.url, cwd)) hrefs.add(node.url);
    node.children?.forEach(walk);
  }
  try { walk(fromMarkdown(message.text)); } catch { return []; }
  const artifacts: HarnessArtifact[] = [];
  for (const href of hrefs) {
    const path = svgPath(href, cwd)!;
    const source = await readSvg(path, roots).catch(() => null);
    if (!source) continue;
    const id = createHash('sha256').update(JSON.stringify([message.id, href, source])).digest('hex');
    artifacts.push({ id, turnId: message.turnId, messageId: message.id, kind: 'svg', name: basename(path).slice(0, 255), href, source });
  }
  return artifacts;
}
