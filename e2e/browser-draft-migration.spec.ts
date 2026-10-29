import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

test.beforeEach(() => resetE2eDatabase());
test.afterAll(() => e2eDatabase.$disconnect());

for (const currentVersion of [1, 2]) {
  test(`existing draft database v${currentVersion} survives migration and repeated startup`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/draft-migration-seed', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated draft migration setup</title>' }));
    await page.goto('/draft-migration-seed');
    await page.evaluate(async (version) => {
      const key = { scopeKey: 'isolated-migration-scope', taskId: 'saved-task', branchId: 'main' };
      const seed = (name: string, schema: number, title: string) => new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name, schema);
        open.onupgradeneeded = () => {
          const store = open.result.createObjectStore('drafts', { keyPath: ['scopeKey', 'taskId', 'branchId'] });
          store.createIndex('byScopeTask', ['scopeKey', 'taskId']); store.createIndex('byScope', 'scopeKey');
          if (schema === 2) open.result.createObjectStore('scopeMigrations');
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const stores = schema === 2 ? ['drafts', 'scopeMigrations'] : ['drafts'];
          const tx = db.transaction(stores, 'readwrite');
          tx.objectStore('drafts').put({ ...key, schemaVersion: 1, recordVersion: 1, draft: { title, description: title }, outbox: null });
          if (schema === 2) tx.objectStore('scopeMigrations').put('existing-target', 'existing-source');
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
        };
      });
      await seed('wwa-task-editor', 1, '旧版未发送草稿');
      await seed('dovun-task-editor', version, '新版未发送草稿');
    }, currentVersion);
    const checkDrafts = async () => {
      const result = await page.evaluate(async () => {
        const read = (name: string) => new Promise<{ version: number; rows: any[]; marker: unknown }>((resolve, reject) => {
          const open = indexedDB.open(name);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result, stores = Array.from(db.objectStoreNames), tx = db.transaction(stores, 'readonly');
            const rows = tx.objectStore('drafts').getAll();
            const marker = stores.includes('scopeMigrations') ? tx.objectStore('scopeMigrations').get('existing-source') : null;
            tx.oncomplete = () => { resolve({ version: db.version, rows: rows.result, marker: marker?.result ?? null }); db.close(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
          };
        });
        return { old: await read('wwa-task-editor'), current: await read('dovun-task-editor') };
      });
      expect(result.old.version).toBe(1);
      expect(result.old.rows).toHaveLength(1);
      expect(result.old.rows[0].draft.title).toBe('旧版未发送草稿');
      expect(result.current.version).toBe(2);
      expect(result.current.rows).toHaveLength(2);
      expect(result.current.rows.find((row) => row.branchId === 'main')?.draft.title).toBe('新版未发送草稿');
      expect(result.current.rows.find((row) => row.branchId.startsWith('legacy-'))?.draft.title).toBe('旧版未发送草稿');
      if (currentVersion === 2) expect(result.current.marker).toBe('existing-target');
    };
    await page.goto('/#/learning');
    await expect(page.getByRole('heading', { name: '学习地图', exact: true, level: 1 })).toBeVisible();
    await checkDrafts();
    await page.reload();
    await expect(page.getByRole('heading', { name: '学习地图', exact: true, level: 1 })).toBeVisible();
    await checkDrafts();
    expect(errors).toEqual([]);
  });
}
