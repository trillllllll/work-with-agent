import type { PrismaClient } from '@prisma/client';

/** Rows that reference materials or versions. Call this before deleting those parents. */
export async function clearLibraryData(prisma: PrismaClient) {
  await prisma.resourceReference.deleteMany();
  await prisma.resourceWriteReceipt.deleteMany();
  await prisma.resourceLegacyAlias.deleteMany();
  await prisma.librarySearchPosting.deleteMany();
  await prisma.librarySearchDocument.deleteMany();
  await prisma.materialChunk.deleteMany();
  await prisma.materialExtraction.deleteMany();
  await prisma.materialTag.deleteMany();
  await prisma.materialTaskLink.deleteMany();
  await prisma.libraryAnswer.deleteMany();
  await prisma.libraryUpload.deleteMany();
}

/** Folders and tags. Call this only after materials that reference them are gone. */
export async function clearLibraryTaxonomy(prisma: PrismaClient) {
  const folders = await prisma.libraryFolder.findMany({ select: { id: true, parentId: true } });
  const pending = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  while (pending.size) {
    const leaves = [...pending].filter(([id]) => ![...pending.values()].includes(id)).map(([id]) => id);
    if (!leaves.length) break;
    await prisma.libraryFolder.deleteMany({ where: { id: { in: leaves } } });
    for (const id of leaves) pending.delete(id);
  }
  await prisma.libraryTag.deleteMany();
}
