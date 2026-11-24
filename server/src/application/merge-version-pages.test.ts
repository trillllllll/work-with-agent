import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mergeSnapshotDatabase } from './snapshot-merge.js';

const schema = `
CREATE TABLE Memory (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, title TEXT, content TEXT);
CREATE TABLE MemoryVersion (id TEXT PRIMARY KEY, memoryId TEXT NOT NULL REFERENCES Memory(id), revision INTEGER NOT NULL, title TEXT, content TEXT, reason TEXT, createdAt TEXT);
CREATE TABLE sync_imports (id TEXT PRIMARY KEY, fingerprint TEXT, source TEXT, created_at TEXT);
CREATE TABLE sync_import_archive (id TEXT PRIMARY KEY, source TEXT, table_name TEXT, entity_key TEXT, payload TEXT, created_at TEXT);`;

describe('version pages across merges', () => {
  it('reconcile archives pages ahead of the kept body instead of inserting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dovun-version-reconcile-'));
    try {
      const script = join(root, 'verify.mjs');
      const module = pathToFileURL(resolve('../scripts/reconcile-workspaces.mjs')).href;
      await writeFile(script, `import { DatabaseSync } from 'node:sqlite';import {reconcile} from ${JSON.stringify(module)};
import assert from 'node:assert/strict';
const root=${JSON.stringify(root)};
for(const [name,memories,pages] of [['cloud',[['m1',1,'旧正文']],[['mv-p1','m1',1,'旧正文','rev1']]],['local',[['m1',2,'新正文'],['m2',1,'全新']],[['mv-p1','m1',1,'旧正文','rev1'],['mv-p2','m1',2,'新正文','rev2'],['mv-p3','m2',1,'全新','rev1']]]]){
 const db=new DatabaseSync(root+'/'+name+'.db');
 db.exec(${JSON.stringify(schema)});
 for(const m of memories) db.prepare('INSERT INTO Memory VALUES (?,?,?,?)').run(m[0],m[1],m[2],m[2]);
 for(const page of pages) db.prepare('INSERT INTO MemoryVersion VALUES (?,?,?,?,?,?,?)').run(page[0],page[1],page[2],page[3],page[3],page[4],'t');
 db.close();
}
const a=reconcile(root+'/cloud.db',root+'/local.db','guard-test');
assert.equal(a.inserted,2); // new pair only: m2 body + its page
assert.equal(a.archived,2); // stale body kept, its newer body AND newer page archived
const db=new DatabaseSync(root+'/cloud.db');
assert.equal(db.prepare('SELECT revision FROM Memory WHERE id=?').get('m1').revision,1);
assert.equal(db.prepare('SELECT content FROM Memory WHERE id=?').get('m1').content,'旧正文');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM MemoryVersion WHERE memoryId=?').get('m1').n,1);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM MemoryVersion WHERE memoryId=?').get('m2').n,1);
const archived=db.prepare('SELECT table_name, entity_key FROM sync_import_archive ORDER BY table_name').all().map(r=>r.table_name+':'+r.entity_key);
assert.deepEqual(archived,['Memory:["m1"]','MemoryVersion:["mv-p2"]']);
db.close();
const b=reconcile(root+'/cloud.db',root+'/local.db','guard-test');
assert.equal(b.inserted,0);assert.equal(b.archived,0);
console.log('passed');`);
      expect(execFileSync(process.execPath, ['--experimental-sqlite', script], { encoding: 'utf8' })).toContain('passed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('snapshot merge skips pages ahead of the kept body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dovun-version-snapshot-'));
    try {
      const setup = join(root, 'setup.mjs');
      await writeFile(setup, `import { DatabaseSync } from 'node:sqlite';
const root=${JSON.stringify(root)};
const live=new DatabaseSync(root+'/live.db');live.exec(${JSON.stringify(schema)});
live.prepare('INSERT INTO Memory VALUES (?,?,?,?)').run('m1',1,'旧正文','旧正文');
live.prepare('INSERT INTO MemoryVersion VALUES (?,?,?,?,?,?,?)').run('mv-p1','m1',1,'旧正文','旧正文','rev1','t');
live.close();
const incoming=new DatabaseSync(root+'/incoming.db');incoming.exec(${JSON.stringify(schema)});
incoming.prepare('INSERT INTO Memory VALUES (?,?,?,?)').run('m1',2,'新正文','新正文');
incoming.prepare('INSERT INTO Memory VALUES (?,?,?,?)').run('m2',1,'全新','全新');
incoming.prepare('INSERT INTO MemoryVersion VALUES (?,?,?,?,?,?,?)').run('mv-p1','m1',1,'旧正文','旧正文','rev1','t');
incoming.prepare('INSERT INTO MemoryVersion VALUES (?,?,?,?,?,?,?)').run('mv-p2','m1',2,'新正文','新正文','rev2','t');
incoming.prepare('INSERT INTO MemoryVersion VALUES (?,?,?,?,?,?,?)').run('mv-p3','m2',1,'全新','全新','rev1','t');
incoming.close();`);
      execFileSync(process.execPath, ['--experimental-sqlite', setup], { encoding: 'utf8' });
      const counts = await mergeSnapshotDatabase(join(root, 'live.db'), join(root, 'incoming.db'));
      expect(counts).toEqual({ inserted: 2, skipped: 3 });
      const verify = join(root, 'verify.mjs');
      await writeFile(verify, `import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
const db=new DatabaseSync(${JSON.stringify(join(root, 'live.db'))});
assert.equal(db.prepare('SELECT revision FROM Memory WHERE id=?').get('m1').revision,1);
assert.equal(db.prepare('SELECT content FROM Memory WHERE id=?').get('m1').content,'旧正文');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM MemoryVersion WHERE memoryId=?').get('m1').n,1);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM MemoryVersion WHERE memoryId=?').get('m2').n,1);
db.close();console.log('passed');`);
      expect(execFileSync(process.execPath, ['--experimental-sqlite', verify], { encoding: 'utf8' })).toContain('passed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
