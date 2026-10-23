/** Disposable WebKit test of the same two-origin bridge used by the native app. */
import { webkit } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOriginHandoff } from '../server/dist/profile-origin-migrate.js';
const root = await mkdtemp(join(tmpdir(), 'dovun-origin-test-'));
const serve = async () => { const server = createServer((_req, res) => res.end('<title>Fixture</title>')); await new Promise(done => server.listen(0, '127.0.0.1', done)); return server; };
const stop = server => new Promise(done => server.close(done));
let old = await serve(), current = await serve(), handoff, context;
const oldPort = old.address().port, newPort = current.address().port;
const source = `http://127.0.0.1:${oldPort}`, target = `http://127.0.0.1:${newPort}`;
try {
  context = await webkit.launchPersistentContext(join(root, 'profile'), { headless: true });
  const page = await context.newPage(); await page.goto(source);
  await page.evaluate(async ({ source }) => {
    localStorage.setItem('agent-studio.theme', 'dark'); localStorage.setItem('todo.selectedTopic', 'fixture-list');
    sessionStorage.setItem('todo.quickCapture', 'fixture-session-draft');
    await new Promise((done, fail) => {
      const req = indexedDB.open('wwa-task-editor', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('drafts', { keyPath: ['scopeKey', 'taskId', 'branchId'] });
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction('drafts', 'readwrite');
        for (const [api, actor] of [[source, 'owner'], ['https://foreign.example', 'different-user']]) tx.objectStore('drafts').put({ scopeKey: JSON.stringify([source, api, actor]), taskId: 'task', branchId: 'main', recordVersion: 7, draft: { title: '中文未保存草稿', description: 'original' }, outbox: { requestId: 'stable', bodyJson: 'unchanged' } });
        tx.oncomplete = () => { db.close(); done(); }; tx.onerror = () => fail(tx.error);
      };
    });
  }, { source });
  // A preexisting newer target preference/draft must survive.
  await page.goto(target);
  await page.evaluate(async target => {
    localStorage.setItem('dovun.theme', 'light');
    await new Promise((done, fail) => {
      const req = indexedDB.open('dovun-task-editor', 1);
      req.onupgradeneeded = () => { const s = req.result.createObjectStore('drafts', { keyPath: ['scopeKey', 'taskId', 'branchId'] }); s.createIndex('byScope', 'scopeKey'); s.createIndex('byScopeTask', ['scopeKey', 'taskId']); };
      req.onsuccess = () => { const db = req.result, tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put({ scopeKey: JSON.stringify([target, target, 'owner']), taskId: 'task', branchId: 'main', recordVersion: 8, draft: { title: 'newer work' } }); tx.oncomplete = () => { db.close(); done(); }; tx.onerror = () => fail(tx.error); };
    });
  }, target);
  await stop(old); old = null; await stop(current); current = null;
  handoff = await startOriginHandoff(root, oldPort, newPort, 30_000);
  const denied = await fetch(handoff.url + 'export', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: '{}' });
  if (denied.status !== 403) throw Error('Cross-origin export accepted');
  await page.goto(handoff.url); await handoff.done;
  const result = await page.evaluate(async () => {
    const rows = await new Promise((done, fail) => { const req = indexedDB.open('dovun-task-editor'); req.onsuccess = () => { const db = req.result, tx = db.transaction('drafts'), all = tx.objectStore('drafts').getAll(); tx.oncomplete = () => { db.close(); done(all.result); }; tx.onerror = () => fail(tx.error); }; });
    return { theme: localStorage.getItem('dovun.theme'), topic: localStorage.getItem('dovun.selectedTopic'), session: sessionStorage.getItem('dovun.quickCapture'), rows };
  });
  if (result.theme !== 'light' || result.topic !== 'fixture-list' || result.rows.length !== 3) throw Error('Preferences or draft count differ');
  if (result.session !== 'fixture-session-draft') throw Error('Main browsing context lost the exported session state');
  const restored = result.rows.find(row => row.branchId.startsWith('import-'));
  if (!restored || restored.scopeKey !== JSON.stringify([target, target, 'owner']) || restored.recordVersion !== 7 || restored.outbox.requestId !== 'stable') throw Error('Local draft envelope differs');
  if (!result.rows.some(row => row.scopeKey === JSON.stringify([source, 'https://foreign.example', 'different-user']))) throw Error('Foreign user/service scope was changed');
  if (!result.rows.some(row => row.draft.title === 'newer work')) throw Error('Newer draft overwritten');
  if (await startOriginHandoff(root, oldPort, newPort) !== null) throw Error('Completed migration was repeated');
  const receipt = JSON.parse(await readFile(join(root, '.dovun-origin-migration.json'), 'utf8'));
  console.log(JSON.stringify({ engine: 'WebKit', status: 'passed', drafts: receipt.drafts, checks: ['local scope remapped', 'foreign user/service retained', 'outbox retained', 'newer state retained', 'session retained in main context', 'idempotent', 'foreign origin rejected'] }));
} finally { await context?.close(); await handoff?.close(); if (old) await stop(old); if (current) await stop(current); await rm(root, { recursive: true, force: true }); }
