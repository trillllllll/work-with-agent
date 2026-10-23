/** Real WebKit profile handoff using disposable profiles only; never opens an installed app. */
import { webkit } from '@playwright/test';
import ts from 'typescript';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '..');
const { migrateProfileTree } = await import(pathToFileURL(resolve(root, 'server/dist/profile-migrate.js')).href);
const code = ts.transpileModule(await readFile(resolve(root, 'client/src/lib/browser-state-migration.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 } }).outputText;
const host = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/migration.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/migration.js' ? code : '<!doctype html><title>Isolated profile migration</title>'); });
await new Promise(done => host.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${host.address().port}`;
const temporary = await mkdtemp(resolve(tmpdir(), 'dovun-webkit-handoff-'));
let context;
try {
  for (const version of ['0.2', '0.3']) {
    const source = resolve(temporary, `old-${version}`), target = resolve(temporary, `new-${version}`);
    context = await webkit.launchPersistentContext(source, { headless: true });
    await context.addCookies([{ name: 'dovun_session', value: 'synthetic-session', url: origin, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    let page = await context.newPage(); await page.goto(origin);
    await page.evaluate(async version => {
      const prefix = version === '0.2' ? 'agent-studio' : 'dovun';
      localStorage.setItem(`${prefix}.theme`, 'dark'); localStorage.setItem(`${prefix}.conversationId`, 'synthetic-conversation'); localStorage.setItem(`${prefix}.pendingRequestKey`, 'synthetic-pending');
      await new Promise((resolve, reject) => {
        const req = indexedDB.open(version === '0.2' ? 'wwa-task-editor' : 'dovun-task-editor', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('drafts', { keyPath: ['scopeKey', 'taskId', 'branchId'] });
        req.onsuccess = () => { const db = req.result, tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put({ scopeKey: JSON.stringify([location.origin, 'synthetic-service', 'synthetic-user']), taskId: 'synthetic-task', branchId: 'synthetic-branch', recordVersion: 3, text: '未保存的隔离草稿' }); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
        req.onerror = () => reject(req.error);
      });
    }, version);
    await context.close(); context = undefined;
    const copied = await migrateProfileTree(source, target);
    context = await webkit.launchPersistentContext(target, { headless: true });
    page = await context.newPage(); await page.goto(origin);
    const cookies = await context.cookies(origin);
    if (!cookies.some(cookie => cookie.name === 'dovun_session' && cookie.value === 'synthetic-session')) throw new Error('WebKit did not restore the copied session cookie.');
    const result = await page.evaluate(async () => {
      const { migrateBrowserDrafts } = await import('/migration.js'); await migrateBrowserDrafts(indexedDB, localStorage);
      const rows = await new Promise((resolve, reject) => { const req = indexedDB.open('dovun-task-editor', 1); req.onsuccess = () => { const db = req.result, tx = db.transaction('drafts'), read = tx.objectStore('drafts').getAll(); tx.oncomplete = () => { db.close(); resolve(read.result); }; tx.onerror = () => reject(tx.error); }; });
      const state = { theme: localStorage.getItem('dovun.theme'), conversation: localStorage.getItem('dovun.conversationId'), rows };
      localStorage.removeItem('dovun.pendingRequestKey'); await migrateBrowserDrafts(indexedDB, localStorage);
      return { ...state, pending: localStorage.getItem('dovun.pendingRequestKey') };
    });
    if (result.theme !== 'dark' || result.conversation !== 'synthetic-conversation' || result.pending !== null || result.rows.length !== 1 || result.rows[0].text !== '未保存的隔离草稿' || result.rows[0].scopeKey !== JSON.stringify([origin, 'synthetic-service', 'synthetic-user'])) throw new Error('Restored browser state differs from the scoped source.');
    await context.close(); context = undefined;
    console.log(JSON.stringify({ engine: 'WebKit', sourceVersion: version, status: 'passed', copiedFiles: copied.files, checks: ['cookie', 'theme', 'conversation', 'scoped IndexedDB draft', 'cleared pending stays absent'] }));
  }
} finally { await context?.close(); await new Promise(done => host.close(done)); await rm(temporary, { recursive: true, force: true }); }
