import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../domain/task.js';

export const knowledgeHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export function knowledgeStorageRoot() {
  return resolve(process.env.KNOWLEDGE_STORAGE_ROOT || fileURLToPath(new URL('../../data/knowledge-blobs', import.meta.url)));
}

/** Store bytes once, keyed by their sha256. Identical uploads share the file. */
export async function storeKnowledgeBlob(bytes: Uint8Array) {
  const hash = knowledgeHash(bytes);
  const root = knowledgeStorageRoot();
  await mkdir(root, { recursive: true });
  const destination = resolve(root, hash);
  try { if (knowledgeHash(await readFile(destination)) === hash) return hash; } catch { /* New immutable blob. */ }
  const temporary = resolve(root, `.${hash}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: 'wx' });
  try { await rename(temporary, destination); }
  catch (error) {
    // Concurrent identical uploads can win the rename; never remove the shared blob.
    try { if (knowledgeHash(await readFile(destination)) !== hash) throw error; }
    finally { await unlink(temporary).catch(() => {}); }
  }
  return hash;
}

export async function readKnowledgeBlob(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new DomainError('NOT_FOUND', '附件不存在', 404);
  const bytes = await readFile(resolve(knowledgeStorageRoot(), hash)).catch(() => { throw new DomainError('ATTACHMENT_MISSING', '附件原件已不可用', 404); });
  if (knowledgeHash(bytes) !== hash) throw new DomainError('ATTACHMENT_CORRUPT', '附件内容校验失败');
  return bytes;
}
