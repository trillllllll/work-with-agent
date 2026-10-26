import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL!;
test.beforeEach(() => resetE2eDatabase());
test.afterAll(() => e2eDatabase.$disconnect());

test('an existing mobile replica recovers legacy logs without clearing browser storage', async ({ page, request }) => {
  // The shared E2E API advertises local mode; activate the server browser client
  // while keeping identity, device authentication, pull and snapshot on real APIs.
  const info = (await (await request.get(`${api}/api/v1/server/info`)).json()).data;
  await page.route('**/api/v1/server/info', route => route.fulfill({ json: { data: { ...info, mode: 'server' }, error: null } }));
  const stamp = new Date().toISOString(), id = 'legacy-log-browser-task';
  await e2eDatabase.task.create({ data: { id, title: '云端当前重复任务', recurrenceRule: '{"unit":"week","step":1}', createdAt: stamp, updatedAt: stamp } });
  const identity = (await (await request.get(`${api}/api/v1/sync/identity`)).json()).data;
  const snapshot = (await (await request.get(`${api}/api/v1/sync/baseline/snapshot?schemaVersion=${identity.schemaVersion}`)).json()).data;
  const current = snapshot.entities.task.find((item: any) => item.id === id).row;
  const legacy = { ...current }; delete legacy.recurrenceRule;
  const old = await e2eDatabase.syncOp.create({ data: { opId: `legacy-browser-${stamp}`, deviceId: 'server', entityType: 'task', entityId: id, beforeJson: null, afterJson: JSON.stringify(legacy), revision: 1, createdAt: stamp } });
  const pair = (await (await request.post(`${api}/api/v1/sync/devices`, { data: { name: 'isolated-browser-regression' } })).json()).data;
  await page.route('**/sync-migration-seed', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Seed existing replica</title>' }));
  await page.goto('/sync-migration-seed');
  await page.evaluate(async ({ identity, token, cursor, id, legacy }) => {
    const scope = JSON.stringify([location.origin, identity.workspaceId, 'local-owner']);
    const rows = { task: { [id]: { id, row: legacy, revision: 1, createdAt: legacy.createdAt, updatedAt: new Date().toISOString() } }, topic: {}, tag: {} };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('dovun-workspace-replicas', 2);
      open.onupgradeneeded = () => { open.result.createObjectStore('replicas', { keyPath: 'scope' }); open.result.createObjectStore('responses', { keyPath: ['scope', 'path'] }); };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('replicas', 'readwrite');
        tx.objectStore('replicas').put({ scope, workspaceId: identity.workspaceId, schemaVersion: identity.schemaVersion, actorId: 'local-owner', token, authenticatedAt: Date.now(), ready: true, cursor, base: rows, rows, outbox: [], receipts: {}, previews: {}, lastSuccessAt: null, lastError: 'SYNC_PROTOCOL_ERROR' });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    });
    localStorage.setItem('dovun.offline.scope', scope);
  }, { identity, token: pair.token, cursor: old.seq - 1, id, legacy });
  const recovery = page.waitForResponse(async response => response.url().includes('/api/v1/sync/pull?') && response.ok() && (await response.json()).data?.baselineRequired === true);
  await page.goto('/#/inbox');
  await recovery;
  await expect(page.getByText('云端当前重复任务', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/同步暂不可用/)).toHaveCount(0);
  const cached = await page.evaluate(() => new Promise<any>((resolve, reject) => {
    const open = indexedDB.open('dovun-workspace-replicas'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, tx = db.transaction('replicas', 'readonly'), read = tx.objectStore('replicas').getAll(); tx.oncomplete = () => { db.close(); resolve(read.result[0]); }; tx.onerror = () => reject(tx.error); };
  }));
  expect(cached.cursor).toBeGreaterThanOrEqual(old.seq);
  expect(cached.lastError).toBeNull();
  expect(cached.outbox).toEqual([]);
  expect(cached.rows.task[id].row.recurrenceRule).toBe(current.recurrenceRule);
  expect((await e2eDatabase.syncOp.findUniqueOrThrow({ where: { seq: old.seq } })).afterJson).toBe(JSON.stringify(legacy));
});
