/** Caps for images attached to one get_task result. Larger shots stay available from get_task_image. */
export const taskImageAttachPerImage = 2 * 1024 * 1024;
export const taskImageAttachTotal = 4 * 1024 * 1024;
export const taskImageAttachCount = 8;

export type TaskImageRef = { taskId: string; imageId: string; alt: string };

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Image ids cited by this task's own description, in appearance order. Another task's path is ignored. */
export function descriptionImageRefs(taskId: string, description: string): TaskImageRef[] {
  const pattern = new RegExp(`/api/tasks/${escapeRegExp(taskId)}/images/([A-Za-z0-9_-]+)`, 'g');
  const refs: TaskImageRef[] = [];
  const seen = new Set<string>();
  for (const match of description.matchAll(pattern)) {
    const imageId = match[1];
    if (seen.has(imageId)) continue;
    seen.add(imageId);
    const before = description.slice(0, match.index ?? 0);
    const altMatch = before.match(/!\[((?:\\.|[^\]\\])*)\]\($/);
    const alt = altMatch ? altMatch[1].replace(/\\([\\[\]])/g, '$1') : '';
    refs.push({ taskId, imageId, alt });
  }
  return refs;
}

/** Parent description first, then each child description returned with the task. */
export function taskDetailImageRefs(task: { id?: unknown; description?: unknown; children?: unknown }): TaskImageRef[] {
  const refs: TaskImageRef[] = [];
  if (typeof task.id === 'string' && typeof task.description === 'string') refs.push(...descriptionImageRefs(task.id, task.description));
  if (!Array.isArray(task.children)) return refs;
  for (const child of task.children) {
    if (!child || typeof child !== 'object') continue;
    const row = child as { id?: unknown; description?: unknown };
    if (typeof row.id === 'string' && typeof row.description === 'string') refs.push(...descriptionImageRefs(row.id, row.description));
  }
  return refs;
}

/** index is the position in the detail's image list. usedBytes counts only images already attached. */
export function shouldAttachTaskImage(index: number, byteSize: number, usedBytes: number) {
  return index < taskImageAttachCount && byteSize <= taskImageAttachPerImage && usedBytes + byteSize <= taskImageAttachTotal;
}
