import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertAllowed } from './git.js';
import { zcodeDataHome } from './harness-zcode-client.js';
import { harnessOrganizationSchema, harnessProjectPinsSchema, type HarnessOrganization, type HarnessProjectPins } from './harness-protocol.js';

export function openZCodeDesktopIndex() {
  try {
    return new DatabaseSync(resolve(zcodeDataHome(), '.zcode/v2/tasks-index.sqlite'), { readOnly: true });
  } catch { return null; }
}

export function readZCodeOrganization(db: DatabaseSync, id: string, nativePath: string, cwd: string): HarnessOrganization | undefined {
  try {
    const rows = db.prepare(`SELECT workspace_key, pinned, archived, COALESCE(sort_order, -COALESCE(cli_updated_at, updated_at)) AS pin_order
      FROM tasks WHERE host_id = 'local' AND workspace_identity IS NULL AND task_id = ? AND workspace_path IN (?, ?)
      AND deleted = 0 AND COALESCE(cli_deleted, 0) = 0 LIMIT 2`).all(id, nativePath, cwd);
    if (rows.length !== 1) return;
    const row = rows[0];
    if (row.pinned !== 0 && row.pinned !== 1 || row.archived !== 0 && row.archived !== 1) return;
    const pinned = row.pinned === 1;
    const organization = harnessOrganizationSchema.safeParse({ pinned, pinOrder: pinned ? row.pin_order : null, archived: row.archived === 1 }).data;
    if (!organization || typeof row.workspace_key !== 'string') return organization;
    try {
      const group = db.prepare(`SELECT g.group_id AS id, g.title AS name, o.sort_order AS group_order,
        COALESCE(m.sort_order, -m.added_at) AS member_order
        FROM task_group_members m JOIN task_groups g ON g.group_id = m.group_id
        LEFT JOIN task_group_view_node_orders o ON o.node_type = 'group' AND o.node_key = g.group_id
        WHERE m.workspace_key = ? AND m.task_id = ?`).get(row.workspace_key, id);
      const projection = group ? { id: group.id, name: typeof group.name === 'string' ? group.name.trim().slice(0, 255) : group.name,
        order: group.group_order ?? undefined, memberOrder: group.member_order ?? undefined } : null;
      const parsed = harnessOrganizationSchema.shape.group.safeParse(projection);
      if (parsed.success) organization.group = parsed.data;
    } catch { /* Groups are optional on older desktop indexes. */ }
    return organization;
  } catch { return undefined; }
}

export async function readZCodeProjectPins(db: DatabaseSync, roots: string[]): Promise<HarnessProjectPins | undefined> {
  try {
    const rows = db.prepare(`SELECT r.root_path, p.position FROM projects p JOIN project_roots r USING (project_id)
      WHERE p.host_id = 'local' AND p.deleted = 0 AND p.pinned = 1 ORDER BY p.position, r.position LIMIT 201`).all();
    if (rows.length > 200) return;
    const projects = new Map<string, number>();
    for (const row of rows) {
      if (typeof row.root_path !== 'string' || typeof row.position !== 'number') continue;
      const cwd = await assertAllowed(row.root_path, roots).catch(() => null);
      if (cwd && !projects.has(cwd)) projects.set(cwd, row.position);
    }
    return harnessProjectPinsSchema.safeParse([...projects].map(([cwd, order]) => ({ cwd, order }))).data;
  } catch { return undefined; }
}

export async function readZCodePriorityIds(db: DatabaseSync, roots: string[], archived: boolean) {
  try {
    const rows = db.prepare(`SELECT task_id, workspace_path FROM tasks WHERE host_id = 'local' AND workspace_identity IS NULL
      AND deleted = 0 AND COALESCE(cli_deleted, 0) = 0 AND archived = ? AND (? OR pinned = 1)
      ORDER BY COALESCE(sort_order, -COALESCE(cli_updated_at, updated_at)), task_id LIMIT 200`).all(Number(archived), Number(archived));
    const ids = new Set<string>();
    for (const row of rows) {
      if (typeof row.task_id !== 'string' || typeof row.workspace_path !== 'string') continue;
      if (await assertAllowed(row.workspace_path, roots).catch(() => null)) ids.add(row.task_id);
      if (ids.size === 30) break;
    }
    return [...ids];
  } catch { return []; }
}
