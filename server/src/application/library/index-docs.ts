import { randomUUID } from 'node:crypto';
import type { Material, MaterialVersion } from '@prisma/client';
import { normMapSchema, writeJson } from './schema.js';
import { indexTokens, normalizeWithMap } from './text.js';
import type { LibraryDb } from './access.js';

type IndexedMaterial = Pick<Material, 'id' | 'title'>;
type IndexedVersion = Pick<MaterialVersion, 'materialId' | 'revision' | 'fileName'>;

export async function tagNames(tx: LibraryDb, materialId: string) {
  const rows = await tx.materialTag.findMany({ where: { materialId }, include: { tag: true }, orderBy: { tag: { normalizedName: 'asc' } } });
  return rows.map((row) => row.tag.name);
}

function fieldNorm(value: string) {
  return normalizeWithMap(value);
}

export async function replacePostings(tx: LibraryDb, documentId: string, fields: string[]) {
  await tx.librarySearchPosting.deleteMany({ where: { documentId } });
  const tokens = new Set<string>();
  for (const field of fields) for (const token of indexTokens(field)) tokens.add(token);
  if (tokens.size) await tx.librarySearchPosting.createMany({ data: [...tokens].map((token) => ({ token, documentId })) });
}

export async function writeMetaDocument(tx: LibraryDb, material: IndexedMaterial, version: IndexedVersion, names: string[]) {
  const title = fieldNorm(material.title);
  const fileName = fieldNorm(version.fileName ?? '');
  const tags = fieldNorm(names.join(' '));
  const existing = await tx.librarySearchDocument.findFirst({ where: { materialId: version.materialId, revision: version.revision, chunkId: null } });
  const data = { titleNorm: title.normalized, fileNameNorm: fileName.normalized, tagsNorm: tags.normalized, bodyNorm: '', normalizationMapJson: '[]' };
  const document = existing
    ? await tx.librarySearchDocument.update({ where: { id: existing.id }, data })
    : await tx.librarySearchDocument.create({ data: { id: randomUUID(), materialId: version.materialId, revision: version.revision, chunkId: null, ...data } });
  await replacePostings(tx, document.id, [title.normalized, fileName.normalized, tags.normalized]);
  return document;
}

export async function retagMaterialDocuments(tx: LibraryDb, materialId: string, names: string[]) {
  const tags = fieldNorm(names.join(' ')).normalized;
  const documents = await tx.librarySearchDocument.findMany({ where: { materialId } });
  for (const document of documents) {
    await tx.librarySearchDocument.update({ where: { id: document.id }, data: { tagsNorm: tags } });
    await replacePostings(tx, document.id, [document.titleNorm, document.fileNameNorm, tags, document.bodyNorm]);
  }
}

export async function replaceActiveDocuments(tx: LibraryDb, material: IndexedMaterial, version: IndexedVersion, names: string[], chunks: Array<{ id: string; text: string }>) {
  await tx.librarySearchDocument.deleteMany({ where: { materialId: version.materialId, revision: version.revision } });
  await writeMetaDocument(tx, material, version, names);
  const title = fieldNorm(material.title).normalized;
  const fileName = fieldNorm(version.fileName ?? '').normalized;
  const tags = fieldNorm(names.join(' ')).normalized;
  for (const chunk of chunks) {
    const body = fieldNorm(chunk.text);
    const document = await tx.librarySearchDocument.create({ data: {
      id: randomUUID(), materialId: version.materialId, revision: version.revision, chunkId: chunk.id,
      titleNorm: title, fileNameNorm: fileName, tagsNorm: tags, bodyNorm: body.normalized,
      normalizationMapJson: writeJson(normMapSchema, body.map),
    } });
    await replacePostings(tx, document.id, [title, fileName, tags, body.normalized]);
  }
}
