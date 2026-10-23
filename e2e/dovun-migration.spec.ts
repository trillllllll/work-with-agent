import { test, expect } from './fixtures.js';
import { resetE2eDatabase, e2eDatabase } from './database.js';
const api = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';
test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());
test('legacy preferences and scoped IndexedDB drafts restore before the workspace opens', async ({ page }) => {
  await page.route('**/migration-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('/migration-fixture');
  const source = { scopeKey: '["original-origin","original-server","original-user"]', taskId: 'original-task', branchId: 'original-branch', recordVersion: 3, draft: { title: '未提交标题', description: '未提交正文' } };
  await page.evaluate(async record => {
    localStorage.setItem('wwa.language', 'en'); localStorage.setItem('agent-studio.theme', 'dark'); localStorage.setItem('todo.selectedTopic', 'same-list');
    await new Promise<void>((resolve, reject) => { const request = indexedDB.open('wwa-task-editor', 1); request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: ['scopeKey', 'taskId', 'branchId'] }); request.onsuccess = () => { const db = request.result; const tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put(record); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; request.onerror = () => reject(request.error); });
  }, source);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  const state = await page.evaluate(async () => {
    const rows = await new Promise<unknown[]>((resolve, reject) => { const req = indexedDB.open('dovun-task-editor'); req.onsuccess = () => { const db = req.result; const tx = db.transaction('drafts', 'readonly'); const read = tx.objectStore('drafts').getAll(); tx.oncomplete = () => { db.close(); resolve(read.result); }; tx.onerror = () => reject(tx.error); }; });
    return { rows, theme: localStorage.getItem('dovun.theme'), original: localStorage.getItem('agent-studio.theme'), language: localStorage.getItem('dovun.language') };
  });
  expect(state.rows).toEqual([source]); expect(state.theme).toBe('dark'); expect(state.original).toBe('dark'); expect(state.language).toBe('en');
});
test('an existing host opens its original connection instead of issuing a second create', async ({ page, request }) => {
  const created = await request.post(api + '/api/v1/connections', { data: { name: '原来的 Codex', host: 'codex', includeInbox: true, topicIds: [], autoActions: [] } });
  expect(created.ok()).toBe(true);
  let creates = 0; page.on('request', request => { if (request.url().endsWith('/api/v1/connections') && request.method() === 'POST') creates++; });
  await page.goto('/#/connections');
  await page.getByRole('button', { name: '创建连接', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('不应新增');
  await dialog.getByLabel('允许访问收集箱', { exact: true }).check({ force: true });
  await dialog.getByRole('button', { name: '创建并配置宿主', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '连接名称', exact: true })).toHaveValue('原来的 Codex');
  expect(creates).toBe(0);
});
