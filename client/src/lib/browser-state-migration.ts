import { DRAFT_DATABASE, DRAFT_DATABASE_VERSION, initializeDraftDatabase } from './task-draft-store.js';

/** 0.3 keeps the original preferences and draft database as a recovery source. */
const marker = 'dovun.browser-migration.v1';
export const legacyDraftDatabase = 'wwa-task-editor';
export const currentDraftDatabase = DRAFT_DATABASE;
export function dovunStorageKey(key: string) {
  return key.replace(/^agent-studio\./, 'dovun.').replace(/^todo\./, 'dovun.').replace(/^wwa([.-])/, 'dovun$1');
}
export function migratePreferences(storage: Storage) {
  const receiptKey = 'dovun.preference-migration.v1';
  const raw = storage.getItem(receiptKey);
  const receipt: unknown = raw === null ? [] : JSON.parse(raw);
  if (!Array.isArray(receipt) || !receipt.every(key => typeof key === 'string')) {
    throw new Error('The preference migration receipt is invalid; original state has been preserved.');
  }
  const processed = new Set<string>(receipt);
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (!key || processed.has(key)) continue;
    const next = dovunStorageKey(key), value = storage.getItem(key);
    if (next === key || value === null) continue;
    if (storage.getItem(next) === null) storage.setItem(next, value);
    // Remember even a skipped copy: removing a current value must not revive old work.
    processed.add(key);
  }
  storage.setItem(receiptKey, JSON.stringify([...processed]));
}
function database(factory: IDBFactory, name: string, create: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    // Read the legacy database at its existing version; never request a downgrade.
    const request = create ? factory.open(name, DRAFT_DATABASE_VERSION) : factory.open(name); let absent = false;
    request.onupgradeneeded = () => {
      if (!create) { absent = true; request.transaction!.abort(); return; }
      initializeDraftDatabase(request.result);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => absent ? resolve(null) : reject(request.error);
    request.onblocked = () => reject(new Error('Close other workspace tabs before migrating drafts.'));
  });
}
export async function migrateBrowserDrafts(factory: IDBFactory, storage: Storage) {
  migratePreferences(storage);
  const old = await database(factory, legacyDraftDatabase, false);
  if (!old) { storage.setItem(marker, 'done'); return; }
  let current: IDBDatabase | null = null;
  try {
    if (!old.objectStoreNames.contains('drafts')) throw new Error('The old draft store is unrecognized; it has been preserved.');
    const records = await new Promise<any[]>((resolve, reject) => {
      const tx = old.transaction('drafts', 'readonly'), request = tx.objectStore('drafts').getAll();
      tx.oncomplete = () => resolve(request.result); tx.onerror = tx.onabort = () => reject(tx.error);
    });
    current = await database(factory, currentDraftDatabase, true);
    if (!current) throw new Error('Cannot open Dovun drafts.');
    // Stable recovery IDs make a failed retry idempotent without replacing newer drafts.
    let imported: string[] = [];
    try { const stored = JSON.parse(storage.getItem(marker) ?? '[]'); if (Array.isArray(stored)) imported = stored; } catch { /* Older transition markers are scanned once. */ }
    const known = new Set(imported);
    const recoveryIds = await Promise.all(records.map(async record => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(record)));
      return 'legacy-' + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
    }));
    await new Promise<void>((resolve, reject) => {
      const tx = current!.transaction('drafts', 'readwrite'), store = tx.objectStore('drafts');
      records.forEach((record, index) => {
        if (known.has(recoveryIds[index])) return;
        const lookup = store.get([record.scopeKey, record.taskId, record.branchId]);
        lookup.onsuccess = () => {
          if (!lookup.result) store.add(record);
          else if (JSON.stringify(lookup.result) !== JSON.stringify(record)) {
            const recovery = { ...record, branchId: recoveryIds[index] };
            const found = store.get([recovery.scopeKey, recovery.taskId, recovery.branchId]);
            found.onsuccess = () => { if (!found.result) store.add(recovery); };
          }
        };
      });
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    });
    storage.setItem(marker, JSON.stringify([...new Set([...imported, ...recoveryIds])]));
  } finally { old.close(); current?.close(); }
}
