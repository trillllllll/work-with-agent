import type { TaskText, TaskTextDraftV1 } from './task-editor-types.js';

export const DRAFT_DATABASE = 'wwa-task-editor';
export const DRAFT_STORE = 'drafts';
export const DRAFT_KEY_PATH = ['scopeKey', 'taskId', 'branchId'];

export function draftKeyPath(record: { scopeKey: string; taskId: string; branchId: string }) {
  return [record.scopeKey, record.taskId, record.branchId];
}

export function computeScopeKey(origin: string, normalizedApiBaseUrl: string, actorId: string) {
  return JSON.stringify([origin, normalizedApiBaseUrl, actorId]);
}

/** 命名空间：origin + 规范化 API 地址 + 登录身份；不用 CSRF、cookie 或启动凭据。 */
export function normalizeApiBaseUrl(raw: string, fallbackOrigin: string) {
  const base = raw && raw.trim() ? raw : fallbackOrigin;
  try {
    const url = new URL(base);
    url.search = '';
    url.hash = '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return base.replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

export type DraftDeleteGuard = {
  recordVersion: number;
  outboxEmpty: boolean;
  text: TaskText;
};

/**
 * 草稿仓库：原生 IndexedDB。
 * 写入成功以 transaction.oncomplete 为准；旧版本快照在事务内被忽略；
 * 删除必须在事务中核对版本、outbox 和最新文字。
 */
export class TaskDraftStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = (typeof indexedDB !== 'undefined' ? indexedDB : undefined as unknown as IDBFactory)) {}

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const request = this.factory.open(DRAFT_DATABASE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DRAFT_STORE)) {
          const store = db.createObjectStore(DRAFT_STORE, { keyPath: DRAFT_KEY_PATH });
          store.createIndex('byScopeTask', ['scopeKey', 'taskId']);
          store.createIndex('byScope', 'scopeKey');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('draft database failed to open'));
      request.onblocked = () => reject(new Error('draft database blocked by another version'));
    });
    return this.database;
  }

  async load(scopeKey: string, taskId: string): Promise<TaskTextDraftV1[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readonly');
      const index = tx.objectStore(DRAFT_STORE).index('byScopeTask');
      const request = index.getAll([scopeKey, taskId]);
      request.onsuccess = () => resolve((request.result ?? []) as TaskTextDraftV1[]);
      tx.onerror = () => reject(tx.error ?? new Error('draft read failed'));
      tx.onabort = () => reject(tx.error ?? new Error('draft read aborted'));
    });
  }

  async listScope(scopeKey: string): Promise<TaskTextDraftV1[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readonly');
      const index = tx.objectStore(DRAFT_STORE).index('byScope');
      const request = index.getAll(scopeKey);
      request.onsuccess = () => resolve((request.result ?? []) as TaskTextDraftV1[]);
      tx.onerror = () => reject(tx.error ?? new Error('draft listing failed'));
      tx.onabort = () => reject(tx.error ?? new Error('draft listing aborted'));
    });
  }

  /**
   * 持久化一条记录快照。在 readwrite 事务内先读当前记录：
   * 当前 recordVersion 更大时忽略旧快照；写入成功以 oncomplete 为准。
   */
  async put(record: TaskTextDraftV1): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      const store = tx.objectStore(DRAFT_STORE);
      const read = store.get(draftKeyPath(record));
      read.onsuccess = () => {
        const current = read.result as TaskTextDraftV1 | undefined;
        if (current && current.recordVersion > record.recordVersion) return;
        store.put(record);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('draft write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('draft write aborted'));
    });
  }

  /** 条件删除：版本、outbox 与最新文字全部吻合才删除，否则保留。 */
  async deleteIfResolved(scopeKey: string, taskId: string, branchId: string, guard: DraftDeleteGuard): Promise<boolean> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      const store = tx.objectStore(DRAFT_STORE);
      const read = store.get([scopeKey, taskId, branchId]);
      let deleted = false;
      read.onsuccess = () => {
        const current = read.result as TaskTextDraftV1 | undefined;
        if (!current) {
          deleted = true;
          return;
        }
        if (current.recordVersion !== guard.recordVersion) return;
        if (guard.outboxEmpty && current.outbox) return;
        if (current.draft.title !== guard.text.title || current.draft.description !== guard.text.description) return;
        store.delete([scopeKey, taskId, branchId]);
        deleted = true;
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error ?? new Error('draft delete failed'));
      tx.onabort = () => reject(tx.error ?? new Error('draft delete aborted'));
    });
  }

  /** 显式删除一个分支（用户明确放弃，或确认内容已解决）。 */
  async deleteBranch(scopeKey: string, taskId: string, branchId: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      tx.objectStore(DRAFT_STORE).delete([scopeKey, taskId, branchId]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('draft delete failed'));
      tx.onabort = () => reject(tx.error ?? new Error('draft delete aborted'));
    });
  }
}
