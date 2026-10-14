import { z } from 'zod';
import { registerCommandHandler, type Command } from '../commands.js';
import { jsonSchema } from '../command-catalog.js';
import { actorFromConnection, type Actor } from '../security.js';
import type { MutationContext } from '../workspace-store.js';
import type { LibraryDb } from './access.js';
import { assertExpected, assertWritableTopic, libraryError, topicVisible, writableMaterial } from './access.js';
import { createFolder, updateFolder, deleteFolder, createTag, updateTag, deleteTag, organizeMaterial, changeLinks, ensureReadableTasks, undoLibraryFolder, undoLibraryTag } from './links.js';
import { replaceMaterialFromUpload, uploadMaterialInput } from './material-write.js';
import { referenceMaterials } from './references.js';
import { requeueExtraction } from './worker.js';
import { registerUndoHandler } from '../undo-registry.js';
import { prisma } from '../../infrastructure/prisma.js';

const folderCreate = z.object({ parentId: z.string().min(1).nullable(), name: z.string() }).strict();
const folderUpdate = z.object({ parentId: z.string().min(1).nullable().optional(), name: z.string().optional() }).strict();
const tagCreate = z.object({ name: z.string() }).strict();
const tagUpdate = z.object({ name: z.string() }).strict();
const organize = z.object({ expectedOrganizationRevision: z.number().int().positive(), folderId: z.string().min(1).nullable().optional(), tagIds: z.array(z.string().min(1)).optional() }).strict();
const links = z.object({
  expectedOrganizationRevision: z.number().int().positive(),
  addTaskIds: z.array(z.string().min(1)).default([]),
  removeTaskIds: z.array(z.string().min(1)).default([]),
  removeInlineReferences: z.boolean(),
  expectedTaskRevisions: z.record(z.number().int().positive()).default({}),
}).strict();
const replace = z.object({ uploadId: z.string().min(1) }).strict();
const referenceRange = z.object({
  materialIds: z.array(z.string().min(1)).min(1), from: z.number().int().min(0), to: z.number().int().min(0),
  expectedMaterialRevisions: z.record(z.number().int().positive()), expectedOrganizationRevisions: z.record(z.number().int().positive()),
}).strict();
const referenceWhole = z.object({
  materialIds: z.array(z.string().min(1)).min(1), description: z.string(),
  expectedMaterialRevisions: z.record(z.number().int().positive()), expectedOrganizationRevisions: z.record(z.number().int().positive()),
}).strict();
// 范围偏移与整篇正文两种输入互斥：混传或都不传都会同时违背两个分支。
const reference = z.union([referenceRange, referenceWhole]);

async function currentActor(tx: LibraryDb, actor: Actor) {
  if (actor.kind !== 'connection' || !actor.connectionId) return actor;
  const row = await tx.connection.findUnique({ where: { id: actor.connectionId } });
  if (!row || row.status !== 'active') throw libraryError('CONNECTION_REVOKED', '连接已撤销', 401);
  return actorFromConnection(row);
}

async function inspectLibrary(tx: LibraryDb, actor: Actor, command: Command, schema: z.ZodTypeAny) {
  const input = schema.parse(command.input ?? {});
  const current = await currentActor(tx, actor);
  if (command.kind === 'material.reextract' || command.kind === 'material.replace' || command.kind === 'material.organize' || command.kind === 'material.links') {
    const material = await writableMaterial(tx, current, command.targetId ?? '');
    assertExpected(material.revision, command.expectedRevision);
    if (command.kind === 'material.organize') {
      const parsed = organize.parse(input);
      assertExpected(material.organizationRevision, parsed.expectedOrganizationRevision, '整理已经变化，请刷新后重试');
      if (parsed.folderId) {
        const folder = await tx.libraryFolder.findUnique({ where: { id: parsed.folderId } });
        if (!folder) throw libraryError('NOT_FOUND', '文件夹不存在', 404);
      }
      if (parsed.tagIds?.length) {
        const ids = [...new Set(parsed.tagIds)];
        const found = await tx.libraryTag.findMany({ where: { id: { in: ids } } });
        if (found.length !== ids.length) throw libraryError('NOT_FOUND', '标签不存在', 404);
      }
    }
    if (command.kind === 'material.links') {
      const parsed = links.parse(input);
      assertExpected(material.organizationRevision, parsed.expectedOrganizationRevision, '整理已经变化，请刷新后重试');
      const taskIds = [...new Set([...parsed.addTaskIds, ...parsed.removeTaskIds])];
      if (taskIds.some((id) => parsed.addTaskIds.includes(id) && parsed.removeTaskIds.includes(id))) throw libraryError('INVALID_LINKS', '同一任务不能同时关联和解除', 400);
      await ensureReadableTasks(tx, current, taskIds);
    }
    if (command.kind === 'material.replace') {
      const upload = await tx.libraryUpload.findUnique({ where: { id: replace.parse(input).uploadId } });
      if (!upload || upload.actorId !== current.id) throw libraryError('NOT_FOUND', '上传不存在', 404);
    }
    return { preconditions: { materialId: material.id, revision: material.revision, organizationRevision: material.organizationRevision }, preview: { kind: command.kind, title: material.title } };
  }
  if (command.kind === 'task.reference_materials') {
    const task = await tx.task.findUnique({ where: { id: command.targetId } });
    if (!task || task.deletedAt || !topicVisible(current, task.topicId)) throw libraryError('NOT_FOUND', '任务不存在', 404);
    await assertWritableTopic(tx, current, task.topicId);
    assertExpected(task.revision, command.expectedRevision, '任务已经变化，请刷新后重试');
    const parsed = reference.parse(input);
    for (const materialId of [...new Set(parsed.materialIds)]) await writableMaterial(tx, current, materialId);
    return { preconditions: { taskId: task.id, revision: task.revision }, preview: { kind: command.kind } };
  }
  if (command.kind.endsWith('.update') || command.kind.endsWith('.delete')) {
    const folder = command.kind.startsWith('libraryFolder');
    const row = folder ? await tx.libraryFolder.findUnique({ where: { id: command.targetId } }) : await tx.libraryTag.findUnique({ where: { id: command.targetId } });
    if (!row) throw libraryError('NOT_FOUND', folder ? '文件夹不存在' : '标签不存在', 404);
    if (row.revision !== command.expectedRevision) throw libraryError('VERSION_CONFLICT', '内容已经变化，请刷新后重试');
    return { preconditions: { id: row.id, revision: row.revision }, preview: { kind: command.kind, name: 'name' in row ? row.name : undefined } };
  }
  return { preconditions: { actorId: actor.id }, preview: { kind: command.kind, input } };
}

async function run(tx: LibraryDb, actor: Actor, command: Command, context: MutationContext) {
  const current = await currentActor(tx, actor);
  if (command.kind === 'material.replace') return replaceMaterialFromUpload(tx, current, command.targetId ?? '', command.expectedRevision, replace.parse(command.input).uploadId, context);
  if (command.kind === 'material.organize') return organizeMaterial(tx, current, command.targetId ?? '', command.expectedRevision, organize.parse(command.input), context);
  if (command.kind === 'material.links') return changeLinks(tx, current, command.targetId ?? '', command.expectedRevision, links.parse(command.input), context);
  if (command.kind === 'material.reextract') {
    z.object({}).strict().parse(command.input ?? {});
    const material = await writableMaterial(tx, current, command.targetId ?? '');
    assertExpected(material.revision, command.expectedRevision);
    await requeueExtraction(tx, material.id, material.revision);
    return { id: material.id, revision: material.revision, organizationRevision: material.organizationRevision };
  }
  if (command.kind === 'libraryFolder.create') return createFolder(tx, current, folderCreate.parse(command.input), context.entityId ?? command.entityId, context);
  if (command.kind === 'libraryFolder.update') return updateFolder(tx, current, command.targetId ?? '', command.expectedRevision, folderUpdate.parse(command.input), context);
  if (command.kind === 'libraryFolder.delete') { z.object({}).strict().parse(command.input ?? {}); return deleteFolder(tx, current, command.targetId ?? '', command.expectedRevision, context); }
  if (command.kind === 'libraryTag.create') return createTag(tx, current, tagCreate.parse(command.input).name, context.entityId ?? command.entityId, context);
  if (command.kind === 'libraryTag.update') return updateTag(tx, current, command.targetId ?? '', command.expectedRevision, tagUpdate.parse(command.input).name, context);
  if (command.kind === 'libraryTag.delete') { z.object({}).strict().parse(command.input ?? {}); return deleteTag(tx, current, command.targetId ?? '', command.expectedRevision, context); }
  if (command.kind === 'task.reference_materials') return referenceMaterials(tx, current, command.targetId ?? '', command.expectedRevision, reference.parse(command.input), context);
  throw libraryError('UNKNOWN_COMMAND', '不支持的资料命令', 400);
}

export function registerLibraryCommands() {
  const schemas: Record<string, z.ZodTypeAny> = {
    'material.replace': replace, 'material.organize': organize, 'material.links': links, 'material.reextract': z.object({}).strict(),
    'libraryFolder.create': folderCreate, 'libraryFolder.update': folderUpdate, 'libraryFolder.delete': z.object({}).strict(),
    'libraryTag.create': tagCreate, 'libraryTag.update': tagUpdate, 'libraryTag.delete': z.object({}).strict(),
    'task.reference_materials': reference,
  };
  const descriptions: Record<string, string> = {
    'material.replace': '用已上传的原件替换资料的当前版本。',
    'material.organize': '移动文件夹或替换标签。省略的字段保持不变，null 清空文件夹，空数组清空标签。',
    'material.links': '为一份资料增加或解除多个任务关联。正文仍引用时需要明确移除引用。',
    'material.reextract': '重新排队解析当前版本，不产生新版本。',
    'libraryFolder.create': '创建资料文件夹。',
    'libraryFolder.update': '重命名或移动文件夹。',
    'libraryFolder.delete': '删除空文件夹。',
    'libraryTag.create': '创建资料标签。',
    'libraryTag.update': '重命名资料标签。',
    'libraryTag.delete': '删除未被使用的资料标签。',
    'task.reference_materials': '在任务正文插入资料引用，并在同一事务建立关联。from/to 为源码范围偏移；description 为整篇正文提交，二者互斥。',
  };
  for (const [kind, schema] of Object.entries(schemas)) {
    registerCommandHandler(kind, {
      forceProposal: true,
      ownerOnly: kind.startsWith('library'),
      description: descriptions[kind],
      inputSchema: jsonSchema(schema),
      inspect: async (tx, actor, command) => inspectLibrary(tx, actor, command, schema),
      execute: (tx, actor, command, context) => run(tx, actor, command, context),
    });
  }
  registerUndoHandler('libraryFolder', undoLibraryFolder);
  registerUndoHandler('libraryTag', undoLibraryTag);
}

export const libraryUploadCreateSchema = uploadMaterialInput;
void prisma;
