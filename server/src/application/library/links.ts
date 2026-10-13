import { randomUUID } from 'node:crypto';
import type { Material, MaterialTaskLink } from '@prisma/client';
import { recordChange, type MutationContext } from '../workspace-store.js';
import type { Actor } from '../security.js';
import { assertExpected, assertWritableTopic, libraryError, libraryNow, readableMaterial, topicVisible, writableMaterial, type LibraryDb } from './access.js';
import { retagMaterialDocuments, tagNames, writeMetaDocument } from './index-docs.js';
import { displayName } from './text.js';
import { materialReferences, stripMaterialReferences } from './citations.js';

export type LinkFlag = { taskId: string; manual: boolean; legacy: boolean };
export type OrganizationSnapshot = {
  id: string;
  revision: number;
  organizationRevision: number;
  folderId: string | null;
  taskId: string | null;
  title: string;
  uri: string | null;
  archivedAt: string | null;
  topicId: string | null;
  tagIds: string[];
  links: LinkFlag[];
  taskDescriptions?: Record<string, { revision: number; description?: string }>;
};

const linkOrder = (left: LinkFlag, right: LinkFlag) => left.taskId.localeCompare(right.taskId);

export async function readLinks(tx: LibraryDb, materialId: string): Promise<LinkFlag[]> {
  const rows = await tx.materialTaskLink.findMany({ where: { materialId } });
  return rows.map((row) => ({ taskId: row.taskId, manual: row.manual, legacy: row.legacy })).sort(linkOrder);
}

export async function readTagIds(tx: LibraryDb, materialId: string) {
  const rows = await tx.materialTag.findMany({ where: { materialId }, select: { tagId: true } });
  return rows.map((row) => row.tagId).sort();
}

export async function materialSnapshot(tx: LibraryDb, material: Material): Promise<OrganizationSnapshot> {
  return {
    id: material.id, revision: material.revision, organizationRevision: material.organizationRevision,
    folderId: material.folderId, taskId: material.taskId, title: material.title, uri: material.uri,
    archivedAt: material.archivedAt, topicId: material.topicId,
    tagIds: await readTagIds(tx, material.id), links: await readLinks(tx, material.id),
  };
}

export async function queueExtraction(tx: LibraryDb, materialId: string, revision: number, status: 'queued' | 'failed', errorCode: string | null, timestamp: string) {
  await tx.materialExtraction.upsert({
    where: { materialId_revision: { materialId, revision } },
    create: { id: randomUUID(), materialId, revision, status, errorCode, errorsJson: '[]', nextAttemptAt: timestamp, createdAt: timestamp, updatedAt: timestamp },
    update: {},
  });
}

export async function indexCurrentVersion(tx: LibraryDb, material: Material) {
  const version = await tx.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: material.id, revision: material.revision } } });
  await writeMetaDocument(tx, material, version, await tagNames(tx, material.id));
  return version;
}

async function loadTask(tx: LibraryDb, actor: Actor, taskId: string) {
  const task = await tx.task.findUnique({ where: { id: taskId } });
  if (!task || !topicVisible(actor, task.topicId)) throw libraryError('NOT_FOUND', '任务不存在', 404);
  if (task.deletedAt) throw libraryError('TASK_NOT_EDITABLE', '回收站中的任务不能关联');
  await assertWritableTopic(tx, actor, task.topicId);
  return task;
}

export async function seedLegacyLink(tx: LibraryDb, materialId: string, taskId: string | null, actor: Actor) {
  if (!taskId) return;
  await loadTask(tx, actor, taskId);
  const existing = await tx.materialTaskLink.findUnique({ where: { materialId_taskId: { materialId, taskId } } });
  if (existing) await tx.materialTaskLink.update({ where: { materialId_taskId: { materialId, taskId } }, data: { legacy: true } });
  else await tx.materialTaskLink.create({ data: { materialId, taskId, manual: false, legacy: true, createdAt: libraryNow(), createdBy: actor.id } });
}

export async function applyLegacyPointer(tx: LibraryDb, material: Material, nextTaskId: string | null, actor: Actor) {
  if (material.taskId === nextTaskId) return false;
  const timestamp = libraryNow();
  if (material.taskId) {
    const current = await tx.materialTaskLink.findUnique({ where: { materialId_taskId: { materialId: material.id, taskId: material.taskId } } });
    if (current?.manual) await tx.materialTaskLink.update({ where: { materialId_taskId: { materialId: material.id, taskId: material.taskId } }, data: { legacy: false } });
    else if (current) await tx.materialTaskLink.delete({ where: { materialId_taskId: { materialId: material.id, taskId: material.taskId } } });
  }
  if (nextTaskId) {
    await loadTask(tx, actor, nextTaskId);
    const existing = await tx.materialTaskLink.findUnique({ where: { materialId_taskId: { materialId: material.id, taskId: nextTaskId } } });
    if (existing) await tx.materialTaskLink.update({ where: { materialId_taskId: { materialId: material.id, taskId: nextTaskId } }, data: { legacy: true } });
    else await tx.materialTaskLink.create({ data: { materialId: material.id, taskId: nextTaskId, manual: false, legacy: true, createdAt: timestamp, createdBy: actor.id } });
  }
  return true;
}

export async function addManualLinks(tx: LibraryDb, materialId: string, taskIds: string[], actor: Actor) {
  const timestamp = libraryNow();
  let changed = false;
  for (const taskId of [...new Set(taskIds)]) {
    await loadTask(tx, actor, taskId);
    const existing = await tx.materialTaskLink.findUnique({ where: { materialId_taskId: { materialId, taskId } } });
    if (existing?.manual) continue;
    if (existing) await tx.materialTaskLink.update({ where: { materialId_taskId: { materialId, taskId } }, data: { manual: true } });
    else await tx.materialTaskLink.create({ data: { materialId, taskId, manual: true, legacy: false, createdAt: timestamp, createdBy: actor.id } });
    changed = true;
  }
  return changed;
}

function sameLinks(left: LinkFlag[], right: LinkFlag[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function bumpOrganization(tx: LibraryDb, material: Material, context: MutationContext, before: OrganizationSnapshot) {
  const timestamp = libraryNow();
  const updated = await tx.material.update({ where: { id: material.id }, data: { organizationRevision: { increment: 1 }, updatedAt: timestamp } });
  const after = await materialSnapshot(tx, updated);
  await recordChange(tx, 'material', material.id, 'update', before, after, context);
  return updated;
}

export async function detachMaterialsFromDeletedTasks(tx: LibraryDb, taskIds: string[]) {
  if (!taskIds.length) return;
  const links = await tx.materialTaskLink.findMany({ where: { taskId: { in: taskIds } } });
  const ids = [...new Set(links.map((link) => link.materialId))];
  const timestamp = libraryNow();
  for (const id of ids) {
    const material = await tx.material.findUnique({ where: { id } });
    if (!material) continue;
    await tx.material.update({ where: { id }, data: { ...(material.taskId && taskIds.includes(material.taskId) ? { taskId: null } : {}), organizationRevision: { increment: 1 }, updatedAt: timestamp } });
  }
}

async function assertFolder(tx: LibraryDb, folderId: string | null) {
  if (!folderId) return;
  const folder = await tx.libraryFolder.findUnique({ where: { id: folderId } });
  if (!folder) throw libraryError('NOT_FOUND', '文件夹不存在', 404);
}

async function setTags(tx: LibraryDb, materialId: string, tagIds: string[]) {
  const unique = [...new Set(tagIds)];
  if (unique.length) {
    const found = await tx.libraryTag.findMany({ where: { id: { in: unique } } });
    if (found.length !== unique.length) throw libraryError('NOT_FOUND', '标签不存在', 404);
  }
  await tx.materialTag.deleteMany({ where: { materialId } });
  if (unique.length) await tx.materialTag.createMany({ data: unique.map((tagId) => ({ materialId, tagId })) });
}

export async function organizeMaterial(tx: LibraryDb, actor: Actor, materialId: string, expectedRevision: number | undefined, input: { expectedOrganizationRevision: number; folderId?: string | null; tagIds?: string[] }, context: MutationContext) {
  const material = await writableMaterial(tx, actor, materialId);
  assertExpected(material.revision, expectedRevision);
  assertExpected(material.organizationRevision, input.expectedOrganizationRevision, '整理已经变化，请刷新后重试');
  const before = await materialSnapshot(tx, material);
  if (input.folderId !== undefined) await assertFolder(tx, input.folderId);
  if (input.tagIds) await setTags(tx, material.id, input.tagIds);
  if (input.folderId !== undefined && input.folderId !== material.folderId) {
    await tx.material.update({ where: { id: material.id }, data: { folderId: input.folderId } });
  }
  const tagsChanged = input.tagIds !== undefined && JSON.stringify([...input.tagIds].sort()) !== JSON.stringify(before.tagIds);
  const folderChanged = input.folderId !== undefined && input.folderId !== before.folderId;
  if (tagsChanged) await retagMaterialDocuments(tx, material.id, await tagNames(tx, material.id));
  if (!tagsChanged && !folderChanged) return tx.material.findUniqueOrThrow({ where: { id: material.id } });
  return bumpOrganization(tx, material, context, before);
}

export async function changeLinks(tx: LibraryDb, actor: Actor, materialId: string, expectedRevision: number | undefined, input: {
  expectedOrganizationRevision: number;
  addTaskIds: string[];
  removeTaskIds: string[];
  removeInlineReferences: boolean;
  expectedTaskRevisions: Record<string, number>;
}, context: MutationContext) {
  const material = await writableMaterial(tx, actor, materialId);
  assertExpected(material.revision, expectedRevision);
  assertExpected(material.organizationRevision, input.expectedOrganizationRevision, '整理已经变化，请刷新后重试');
  const add = [...new Set(input.addTaskIds)];
  const remove = [...new Set(input.removeTaskIds)];
  if (add.some((id) => remove.includes(id))) throw libraryError('INVALID_LINKS', '同一任务不能同时关联和解除', 400);
  for (const taskId of [...add, ...remove]) await loadTask(tx, actor, taskId);
  const before = await materialSnapshot(tx, material);
  let descriptionsChanged = false;
  for (const taskId of remove) {
    const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
    const hits = materialReferences(task.description).filter((hit) => hit.materialId === material.id);
    if (!hits.length) continue;
    if (!input.removeInlineReferences) throw libraryError('MATERIAL_STILL_REFERENCED', '任务正文仍引用这份资料');
    assertExpected(task.revision, input.expectedTaskRevisions[taskId], '任务已经变化，请刷新后重试');
    descriptionsChanged = true;
    const description = stripMaterialReferences(task.description, material.id);
    const editedAt = libraryNow();
    await tx.task.update({ where: { id: taskId, revision: task.revision }, data: { description, revision: { increment: 1 }, updatedAt: editedAt } });
    await recordChange(tx, 'task', taskId, 'update', { id: taskId, revision: task.revision, description: task.description, updatedAt: task.updatedAt }, { id: taskId, revision: task.revision + 1, description, updatedAt: editedAt }, context);
  }
  const timestamp = libraryNow();
  for (const taskId of add) {
    const existing = await tx.materialTaskLink.findUnique({ where: { materialId_taskId: { materialId, taskId } } });
    if (existing?.manual) continue;
    if (existing) await tx.materialTaskLink.update({ where: { materialId_taskId: { materialId, taskId } }, data: { manual: true } });
    else await tx.materialTaskLink.create({ data: { materialId, taskId, manual: true, legacy: false, createdAt: timestamp, createdBy: actor.id } });
  }
  for (const taskId of remove) {
    await tx.materialTaskLink.deleteMany({ where: { materialId, taskId } });
    if (material.taskId === taskId) await tx.material.update({ where: { id: material.id }, data: { taskId: null } });
  }
  const current = await tx.material.findUniqueOrThrow({ where: { id: material.id } });
  const links = await readLinks(tx, material.id);
  if (sameLinks(before.links, links) && current.taskId === before.taskId && !descriptionsChanged) return current;
  const updated = await tx.material.update({ where: { id: material.id }, data: { organizationRevision: { increment: 1 }, updatedAt: timestamp } });
  const after = await materialSnapshot(tx, updated);
  await recordChange(tx, 'material', material.id, 'update', before, after, context);
  return updated;
}

export async function replaceOrganization(tx: LibraryDb, materialId: string, before: OrganizationSnapshot) {
  if (before.folderId) {
    const folder = await tx.libraryFolder.findUnique({ where: { id: before.folderId } });
    if (!folder) throw libraryError('UNDO_CONFLICT', '原文件夹已不存在');
  }
  if (before.tagIds.length) {
    const tags = await tx.libraryTag.findMany({ where: { id: { in: before.tagIds } } });
    if (tags.length !== before.tagIds.length) throw libraryError('UNDO_CONFLICT', '原标签已不存在');
  }
  const timestamp = libraryNow();
  await tx.materialTag.deleteMany({ where: { materialId } });
  if (before.tagIds.length) await tx.materialTag.createMany({ data: before.tagIds.map((tagId) => ({ materialId, tagId })) });
  await tx.materialTaskLink.deleteMany({ where: { materialId } });
  if (before.links.length) await tx.materialTaskLink.createMany({ data: before.links.map((link) => ({ materialId, taskId: link.taskId, manual: link.manual, legacy: link.legacy, createdAt: timestamp, createdBy: 'undo' })) });
  await retagMaterialDocuments(tx, materialId, await tagNames(tx, materialId));
  return tx.material.update({ where: { id: materialId }, data: { folderId: before.folderId, taskId: before.taskId, organizationRevision: { increment: 1 }, updatedAt: timestamp } });
}

export async function restoreOrganization(tx: LibraryDb, current: Material, before: OrganizationSnapshot, after: OrganizationSnapshot, context?: MutationContext) {
  if (current.revision !== after.revision || current.organizationRevision !== after.organizationRevision) throw libraryError('UNDO_CONFLICT', '材料已有后续修改');
  const timestamp = libraryNow();
  const restoredByTask = context?.undoOwnership?.taskIdsRestoredByGroup;
  if (before.taskDescriptions) {
    for (const [taskId, snapshot] of Object.entries(before.taskDescriptions)) {
      if (restoredByTask?.has(taskId)) continue;
      const task = await tx.task.findUnique({ where: { id: taskId } });
      const edited = after.taskDescriptions?.[taskId];
      if (!task || !edited || task.revision !== edited.revision + 1) throw libraryError('UNDO_CONFLICT', '引用过的任务已有后续修改');
      await tx.task.update({ where: { id: taskId }, data: { description: snapshot.description ?? task.description, revision: { increment: 1 }, updatedAt: timestamp } });
    }
  }
  return replaceOrganization(tx, current.id, before);
}

type FolderSnapshot = { id: string; parentId: string | null; name: string; normalizedName: string; revision: number; createdAt: string; updatedAt: string };
type TagSnapshot = { id: string; name: string; normalizedName: string; revision: number; createdAt: string; updatedAt: string };

function folderSnapshot(folder: FolderSnapshot): FolderSnapshot {
  return { id: folder.id, parentId: folder.parentId, name: folder.name, normalizedName: folder.normalizedName, revision: folder.revision, createdAt: folder.createdAt, updatedAt: folder.updatedAt };
}

function tagSnapshot(tag: TagSnapshot): TagSnapshot {
  return { id: tag.id, name: tag.name, normalizedName: tag.normalizedName, revision: tag.revision, createdAt: tag.createdAt, updatedAt: tag.updatedAt };
}

export async function createFolder(tx: LibraryDb, actor: Actor, input: { parentId: string | null; name: string }, entityId: string | undefined, context: MutationContext) {
  if (actor.kind !== 'user') throw libraryError('OWNER_REQUIRED', '只有本机用户可以管理文件夹', 403);
  const named = displayName(input.name, 1, 80);
  if (!named) throw libraryError('INVALID_NAME', '文件夹名称需要 1 到 80 个字符', 400);
  await placeFolder(tx, null, input.parentId);
  await assertSiblingName(tx, input.parentId, named.normalizedName);
  const timestamp = libraryNow();
  const created = await tx.libraryFolder.create({ data: { id: entityId ?? randomUUID(), parentId: input.parentId, ...named, createdAt: timestamp, updatedAt: timestamp } });
  await recordChange(tx, 'libraryFolder', created.id, 'create', null, folderSnapshot(created), context);
  return created;
}

export async function updateFolder(tx: LibraryDb, actor: Actor, id: string, expectedRevision: number | undefined, input: { parentId?: string | null; name?: string }, context: MutationContext) {
  if (actor.kind !== 'user') throw libraryError('OWNER_REQUIRED', '只有本机用户可以管理文件夹', 403);
  const folder = await tx.libraryFolder.findUnique({ where: { id } });
  if (!folder) throw libraryError('NOT_FOUND', '文件夹不存在', 404);
  assertExpected(folder.revision, expectedRevision);
  const parentId = input.parentId === undefined ? folder.parentId : input.parentId;
  const named = input.name === undefined ? { name: folder.name, normalizedName: folder.normalizedName } : displayName(input.name, 1, 80);
  if (!named) throw libraryError('INVALID_NAME', '文件夹名称需要 1 到 80 个字符', 400);
  if (parentId !== folder.parentId) await placeFolder(tx, id, parentId);
  if (named.normalizedName !== folder.normalizedName || parentId !== folder.parentId) await assertSiblingName(tx, parentId, named.normalizedName, id);
  const before = folderSnapshot(folder);
  const updated = await tx.libraryFolder.update({ where: { id, revision: folder.revision }, data: { parentId, ...named, revision: { increment: 1 }, updatedAt: libraryNow() } });
  await recordChange(tx, 'libraryFolder', id, 'update', before, folderSnapshot(updated), context);
  return updated;
}

export async function deleteFolder(tx: LibraryDb, actor: Actor, id: string, expectedRevision: number | undefined, context: MutationContext) {
  if (actor.kind !== 'user') throw libraryError('OWNER_REQUIRED', '只有本机用户可以管理文件夹', 403);
  const folder = await tx.libraryFolder.findUnique({ where: { id } });
  if (!folder) throw libraryError('NOT_FOUND', '文件夹不存在', 404);
  assertExpected(folder.revision, expectedRevision);
  if (await tx.libraryFolder.count({ where: { parentId: id } }) || await tx.material.count({ where: { folderId: id } })) throw libraryError('FOLDER_NOT_EMPTY', '只能删除空文件夹');
  await tx.libraryFolder.delete({ where: { id } });
  await recordChange(tx, 'libraryFolder', id, 'delete', folderSnapshot(folder), { id, deleted: true }, context);
  return { id, deleted: true };
}

async function assertSiblingName(tx: LibraryDb, parentId: string | null, normalizedName: string, ignoreId?: string) {
  const sibling = await tx.libraryFolder.findFirst({ where: { parentId, normalizedName, ...(ignoreId ? { id: { not: ignoreId } } : {}) } });
  if (sibling) throw libraryError('FOLDER_NAME_CONFLICT', '同一层已有同名文件夹');
}

async function placeFolder(tx: LibraryDb, id: string | null, parentId: string | null) {
  if (!parentId) return;
  if (id && parentId === id) throw libraryError('FOLDER_CYCLE', '文件夹不能移动到自身或子孙文件夹');
  const seen = new Set<string>();
  let cursor: string | null = parentId;
  let depth = 1;
  while (cursor) {
    if (id && cursor === id) throw libraryError('FOLDER_CYCLE', '文件夹不能移动到自身或子孙文件夹');
    if (seen.has(cursor)) throw libraryError('FOLDER_CYCLE', '文件夹不能移动到自身或子孙文件夹');
    seen.add(cursor);
    const parent: { parentId: string | null } | null = await tx.libraryFolder.findUnique({ where: { id: cursor }, select: { parentId: true } });
    if (!parent) throw libraryError('NOT_FOUND', '文件夹不存在', 404);
    cursor = parent.parentId;
    depth += 1;
  }
  if (depth > 10) throw libraryError('FOLDER_TOO_DEEP', '文件夹最多 10 层', 400);
  if (id) {
    const height = await subtreeHeight(tx, id);
    if (depth + height - 1 > 10) throw libraryError('FOLDER_TOO_DEEP', '文件夹最多 10 层', 400);
  }
}

async function subtreeHeight(tx: LibraryDb, id: string): Promise<number> {
  const children = await tx.libraryFolder.findMany({ where: { parentId: id }, select: { id: true } });
  if (!children.length) return 1;
  const heights = await Promise.all(children.map((child) => subtreeHeight(tx, child.id)));
  return 1 + Math.max(...heights);
}

export async function createTag(tx: LibraryDb, actor: Actor, name: string, entityId: string | undefined, context: MutationContext) {
  if (actor.kind !== 'user') throw libraryError('OWNER_REQUIRED', '只有本机用户可以管理标签', 403);
  const named = displayName(name, 1, 40);
  if (!named) throw libraryError('INVALID_NAME', '标签名称需要 1 到 40 个字符', 400);
  if (await tx.libraryTag.findUnique({ where: { normalizedName: named.normalizedName } })) throw libraryError('TAG_NAME_CONFLICT', '已有同名标签');
  const timestamp = libraryNow();
  const created = await tx.libraryTag.create({ data: { id: entityId ?? randomUUID(), ...named, createdAt: timestamp, updatedAt: timestamp } });
  await recordChange(tx, 'libraryTag', created.id, 'create', null, tagSnapshot(created), context);
  return created;
}

export async function updateTag(tx: LibraryDb, actor: Actor, id: string, expectedRevision: number | undefined, name: string, context: MutationContext) {
  if (actor.kind !== 'user') throw libraryError('OWNER_REQUIRED', '只有本机用户可以管理标签', 403);
  const tag = await tx.libraryTag.findUnique({ where: { id } });
  if (!tag) throw libraryError('NOT_FOUND', '标签不存在', 404);
  assertExpected(tag.revision, expectedRevision);
  const named = displayName(name, 1, 40);
  if (!named) throw libraryError('INVALID_NAME', '标签名称需要 1 到 40 个字符', 400);
  const conflict = await tx.libraryTag.findUnique({ where: { normalizedName: named.normalizedName } });
  if (conflict && conflict.id !== id) throw libraryError('TAG_NAME_CONFLICT', '已有同名标签');
  const before = tagSnapshot(tag);
  const updated = await tx.libraryTag.update({ where: { id, revision: tag.revision }, data: { ...named, revision: { increment: 1 }, updatedAt: libraryNow() } });
  const materials = await tx.materialTag.findMany({ where: { tagId: id }, select: { materialId: true } });
  for (const row of materials) await retagMaterialDocuments(tx, row.materialId, await tagNames(tx, row.materialId));
  await recordChange(tx, 'libraryTag', id, 'update', before, tagSnapshot(updated), context);
  return updated;
}

export async function deleteTag(tx: LibraryDb, actor: Actor, id: string, expectedRevision: number | undefined, context: MutationContext) {
  if (actor.kind !== 'user') throw libraryError('OWNER_REQUIRED', '只有本机用户可以管理标签', 403);
  const tag = await tx.libraryTag.findUnique({ where: { id } });
  if (!tag) throw libraryError('NOT_FOUND', '标签不存在', 404);
  assertExpected(tag.revision, expectedRevision);
  if (await tx.materialTag.count({ where: { tagId: id } })) throw libraryError('TAG_IN_USE', '标签仍在使用');
  await tx.libraryTag.delete({ where: { id } });
  await recordChange(tx, 'libraryTag', id, 'delete', tagSnapshot(tag), { id, deleted: true }, context);
  return { id, deleted: true };
}

export async function undoLibraryFolder(tx: LibraryDb, actor: Actor, record: { entityId: string; operation: string; beforeSnapshot: string | null; afterSnapshot: string | null }) {
  if (actor.kind !== 'user') throw libraryError('OWNER_REQUIRED', '只有本机用户可以管理文件夹', 403);
  const before = record.beforeSnapshot ? JSON.parse(record.beforeSnapshot) as FolderSnapshot | null : null;
  const after = record.afterSnapshot ? JSON.parse(record.afterSnapshot) as FolderSnapshot & { deleted?: boolean } : null;
  if (!after) throw libraryError('UNDO_CONFLICT', '缺少可验证的文件夹版本');
  if (record.operation === 'create' || !before) {
    const current = await tx.libraryFolder.findUnique({ where: { id: record.entityId } });
    if (!current || current.revision !== after.revision) throw libraryError('UNDO_CONFLICT', '文件夹已有后续修改');
    if (await tx.libraryFolder.count({ where: { parentId: current.id } }) || await tx.material.count({ where: { folderId: current.id } })) throw libraryError('UNDO_CONFLICT', '文件夹已不为空');
    await tx.libraryFolder.delete({ where: { id: current.id } });
    return { id: current.id, deleted: true };
  }
  if (record.operation === 'delete' || after.deleted) {
    if (await tx.libraryFolder.findUnique({ where: { id: before.id } })) throw libraryError('UNDO_CONFLICT', '文件夹已恢复');
    if (before.parentId && !await tx.libraryFolder.findUnique({ where: { id: before.parentId } })) throw libraryError('UNDO_CONFLICT', '原文件夹已不存在');
    if (await tx.libraryFolder.findFirst({ where: { parentId: before.parentId, normalizedName: before.normalizedName } })) throw libraryError('UNDO_CONFLICT', '同一层已有同名文件夹');
    return tx.libraryFolder.create({ data: before });
  }
  const current = await tx.libraryFolder.findUnique({ where: { id: record.entityId } });
  if (!current || current.revision !== after.revision) throw libraryError('UNDO_CONFLICT', '文件夹已有后续修改');
  await placeFolder(tx, current.id, before.parentId);
  await assertSiblingName(tx, before.parentId, before.normalizedName, current.id);
  return tx.libraryFolder.update({ where: { id: current.id }, data: { parentId: before.parentId, name: before.name, normalizedName: before.normalizedName, revision: { increment: 1 }, updatedAt: libraryNow() } });
}

export async function undoLibraryTag(tx: LibraryDb, actor: Actor, record: { entityId: string; operation: string; beforeSnapshot: string | null; afterSnapshot: string | null }) {
  if (actor.kind !== 'user') throw libraryError('OWNER_REQUIRED', '只有本机用户可以管理标签', 403);
  const before = record.beforeSnapshot ? JSON.parse(record.beforeSnapshot) as TagSnapshot | null : null;
  const after = record.afterSnapshot ? JSON.parse(record.afterSnapshot) as TagSnapshot & { deleted?: boolean } : null;
  if (!after) throw libraryError('UNDO_CONFLICT', '缺少可验证的标签版本');
  if (record.operation === 'create' || !before) {
    const current = await tx.libraryTag.findUnique({ where: { id: record.entityId } });
    if (!current || current.revision !== after.revision) throw libraryError('UNDO_CONFLICT', '标签已有后续修改');
    if (await tx.materialTag.count({ where: { tagId: current.id } })) throw libraryError('UNDO_CONFLICT', '标签仍在使用');
    await tx.libraryTag.delete({ where: { id: current.id } });
    return { id: current.id, deleted: true };
  }
  if (record.operation === 'delete' || after.deleted) {
    if (await tx.libraryTag.findUnique({ where: { id: before.id } })) throw libraryError('UNDO_CONFLICT', '标签已恢复');
    if (await tx.libraryTag.findUnique({ where: { normalizedName: before.normalizedName } })) throw libraryError('UNDO_CONFLICT', '已有同名标签');
    return tx.libraryTag.create({ data: before });
  }
  const current = await tx.libraryTag.findUnique({ where: { id: record.entityId } });
  if (!current || current.revision !== after.revision) throw libraryError('UNDO_CONFLICT', '标签已有后续修改');
  if (await tx.libraryTag.findFirst({ where: { normalizedName: before.normalizedName, id: { not: current.id } } })) throw libraryError('UNDO_CONFLICT', '已有同名标签');
  const updated = await tx.libraryTag.update({ where: { id: current.id }, data: { name: before.name, normalizedName: before.normalizedName, revision: { increment: 1 }, updatedAt: libraryNow() } });
  const materials = await tx.materialTag.findMany({ where: { tagId: current.id }, select: { materialId: true } });
  for (const row of materials) await retagMaterialDocuments(tx, row.materialId, await tagNames(tx, row.materialId));
  return updated;
}

export async function ensureReadableTasks(tx: LibraryDb, actor: Actor, taskIds: string[]) {
  for (const taskId of taskIds) await loadTask(tx, actor, taskId);
}

export function linkChanged(before: MaterialTaskLink[], after: LinkFlag[]) {
  return JSON.stringify(before.map((row) => ({ taskId: row.taskId, manual: row.manual, legacy: row.legacy })).sort(linkOrder)) !== JSON.stringify(after);
}

export async function requireMaterial(tx: LibraryDb, actor: Actor, id: string) {
  return readableMaterial(tx, actor, id);
}
