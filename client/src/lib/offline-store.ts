import type { SyncEntityType, SyncRow } from '../../../server/src/application/sync-merge.js';

export type ReplicaOp = { opId: string; entityType: SyncEntityType; entityId: string; before: SyncRow | null; after: SyncRow | null };
export type ReplicaRow = { id: string; row: SyncRow; revision: number; createdAt: string; updatedAt: string };
export type ReplicaRows = Record<SyncEntityType, Record<string, ReplicaRow>>;
export type BrowserReplica = {
  scope: string; workspaceId: string; schemaVersion: string; token: string; actorId: string;
  authenticatedAt: number; ready: boolean; cursor: number; base: ReplicaRows; rows: ReplicaRows;
  outbox: ReplicaOp[]; receipts: Record<string, { hash: string; result: unknown }>;
  previews: Record<string, { hash: string; versions: string; expires: number }>;
  lastSuccessAt: string | null; lastError: string | null;
  lease?: { owner: string; until: number };
};
export const emptyReplicaRows = (): ReplicaRows => ({ task: {}, topic: {}, tag: {} });

/** One IDB read/write transaction stores the view, outbox and cursor together.
 * Reducers must be synchronous: awaiting network work would close the transaction. */
export class OfflineStore {
  private opened: Promise<IDBDatabase> | undefined;
  constructor(private factory: IDBFactory = indexedDB) {}
  private open() {
    return this.opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open('dovun-workspace-replicas', 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('replicas')) request.result.createObjectStore('replicas', { keyPath: 'scope' });
        if (!request.result.objectStoreNames.contains('responses')) request.result.createObjectStore('responses', { keyPath: ['scope', 'path'] });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Offline storage is busy in another version'));
    });
  }
  async read(scope: string): Promise<BrowserReplica | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('replicas', 'readonly');
      const request = tx.objectStore('replicas').get(scope);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async update<T>(scope: string, reduce: (state: BrowserReplica | undefined) => { state: BrowserReplica; value: T }): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('replicas', 'readwrite');
      const store = tx.objectStore('replicas');
      const request = store.get(scope);
      let result: T;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const reduced = reduce(request.result);
          result = reduced.value;
          store.put(reduced.state);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('Offline write failed'));
    });
  }
  async close() { if (this.opened) (await this.opened).close(); this.opened = undefined; }
  async cache(scope: string, path: string, value: unknown) {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('responses', 'readwrite');
      tx.objectStore('responses').put({ scope, path, value, savedAt: Date.now() });
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async cached(scope: string, path: string): Promise<unknown> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('responses', 'readonly');
      const request = tx.objectStore('responses').get([scope, path]);
      tx.oncomplete = () => resolve(request.result?.value); tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
}
