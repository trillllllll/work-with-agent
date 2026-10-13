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

export async function replacePostings(tx: LibraryDb, documentId: string, materialId: string, fields: string[]) {
  await tx.librarySearchPosting.deleteMany({ where: { documentId } });
  const tokens = new Set<string>();
  for (const field of fields) for (const token of indexTokens(field)) tokens.add(token);
  if (tokens.size) await tx.librarySearchPosting.createMany({ data: [...tokens].map((token) => ({ token, documentId, materialId })) });
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
  await replacePostings(tx, document.id, version.materialId, [title.normalized, fileName.normalized, tags.normalized]);
  return document;
}

export async function retagMaterialDocuments(tx: LibraryDb, materialId: string, names: string[]) {
  const tags = fieldNorm(names.join(' ')).normalized;
  const documents = await tx.librarySearchDocument.findMany({ where: { materialId } });
  for (const document of documents) {
    await tx.librarySearchDocument.update({ where: { id: document.id }, data: { tagsNorm: tags } });
    await replacePostings(tx, document.id, document.materialId, [document.titleNorm, document.fileNameNorm, tags, document.bodyNorm]);
  }
}

async function insertInBatches<T>(rows: T[], write: (batch: T[]) => Promise<unknown>) {
  for (let index = 0; index < rows.length; index += 200) await write(rows.slice(index, index + 200));
}

export async function replaceActiveDocuments(tx: LibraryDb, material: IndexedMaterial, version: IndexedVersion, names: string[], chunks: Array<{ id: string; text: string }>) {
  await tx.librarySearchDocument.deleteMany({ where: { materialId: version.materialId, revision: version.revision } });
  await writeMetaDocument(tx, material, version, names);
  const title = fieldNorm(material.title).normalized;
  const fileName = fieldNorm(version.fileName ?? '').normalized;
  const tags = fieldNorm(names.join(' ')).normalized;
  const documents = [];
  const maps = [];
  const postings = [];
  for (const chunk of chunks) {
    const body = fieldNorm(chunk.text);
    const id = randomUUID();
    documents.push({
      id, materialId: version.materialId, revision: version.revision, chunkId: chunk.id,
      titleNorm: title, fileNameNorm: fileName, tagsNorm: tags, bodyNorm: body.normalized, normalizationMapJson: '[]',
    });
    maps.push({ documentId: id, normalizationMapJson: writeJson(normMapSchema, body.map) });
    const tokens = new Set<string>();
    for (const field of [title, fileName, tags, body.normalized]) for (const token of indexTokens(field)) tokens.add(token);
    for (const token of tokens) postings.push({ token, documentId: id, materialId: version.materialId });
  }
  await insertInBatches(documents, (batch) => tx.librarySearchDocument.createMany({ data: batch }));
  await insertInBatches(maps, (batch) => tx.librarySearchNormMap.createMany({ data: batch }));
  await insertInBatches(postings, (batch) => tx.librarySearchPosting.createMany({ data: batch }));
}
