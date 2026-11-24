import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { assertAllowed } from './git.js';
import { asObject, type HarnessRuntime } from './harness-codex.js';
import { codexItems as items, codexText as text } from './harness-history.js';
import { harnessOrganizationSchema, harnessProjectPinsSchema, type HarnessOrganization, type HarnessProjectPins } from './harness-protocol.js';

function ids(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.length <= 2_000 && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)) {
    return value;
  }
}

export async function readCodexPins() {
  const path = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), '.codex-global-state.json');
  try {
    const info = await stat(path);
    if (info.isFile() && info.size <= 2 * 1024 * 1024) {
      const state = asObject(JSON.parse(await readFile(path, 'utf8')));
      return { threads: ids(state['pinned-thread-ids']), projects: ids(state['pinned-project-ids']) };
    }
  } catch { /* The desktop state is optional and may be replaced while reading. */ }
  return {};
}

export function codexOrganization(thread: Record<string, unknown>, pins?: string[], archived?: boolean): HarnessOrganization | undefined {
  const organization: HarnessOrganization = {};
  if (pins) {
    const order = pins.indexOf(text(thread.id));
    organization.pinned = order >= 0;
    organization.pinOrder = order >= 0 ? order : null;
  }
  if (archived !== undefined) organization.archived = archived;
  if (thread.section === null) organization.group = null;
  const section = asObject(thread.section);
  const group = harnessOrganizationSchema.shape.group.safeParse({ id: text(section.id), name: text(section.name).trim().slice(0, 255) });
  if (group.success) organization.group = group.data;
  return Object.keys(organization).length ? organization : undefined;
}

export async function readCodexProjectPins(app: HarnessRuntime, projectIds: string[] | undefined, roots: string[]): Promise<HarnessProjectPins | undefined> {
  if (!projectIds) return;
  if (!projectIds.length) return [];
  const pending = new Set(projectIds);
  const projects = new Map<string, number>();
  let cursor: string | null = null;
  try {
    for (let page = 0; pending.size && page < 3; page++) {
      const result = await app.request('project/list', { limit: 100, cursor });
      for (const project of items(result.data)) {
        const id = text(project.id);
        if (!pending.delete(id)) continue;
        const order = projectIds.indexOf(id);
        for (const root of items(project.roots)) {
          const cwd = await assertAllowed(text(root.path), roots).catch(() => null);
          if (cwd && (await stat(cwd).catch(() => null))?.isDirectory()) {
            projects.set(cwd, Math.min(order, projects.get(cwd) ?? order));
          }
        }
      }
      cursor = text(result.nextCursor) || null;
      if (!cursor) break;
    }
    if (pending.size && cursor) return;
    return harnessProjectPinsSchema.safeParse([...projects].map(([cwd, order]) => ({ cwd, order }))).data;
  } catch { /* Older App Servers may only support listing threads. */ }
}
