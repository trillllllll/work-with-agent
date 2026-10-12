import { recordChange, type MutationContext } from '../workspace-store.js';
import type { Actor } from '../security.js';
import { assertExpected, assertWritableTopic, libraryError, libraryNow, writableMaterial, type LibraryDb } from './access.js';
import { insertMaterialCitations, materialCitation, materialReferences } from './citations.js';
import { addManualLinks, bumpOrganization, materialSnapshot } from './links.js';

async function openMaterial(tx: LibraryDb, actor: Actor, materialId: string) {
  try { return await writableMaterial(tx, actor, materialId); }
  catch { throw libraryError('MATERIAL_REFERENCE_DENIED', '引用的资料不存在或不可访问', 403); }
}

async function cite(tx: LibraryDb, actor: Actor, materialId: string, taskId: string, context: MutationContext) {
  const material = await openMaterial(tx, actor, materialId);
  const before = await materialSnapshot(tx, material);
  if (await addManualLinks(tx, material.id, [taskId], actor)) await bumpOrganization(tx, material, context, before);
  return material;
}

/** Ordinary task saves add manual links for newly introduced citations and leave removed citations linked. */
export async function syncNewMaterialReferences(tx: LibraryDb, actor: Actor, taskId: string, before: string, after: string, context: MutationContext) {
  const previous = new Set(materialReferences(before).map((hit) => hit.materialId));
  const added = [...new Set(materialReferences(after).map((hit) => hit.materialId))].filter((id) => !previous.has(id));
  for (const materialId of added) await cite(tx, actor, materialId, taskId, context);
}

export async function referenceMaterials(tx: LibraryDb, actor: Actor, taskId: string, expectedRevision: number | undefined, input: {
  materialIds: string[];
  from: number;
  to: number;
  expectedMaterialRevisions: Record<string, number>;
  expectedOrganizationRevisions: Record<string, number>;
}, context: MutationContext) {
  const task = await tx.task.findUnique({ where: { id: taskId } });
  if (!task || task.deletedAt) throw libraryError('NOT_FOUND', '任务不存在', 404);
  await assertWritableTopic(tx, actor, task.topicId);
  assertExpected(task.revision, expectedRevision, '任务已经变化，请刷新后重试');
  const ids = [...new Set(input.materialIds)];
  if (!ids.length) throw libraryError('INVALID_REFERENCE', '至少选择一份资料', 400);
  const citations: string[] = [];
  for (const materialId of ids) {
    const material = await openMaterial(tx, actor, materialId);
    assertExpected(material.revision, input.expectedMaterialRevisions[materialId]);
    assertExpected(material.organizationRevision, input.expectedOrganizationRevisions[materialId], '整理已经变化，请刷新后重试');
    citations.push(materialCitation(material.id, material.title));
  }
  const description = insertMaterialCitations(task.description, input.from, input.to, citations);
  if (description === null) throw libraryError('INVALID_RANGE', '正文插入位置无效', 400);
  const timestamp = libraryNow();
  const updated = await tx.task.update({ where: { id: task.id, revision: task.revision }, data: { description, revision: { increment: 1 }, updatedAt: timestamp } });
  await recordChange(tx, 'task', task.id, 'update', { id: task.id, revision: task.revision, description: task.description }, { id: task.id, revision: updated.revision, description }, context);
  for (const materialId of ids) await cite(tx, actor, materialId, task.id, context);
  return { id: task.id, revision: updated.revision, description, materialIds: ids };
}
