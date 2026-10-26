import { describe, expect, it } from 'vitest';
import { TaskDraftStore } from './task-draft-store.js';
import { IDBFactory } from 'fake-indexeddb';
import { migrateBrowserDrafts, migratePreferences, currentDraftDatabase, legacyDraftDatabase } from './browser-state-migration.js';
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}
async function store(factory: IDBFactory, name: string, records?: any[]) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = factory.open(name); req.onupgradeneeded = () => req.result.createObjectStore('drafts', { keyPath: ['scopeKey', 'taskId', 'branchId'] }); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  try { return await new Promise<any[]>((resolve, reject) => { const tx = db.transaction('drafts', records ? 'readwrite' : 'readonly'), rows = tx.objectStore('drafts'); records?.forEach(row => rows.put(row)); const result = rows.getAll(); tx.oncomplete = () => resolve(result.result); tx.onerror = () => reject(tx.error); }); }
  finally { db.close(); }
}
describe('Dovun browser transition', () => {
  it('copies preferences without overriding a new preference or removing the old source', () => {
    const storage = new MemoryStorage(); storage.setItem('wwa.language', 'en'); storage.setItem('agent-studio.theme', 'dark'); storage.setItem('todo.selectedTopic', 'same-id'); storage.setItem('dovun.theme', 'light');
    migratePreferences(storage); migratePreferences(storage);
    expect(storage.getItem('dovun.language')).toBe('en'); expect(storage.getItem('dovun.theme')).toBe('light'); expect(storage.getItem('dovun.selectedTopic')).toBe('same-id'); expect(storage.getItem('agent-studio.theme')).toBe('dark');
  });
  it('does not resurrect cleared requests, conversations or capture drafts on reload', () => {
    for (const key of ['agent-studio.pendingRequest', 'agent-studio.conversationId', 'todo.captureDraft']) {
      const storage = new MemoryStorage(); storage.setItem(key, 'old state');
      migratePreferences(storage);
      const current = key.replace(/^agent-studio\./, 'dovun.').replace(/^todo\./, 'dovun.');
      storage.removeItem(current); migratePreferences(storage);
      expect(storage.getItem(current)).toBeNull(); expect(storage.getItem(key)).toBe('old state');
    }
  });
  it('records legacy keys skipped because a newer value exists', () => {
    const storage = new MemoryStorage(); storage.setItem('agent-studio.conversationId', 'old'); storage.setItem('dovun.conversationId', 'new');
    migratePreferences(storage); storage.removeItem('dovun.conversationId'); migratePreferences(storage);
    expect(storage.getItem('dovun.conversationId')).toBeNull();
  });
  it('preserves user, origin, service and record contents, retaining the old database', async () => {
    const factory = new IDBFactory(), storage = new MemoryStorage();
    const records = [
      { scopeKey: '["origin","server-A","owner"]', taskId: 'same', branchId: 'first', recordVersion: 4, text: '中文未保存正文' },
      { scopeKey: '["origin","server-B","other-user"]', taskId: 'same', branchId: 'first', recordVersion: 3, text: 'another service' },
    ];
    await store(factory, legacyDraftDatabase, records); await migrateBrowserDrafts(factory, storage);
    expect(await store(factory, currentDraftDatabase)).toEqual(records); expect(await store(factory, legacyDraftDatabase)).toEqual(records);
    await migrateBrowserDrafts(factory, storage); expect(await store(factory, currentDraftDatabase)).toHaveLength(2);
  });
  it('keeps conflicting drafts as a recoverable branch instead of replacing newer edits', async () => {
    const factory = new IDBFactory(), storage = new MemoryStorage();
    const key = { scopeKey: 'same-scope', taskId: 'same-task', branchId: 'same-branch' };
    await store(factory, legacyDraftDatabase, [{ ...key, recordVersion: 1, text: 'old unsent text' }]);
    await store(factory, currentDraftDatabase, [{ ...key, recordVersion: 9, text: 'new unsent text' }]);
    await migrateBrowserDrafts(factory, storage); storage.removeItem('dovun.browser-migration.v1'); await migrateBrowserDrafts(factory, storage);
    const rows = await store(factory, currentDraftDatabase); expect(rows).toHaveLength(2); expect(rows.find(row => row.branchId === 'same-branch').text).toBe('new unsent text'); expect(rows.find(row => row.branchId.startsWith('legacy-')).text).toBe('old unsent text');
  });
  it('reloads after the real draft store upgrades to version 2 without losing old or current drafts', async () => {
    const factory = new IDBFactory(), storage = new MemoryStorage();
    const key = { scopeKey: 'scope', taskId: 'task', branchId: 'branch' };
    const original = { ...key, recordVersion: 1, text: '旧草稿' };
    await store(factory, legacyDraftDatabase, [original]);
    await migrateBrowserDrafts(factory, storage);
    await new TaskDraftStore(factory).load('scope', 'task');
    const newer = { ...key, recordVersion: 2, text: '新草稿，不能被覆盖' };
    await store(factory, currentDraftDatabase, [newer]);
    await expect(migrateBrowserDrafts(factory, storage)).resolves.toBeUndefined();
    expect(await store(factory, currentDraftDatabase)).toEqual([newer]);
    expect(await store(factory, legacyDraftDatabase)).toEqual([original]);
    expect((await factory.databases()).find(db => db.name === currentDraftDatabase)?.version).toBe(2);
  });

  it('reads a higher-version legacy database without trying to downgrade it', async () => {
    const factory = new IDBFactory(), storage = new MemoryStorage();
    const records = [{ scopeKey: 'scope', taskId: 'task', branchId: 'branch', text: '保留旧库' }];
    await store(factory, legacyDraftDatabase, records);
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(legacyDraftDatabase, 2);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    old.close();
    await expect(migrateBrowserDrafts(factory, storage)).resolves.toBeUndefined();
    expect(await store(factory, legacyDraftDatabase)).toEqual(records);
    expect(await store(factory, currentDraftDatabase)).toEqual(records);
  });

});
