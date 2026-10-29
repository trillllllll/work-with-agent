/** Learning drafts never enter the task outbox. Keys include the authenticated
 * server/workspace/user scope and snapshots survive unknown network outcomes. */
export type LearningStored<T = unknown> = { key: string; scope: string; kind: string; id: string; value: T; updatedAt: number };
const DATABASE = 'dovun-learning-v1';
const STORE = 'records';
let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const records = request.result.createObjectStore(STORE, { keyPath: 'key' });
      records.createIndex('scope', 'scope');
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => { database = undefined; reject(request.error ?? new Error('Learning storage unavailable')); };
    request.onblocked = () => { database = undefined; reject(new Error('Learning storage blocked')); };
  });
  return database;
}
const keyFor = (scope: string, kind: string, id: string) => JSON.stringify([scope, kind, id]);
export async function readLearningRecord<T>(scope: string, kind: string, id: string): Promise<T | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(keyFor(scope, kind, id));
    request.onsuccess = () => resolve((request.result as LearningStored<T> | undefined)?.value);
    request.onerror = () => reject(request.error);
  });
}
export async function writeLearningRecord<T>(scope: string, kind: string, id: string, value: T): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key: keyFor(scope, kind, id), scope, kind, id, value, updatedAt: Date.now() } satisfies LearningStored<T>);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Learning storage write aborted'));
  });
}
/** Delete only the captured snapshot. A late receipt must never erase new work. */
export async function removeLearningRecord(scope: string, kind: string, id: string, expectedValue?: unknown): Promise<boolean> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let removed = false;
    const tx = db.transaction(STORE, 'readwrite');
    const records = tx.objectStore(STORE);
    const request = records.get(keyFor(scope, kind, id));
    request.onsuccess = () => {
      const current = request.result as LearningStored | undefined;
      if (current && (expectedValue === undefined || JSON.stringify(current.value) === JSON.stringify(expectedValue))) {
        records.delete(current.key); removed = true;
      }
    };
    tx.oncomplete = () => resolve(removed);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export async function listLearningRecords<T>(scope: string, kind: string): Promise<Array<LearningStored<T>>> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).index('scope').getAll(scope);
    request.onsuccess = () => resolve((request.result as LearningStored<T>[]).filter(record => record.kind === kind));
    request.onerror = () => reject(request.error);
  });
}
export function readLearningPreference<T>(scope: string, id: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(keyFor(scope, 'ui', id)) ?? 'null') as T ?? fallback; } catch { return fallback; }
}
export function writeLearningPreference(scope: string, id: string, value: unknown): boolean {
  try { localStorage.setItem(keyFor(scope, 'ui', id), JSON.stringify(value)); return true; } catch { return false; }
}

/** Soft limits apply only to recoverable, finished session caches. Local answers,
 * unknown requests and unfinished sessions are never evicted to meet a quota. */
export const learningCachePolicy = { finishedCount: 20, finishedBytes: 20 * 1024 * 1024, finishedAgeMs: 30 * 24 * 60 * 60 * 1000 };
export function finishedCacheEvictions(records: LearningStored[], keepId: string, now = Date.now(), pressure = false): string[] {
  const finished = records.filter(row => row.kind === 'session' && row.value && typeof row.value === 'object' && (row.value as { state?: string }).state === 'finished').sort((left, right) => right.updatedAt - left.updatedAt);
  let retained = 0, bytes = 0;
  const remove: string[] = [];
  for (const row of finished) {
    const session = row.value as { items?: Array<{ id: string }> };
    if (!Array.isArray(session.items)) continue;
    const ids = new Set(session.items.map(item => item.id));
    const protectedByLocalWork = row.id === keepId || records.some(local => {
      if (local.kind === 'session-operation' && local.id === row.id) return true;
      if (local.kind === 'carry-answer' && ids.has(local.id)) return true;
      if (local.kind !== 'answer' || ![...ids].some(itemId => local.id.startsWith(`${itemId}:`))) return false;
      const answer = local.value as { answer?: unknown; baseAnswer?: unknown; pendingSave?: unknown; pendingSubmit?: unknown; submitIntent?: unknown } | null;
      return !answer || Boolean(answer.pendingSave || answer.pendingSubmit || answer.submitIntent) || JSON.stringify(answer.answer) !== JSON.stringify(answer.baseAnswer);
    });
    const size = new TextEncoder().encode(JSON.stringify(row.value)).byteLength;
    if (!protectedByLocalWork && (pressure || retained >= learningCachePolicy.finishedCount || bytes + size > learningCachePolicy.finishedBytes || now - row.updatedAt > learningCachePolicy.finishedAgeMs)) remove.push(row.key);
    else { retained++; bytes += size; }
  }
  return remove;
}
export async function pruneFinishedLearningCaches(scope: string, keepId: string, pressure = false): Promise<number> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const records = tx.objectStore(STORE);
    const read = records.index('scope').getAll(scope);
    let count = 0;
    read.onsuccess = () => {
      const keys = finishedCacheEvictions(read.result as LearningStored[], keepId, Date.now(), pressure);
      for (const key of keys) records.delete(key);
      count = keys.length;
    };
    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
