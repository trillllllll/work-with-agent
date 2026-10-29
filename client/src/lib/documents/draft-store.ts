import type { DocumentDraft, DocumentDraftStorage } from './types.js';

const databaseName = 'dovun-document-drafts';
const draftStore = 'drafts';
const fileStore = 'files';
type StoredAttachment = { version: 1; bytes: ArrayBuffer; mimeType: string };
function key(record: Pick<DocumentDraft, 'scopeKey' | 'localId' | 'sessionId'>) {
  return [record.scopeKey, record.localId, record.sessionId];
}

/** Draft text and new attachment bytes commit together; success means the IDB transaction completed. */
export class DocumentDraftStore implements DocumentDraftStorage {
  private database: Promise<IDBDatabase> | null = null;
  constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {}

  private watch<T>(tx: IDBTransaction, result: () => T, resolve: (value: T) => void, reject: (reason: unknown) => void, message: string) {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result());
    };
    const timer = setTimeout(() => {
      // A suspended/broken IDB write must not leave every other document waiting forever.
      finish(new Error(`${message}: storage timed out; retry after reopening the page`));
      try { tx.abort(); } catch { /* Already completed or browser storage unavailable. */ }
      tx.db.close(); this.database = null;
    }, 30_000);
    tx.oncomplete = () => finish();
    tx.onabort = tx.onerror = () => finish(tx.error ?? new Error(message));
  }

  private open() {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      if (!this.factory) { reject(new Error('Document draft storage is unavailable')); return; }
      const request = this.factory.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(draftStore, { keyPath: ['scopeKey', 'localId', 'sessionId'] });
        store.createIndex('byScope', 'scopeKey');
        store.createIndex('byResource', ['scopeKey', 'resourceId']);
        request.result.createObjectStore(fileStore);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.database = null; };
        resolve(db);
      };
      request.onerror = () => { this.database = null; reject(request.error ?? new Error('Document draft storage could not open')); };
      request.onblocked = () => { this.database = null; reject(new Error('Document draft storage is blocked by another window')); };
    });
    return this.database;
  }

  private async readRows(index: string, value: IDBValidKey) {
    const db = await this.open();
    return new Promise<DocumentDraft[]>((resolve, reject) => {
      const tx = db.transaction(draftStore, 'readonly');
      const read = tx.objectStore(draftStore).index(index).getAll(value);
      this.watch(tx, () => read.result ?? [], resolve, reject, 'Document drafts could not be read');
    });
  }

  load(scopeKey: string, resourceId: string) { return this.readRows('byResource', [scopeKey, resourceId]); }
  listScope(scopeKey: string) { return this.readRows('byScope', scopeKey); }
  put(record: DocumentDraft) { return this.write(record); }
  putWithFile(record: DocumentDraft, uploadId: string, file: Blob) { return this.write(record, { uploadId, file }); }

  private async write(record: DocumentDraft, attachment?: { uploadId: string; file: Blob }) {
    const snapshot = structuredClone(record);
    // WebKit can leave a transaction pending while cloning a File backed by an external
    // file handle. Materialize bytes before opening the transaction, preserving atomicity.
    const storedAttachment: StoredAttachment | undefined = attachment
      ? { version: 1, bytes: await attachment.file.arrayBuffer(), mimeType: attachment.file.type }
      : undefined;
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(attachment ? [draftStore, fileStore] : draftStore, 'readwrite');
      const drafts = tx.objectStore(draftStore);
      const read = drafts.get(key(snapshot));
      read.onsuccess = () => {
        const current = read.result as DocumentDraft | undefined;
        if (current && current.recordVersion > snapshot.recordVersion) return;
        drafts.put(snapshot);
        if (attachment) tx.objectStore(fileStore).put(storedAttachment, [...key(snapshot), attachment.uploadId]);
      };
      this.watch(tx, () => undefined, resolve, reject, 'Document draft could not be persisted');
    });
  }

  async readFile(record: Pick<DocumentDraft, 'scopeKey' | 'localId' | 'sessionId'>, uploadId: string) {
    const db = await this.open();
    return new Promise<Blob | undefined>((resolve, reject) => {
      const tx = db.transaction(fileStore, 'readonly');
      const read = tx.objectStore(fileStore).get([...key(record), uploadId]);
      this.watch(tx, () => {
        const stored = read.result as StoredAttachment | Blob | undefined;
        if (!stored || stored instanceof Blob) return stored;
        return new Blob([stored.bytes], { type: stored.mimeType });
      }, resolve, reject, 'Attachment draft could not be read');
    });
  }

  /** Only retire a source while its Web Lock is held. Without locks, explicit recovery copies it. */
  async adopt(record: DocumentDraft, source: DocumentDraft, retireSource = false) {
    if (record.scopeKey !== source.scopeKey || record.deviceId !== source.deviceId) throw new Error('Cannot adopt a document draft from another scope or device');
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([draftStore, fileStore], 'readwrite');
      const files = tx.objectStore(fileStore);
      for (const upload of source.uploads) {
        const oldKey = [...key(source), upload.id];
        const read = files.get(oldKey);
        read.onsuccess = () => {
          if (read.result !== undefined) files.put(read.result, [...key(record), upload.id]);
          if (retireSource) files.delete(oldKey);
        };
      }
      const drafts = tx.objectStore(draftStore);
      drafts.put(structuredClone(record));
      if (retireSource) drafts.delete(key(source));
      this.watch(tx, () => undefined, resolve, reject, 'Document branch could not be restored');
    });
  }
}
