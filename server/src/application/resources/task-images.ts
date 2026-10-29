import type { TaskImage } from '@prisma/client';
import type { LibraryDb } from '../library/access.js';
import { libraryNow } from '../library/access.js';
import { knowledgeHash } from '../knowledge-blobs.js';

/** Preserve legacy URL identity without rewriting any task, chat or historical body. */
export async function ensureTaskImageResource(tx: LibraryDb, image: TaskImage) {
  const alias = await tx.resourceLegacyAlias.findUnique({ where: { sourceKind_sourceId: { sourceKind: 'task-image', sourceId: image.id } } });
  if (alias) return false;
  const task = await tx.task.findUnique({ where: { id: image.taskId } });
  if (!task) return false;
  const resourceId = `task-image-${image.id}`;
  const timestamp = image.createdAt || libraryNow();
  await tx.material.create({ data: {
    id: resourceId, title: '任务图片', topicId: task.topicId, sourceTaskId: image.taskId, managed: true, kind: 'attachment', archivedAt: task.deletedAt,
    createdAt: timestamp, updatedAt: timestamp,
    versions: { create: { revision: 1, content: '', contentHash: knowledgeHash(`\0${image.path}`), format: 'binary', attachmentPath: image.path, sourceOriginalPath: image.path, mimeType: image.mimeType, fileName: `${image.id}.${image.mimeType === 'image/jpeg' ? 'jpg' : 'webp'}`, createdAt: timestamp } },
  } });
  await tx.resourceLegacyAlias.create({ data: { sourceKind: 'task-image', sourceId: image.id, resourceId, createdAt: libraryNow() } });
  await tx.resourceLegacyAlias.create({ data: { sourceKind: 'material', sourceId: resourceId, resourceId, createdAt: libraryNow() } });
  return true;
}
