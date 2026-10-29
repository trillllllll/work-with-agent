import type { PrismaClient } from '@prisma/client';
import { libraryNow } from '../library/access.js';
import { importedUtf8, uploadPresentation } from '../library/material-write.js';
import { versionFormat } from './version.js';
import { readKnowledgeBlob } from '../knowledge-blobs.js';
import { ensureTaskImageResource } from './task-images.js';

/** Repeatable metadata-only backfill: identities, original bytes and historical hashes do not change. */
export async function migrateDocumentResources(db: PrismaClient) {
  const ready = await db.$queryRaw<Array<{ name: string }>>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ResourceLegacyAlias'`;
  if (!ready.length) return null;
  let cursor: string | undefined;
  let mapped = 0;
  let versions = 0;
  for (;;) {
    const materials = await db.material.findMany({ take: 100, orderBy: { id: 'asc' }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!materials.length) break;
    for (const material of materials) {
      await db.$transaction(async (tx) => {
        const existing = await tx.resourceLegacyAlias.findUnique({ where: { sourceKind_sourceId: { sourceKind: 'material', sourceId: material.id } } });
        if (!existing) {
          await tx.resourceLegacyAlias.create({ data: { sourceKind: 'material', sourceId: material.id, resourceId: material.id, createdAt: libraryNow() } });
          mapped += 1;
        }
        const legacy = await tx.materialVersion.findMany({ where: { materialId: material.id, format: null } });
        for (const version of legacy) {
          const inferred = version.attachmentPath && version.fileName ? uploadPresentation(version.fileName, version.mimeType ?? '').kind : material.kind;
          // Legacy text with an attachment can carry supplemental text; retain it verbatim either way.
          let format = versionFormat(inferred, version);
          let authoritativeContent: string | null = null;
          let supplementalContent: string | null = null;
          if (version.attachmentPath && ['text', 'markdown'].includes(format)) {
            const bytes = await readKnowledgeBlob(version.attachmentPath).catch(() => null);
            const text = bytes ? importedUtf8(bytes) : null;
            if (text === null) format = 'binary';
            else {
              authoritativeContent = text;
              if (version.content && version.content !== text) supplementalContent = version.content;
            }
          }
          await tx.materialVersion.update({ where: { id: version.id, format: null }, data: { format, sourceOriginalPath: version.attachmentPath, authoritativeContent, supplementalContent } });
          versions += 1;
        }
      });
    }
    cursor = materials[materials.length - 1].id;
  }
  let imageCursor: string | undefined;
  let mappedTaskImages = 0;
  for (;;) {
    const images = await db.taskImage.findMany({ take: 100, orderBy: { id: 'asc' }, ...(imageCursor ? { cursor: { id: imageCursor }, skip: 1 } : {}) });
    if (!images.length) break;
    for (const image of images) await db.$transaction(async (tx) => { if (await ensureTaskImageResource(tx, image)) mappedTaskImages += 1; });
    imageCursor = images[images.length - 1].id;
  }
  return { mappedMaterials: mapped, annotatedVersions: versions, mappedTaskImages };
}
