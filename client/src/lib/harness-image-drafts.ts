import type { HarnessInputAttachment } from '../../../server/src/node-agent/harness-protocol.js';

type ImageAttachment = Extract<HarnessInputAttachment, { kind: 'imageFile' }>;
type StoredImage = { id: string; content: string; expiresAt: number };

const storeName = 'images';
const storedIds = new WeakMap<ImageAttachment, string>();
let database: Promise<IDBDatabase> | undefined;

function openImages() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('dovun-harness-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' }).createIndex('expiresAt', 'expiresAt');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Attachment storage could not be opened'));
  }).catch((error: unknown) => { database = undefined; throw error; });
  return database;
}

export async function keepHarnessImage(file: ImageAttachment) {
  const db = await openImages();
  const id = crypto.randomUUID();
  const now = Date.now();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    store.put({ id, content: file.content, expiresAt: now + 7 * 24 * 60 * 60_000 } satisfies StoredImage);
    // Closed tabs can leave orphaned images. Reclaim them in small batches.
    const expired = store.index('expiresAt').openKeyCursor(IDBKeyRange.upperBound(now));
    let removed = 0;
    expired.onsuccess = () => {
      const cursor = expired.result;
      if (cursor && removed++ < 32) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
  storedIds.set(file, id);
}

async function restoreHarnessImage(image: ImageAttachment & { draftImageId?: string }, id: string) {
  const db = await openImages();
  const row = await new Promise<StoredImage | undefined>((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!row) throw new Error('Saved attachment is unavailable');
  image.content = row.content;
  delete image.draftImageId;
  storedIds.set(image, id);
}

/** Preserve the per-tab draft and the command ID while keeping image bytes out of the small sessionStorage quota. */
export function writeHarnessDraft(key: string, value: unknown) {
  try {
    if (value == null) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, JSON.stringify(value, (_key, item) => {
      const draftImageId = item?.kind === 'imageFile' ? storedIds.get(item) : undefined;
      return draftImageId ? { kind: item.kind, name: item.name, mediaType: item.mediaType, draftImageId } : item;
    }));
  } catch { /* Keep the live draft when storage is unavailable. */ }
}

export async function readHarnessDraft<T>(key: string): Promise<T | null> {
  const reads: Array<Promise<void>> = [];
  const value = JSON.parse(sessionStorage.getItem(key) ?? 'null', (_key, item) => {
    if (item?.kind === 'imageFile' && typeof item.draftImageId === 'string') {
      reads.push(restoreHarnessImage(item, item.draftImageId));
    }
    return item;
  }) as T | null;
  await Promise.all(reads);
  return value;
}
