import type { FieldConflict, TaskText, TextField, TextVersion } from './task-editor-types.js';

const fields: TextField[] = ['title', 'description'];

/** 固定为字段级三方合并：标题按 trim 后比较，正文逐字比较；不做段落级自动合并。 */
export function mergeText(
  base: TextVersion,
  local: TaskText,
  remote: TextVersion,
): {
  draft: TaskText;
  conflicts: Partial<Record<TextField, FieldConflict>>;
} {
  const draft: TaskText = { title: local.title, description: local.description };
  const conflicts: Partial<Record<TextField, FieldConflict>> = {};
  for (const field of fields) {
    const B = field === 'title' ? base[field].trim() : base[field];
    const L = field === 'title' ? local[field].trim() : local[field];
    const R = field === 'title' ? remote[field].trim() : remote[field];
    if (L === B) draft[field] = remote[field];
    else if (R === B) draft[field] = local[field];
    else if (L === R) draft[field] = local[field];
    else {
      draft[field] = local[field];
      conflicts[field] = { base: base[field], local: local[field], remote: remote[field], remoteRevision: remote.revision };
    }
  }
  return { draft, conflicts };
}
