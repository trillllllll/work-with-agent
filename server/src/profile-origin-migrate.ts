/** One-time WebView handoff between the two loopback origins. No browser-engine files are edited. */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Snapshot = { version: 1; sourceOrigin: string; preferences: Record<string, string>; session: Record<string, string>; drafts: any[] };
export const originReceipt = '.dovun-origin-migration.json';

// These functions are serialized and run inside the native WebView, not Node.
export async function exportBrowserState(): Promise<Snapshot> {
  const collect = (storage: Storage) => Object.fromEntries(Object.keys(storage).filter(key => /^(agent-studio\.|todo\.|wwa[.-]|dovun[.-]|i18nextLng$)/.test(key)).map(key => [key, storage.getItem(key)!]));
  const drafts: any[] = [];
  for (const name of ['wwa-task-editor', 'dovun-task-editor']) {
    const rows = await new Promise<any[]>((done, fail) => {
      const request = indexedDB.open(name); let absent = false;
      request.onupgradeneeded = () => { absent = true; request.transaction!.abort(); };
      request.onerror = () => absent ? done([]) : fail(request.error);
      request.onblocked = () => fail(new Error('Close other browser windows before migrating drafts.'));
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('drafts')) { db.close(); fail(new Error('Unrecognized draft store')); return; }
        const tx = db.transaction('drafts'), read = tx.objectStore('drafts').getAll();
        tx.oncomplete = () => { db.close(); done(read.result); };
        tx.onerror = tx.onabort = () => { db.close(); fail(tx.error); };
      };
    });
    drafts.push(...rows);
  }
  return { version: 1, sourceOrigin: location.origin, preferences: collect(localStorage), session: collect(sessionStorage), drafts };
}

export async function importBrowserState(snapshot: Snapshot, id: string) {
  const marker = 'dovun.origin-migration.' + id;
  if (localStorage.getItem(marker)) return;
  const rename = (key: string) => key.replace(/^agent-studio\./, 'dovun.').replace(/^todo\./, 'dovun.').replace(/^wwa([.-])/, 'dovun$1');
  const db = await new Promise<IDBDatabase>((done, fail) => {
    const request = indexedDB.open('dovun-task-editor', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('drafts', { keyPath: ['scopeKey', 'taskId', 'branchId'] });
      store.createIndex('byScopeTask', ['scopeKey', 'taskId']); store.createIndex('byScope', 'scopeKey');
    };
    request.onsuccess = () => done(request.result); request.onerror = () => fail(request.error);
    request.onblocked = () => fail(new Error('Close other Dovun windows before importing drafts.'));
  });
  try {
    const records = await Promise.all(snapshot.drafts.map(async row => {
      const record = structuredClone(row);
      const scope = JSON.parse(record.scopeKey);
      if (!Array.isArray(scope) || scope.length !== 3 || !scope.every(value => typeof value === 'string')) throw new Error('Invalid draft scope');
      // Only the original local service moves. A draft belonging to another service/user stays scoped there.
      if (scope[0] === snapshot.sourceOrigin && scope[1] === snapshot.sourceOrigin) {
        record.scopeKey = JSON.stringify([location.origin, location.origin, scope[2]]);
      }
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(record)));
      const recovery = 'import-' + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
      return { record, recovery };
    }));
    await new Promise<void>((done, fail) => {
      const tx = db.transaction('drafts', 'readwrite'), store = tx.objectStore('drafts');
      for (const { record, recovery } of records) {
        const read = store.get([record.scopeKey, record.taskId, record.branchId]);
        read.onsuccess = () => {
          if (!read.result) store.add(record);
          else if (JSON.stringify(read.result) !== JSON.stringify(record)) {
            const key = [record.scopeKey, record.taskId, recovery], existing = store.get(key);
            existing.onsuccess = () => { if (!existing.result) store.add({ ...record, branchId: recovery }); };
          }
        };
      }
      tx.oncomplete = () => done(); tx.onerror = tx.onabort = () => fail(tx.error);
    });
    for (const [storage, values] of [[localStorage, snapshot.preferences], [sessionStorage, snapshot.session]] as const) {
      for (const [key, value] of Object.entries(values)) {
        const next = rename(key);
        if (storage.getItem(next) === null) storage.setItem(next, value);
      }
    }
    localStorage.setItem(marker, 'done');
  } finally { db.close(); }
}

export async function startOriginHandoff(data: string, oldPort = 47316, newPort = 47317, timeoutMs = 120_000) {
  const receipt = join(data, originReceipt);
  try {
    const saved = JSON.parse(await readFile(receipt, 'utf8'));
    if (saved.version !== 1 || saved.sourceOrigin !== `http://127.0.0.1:${oldPort}` || saved.targetOrigin !== `http://127.0.0.1:${newPort}`) throw new Error('Invalid browser migration receipt.');
    return null;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const token = randomUUID(), id = randomUUID(), sourceOrigin = `http://127.0.0.1:${oldPort}`, targetOrigin = `http://127.0.0.1:${newPort}`;
  let snapshot: Snapshot | undefined;
  const servers: Server[] = [];
  let settle!: (error?: Error) => void;
  const done = new Promise<void>((resolveDone, reject) => { settle = error => error ? reject(error) : resolveDone(); });
  // Install a rejection handler immediately; native window creation can take time.
  void done.catch(() => {});
  const timer = setTimeout(() => settle(new Error('Browser state migration timed out; original state is retained.')), timeoutMs);
  const close = async () => { clearTimeout(timer); await Promise.all(servers.map(server => new Promise<void>(resolveClose => { server.close(() => resolveClose()); server.closeAllConnections(); }))); };
  try {
    for (const [origin, port, importing] of [[sourceOrigin, oldPort, false], [targetOrigin, newPort, true]] as const) {
      const server = createServer(async (req, res) => {
        try {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${token}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
          if (req.headers.host !== `127.0.0.1:${port}` || !req.url?.startsWith(`/${token}/`)) { res.writeHead(404).end(); return; }
          if (req.method === 'POST') {
            if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') { res.writeHead(403).end(); return; }
            let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 64 * 1024 * 1024) throw new Error('Browser recovery data is too large'); }
            const body = JSON.parse(raw);
            if (req.url === `/${token}/error`) { res.writeHead(500).end(); settle(new Error('Browser state could not be migrated. The original profile and backup are retained.')); return; }
            if (!importing && req.url === `/${token}/export`) {
              if (body.version !== 1 || body.sourceOrigin !== sourceOrigin || !Array.isArray(body.drafts) || !body.preferences || !body.session) throw new Error('Invalid browser state');
              snapshot = body;
              await writeFile(join(data, '.dovun-origin-export.json'), JSON.stringify(snapshot), { mode: 0o600 });
              res.end('{}'); return;
            }
            if (importing && req.url === `/${token}/complete` && snapshot) {
              await writeFile(receipt, JSON.stringify({ version: 1, id, sourceOrigin, targetOrigin, preferences: Object.keys(snapshot.preferences).length, drafts: snapshot.drafts.length, completedAt: new Date().toISOString() }), { mode: 0o600 });
              res.end('{}'); settle(); return;
            }
            res.writeHead(404).end(); return;
          }
          if (req.method !== 'GET' || req.url !== `/${token}/`) { res.writeHead(404).end(); return; }
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          const encode = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
          if (importing && !snapshot) { res.writeHead(409).end(); return; }
          const post = `async function post(path, data) { const response = await fetch('/${token}/' + path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) }); if (!response.ok) throw Error('Migration request failed'); }`;
          const script = importing
            ? `${post}; await (${importBrowserState.toString()})(${encode(snapshot)}, ${encode(id)}); await post('complete', {});`
            : `${post}; const snapshot = await (${exportBrowserState.toString()})(); await post('export', snapshot); location.replace(${encode(targetOrigin + '/' + token + '/')});`;
          res.end(`<!doctype html><title>Dovun browser migration</title><script nonce="${token}">(async()=>{try{${script}}catch{await fetch('/${token}/error',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}})();</script>`);
        } catch { res.writeHead(500).end(); settle(new Error('Browser state migration failed; original state is retained.')); }
      });
      servers.push(server);
      await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', ready); });
    }
  } catch (error) { await close(); throw error; }
  return { url: `${sourceOrigin}/${token}/`, done: done.finally(close), close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = process.argv[2]; if (!data) throw new Error('Missing Dovun data directory');
  const handoff = await startOriginHandoff(data);
  if (handoff) { console.log(handoff.url); await handoff.done; }
}
