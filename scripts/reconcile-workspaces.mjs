// Run only against consistent, migrated staging copies. Never modifies a source.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const historyTables = ['conversations','messages','approvals','agent_runs','agent_run_events','Material','MaterialVersion','Memory','MemoryVersion','Entity','GraphLink','WorkingBrief','Handoff','Run','RunEvent','Artifact','Skill','SkillVersion'];
export function stable(value) {
 if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
 if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable(value[k])).join(',') + '}';
 return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(stable(value)).digest('hex');
export const q = name => '"'+name.replaceAll('"','""')+'"';
export function fingerprint(db) {
 const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
 const rows = historyTables.filter(t=>names.has(t)).map(t=>[t,db.prepare('SELECT * FROM '+q(t)).all().map(stable).sort()]);
 return { fingerprint:digest(rows), count:rows.reduce((n,[,r])=>n+r.length,0) };
}
export function reconcile(target, source, label, options = {}) {
 if (realpathSync(target) === realpathSync(source)) throw Error('Source and target must differ');
 const db=new DatabaseSync(target), from=new DatabaseSync(source,{readOnly:true});
 const excluded=new Set(['_prisma_migrations','local_sessions','LocalSession','app_settings','connections','Connection','RequestReceipt','LibraryUpload','AgentNode','ProjectLocation','ProjectBinding','NodeJob','WorktreeCleanup','ReviewRule','ReviewBatch','AutoMemoryScope','AutoMemorySource','AutoMemoryJob','AutoMemoryTurn','MemorySuggestionKey','OrganizationRequest','Orchestration','OrchestrationStep','OrchestrationEvent','HandoffReview','CodeApplication','Proposal']);
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name);
 const sourceTables=new Set(from.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
 const archiveOnly=new Set(['NodeJob','WorktreeCleanup','ReviewBatch','AutoMemoryJob','AutoMemoryTurn','OrganizationRequest','Orchestration','OrchestrationStep','OrchestrationEvent','HandoffReview','CodeApplication','Proposal']);
 const selected=tables.filter(table=>(!excluded.has(table)||archiveOnly.has(table))&&!table.startsWith('sync_')&&table!=='app_data_migrations'&&sourceTables.has(table)).sort();
 const importId=digest([selected.map(t=>[t,from.prepare('SELECT * FROM '+q(t)).all().map(stable).sort()]), options.includeArchives ? ['sync_imports','sync_import_archive'].filter(t=>sourceTables.has(t)).map(t=>[t,from.prepare('SELECT * FROM '+q(t)).all().map(stable).sort()]) : null]);
 let inserted=0, archived=0;const at=new Date().toISOString();const proof=fingerprint(from);
 const added=new Map();
 function archive(table,row,key) {
  const safe={...row}; for(const field of ['decision_token','lease_token','leaseToken','claimTokenHash','claimOwner']) if(field in safe) safe[field]=null;
  const payload=stable(safe),id=digest([importId,table,key,payload]);
  archived+=Number(db.prepare('INSERT OR IGNORE INTO sync_import_archive VALUES (?,?,?,?,?,?)').run(id,label,table,stable(key),payload,at).changes);
 }
 try {
 if(db.prepare('SELECT 1 FROM sync_imports WHERE id=?').get(importId)) return {inserted:0,archived:0,...proof};
 db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
 if(options.includeArchives) for(const table of ['sync_imports','sync_import_archive']) if(sourceTables.has(table)) {
  const cols=db.prepare('PRAGMA table_info('+q(table)+')').all().map(c=>c.name);
  const put=db.prepare('INSERT OR IGNORE INTO '+q(table)+' ('+cols.map(q).join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')');
  for(const row of from.prepare('SELECT * FROM '+q(table)).all()) put.run(...cols.map(c=>row[c]));
 }
 for(const table of tables) {
  if((excluded.has(table)&&!archiveOnly.has(table))||table.startsWith('sync_')||table==='app_data_migrations'||!sourceTables.has(table)) continue;
  const info=db.prepare('PRAGMA table_info('+q(table)+')').all();
  const cols=info.map(c=>c.name), incoming=from.prepare('PRAGMA table_info('+q(table)+')').all().map(c=>c.name);
  if(stable(cols)!==stable(incoming)) throw Error('Schema mismatch: '+table);
  const keys=info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
  if(!keys.length) throw Error('Missing primary key: '+table);
  const find=db.prepare('SELECT * FROM '+q(table)+' WHERE '+keys.map(k=>q(k)+' IS ?').join(' AND '));
  const put=db.prepare('INSERT INTO '+q(table)+' ('+cols.map(q).join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')');
  added.set(table,new Set());
  for(const row of from.prepare('SELECT * FROM '+q(table)).all()) {
   const key=keys.map(k=>row[k]), old=find.get(...key);
   if(old && stable(old)===stable(row)) continue;
   if(archiveOnly.has(table)) {archive(table,row,key);continue;}
   if(!old) {
    // Historical local work must never restart when imported into the cloud.
    const copy={...row};
    if(table==='conversations') copy.active_run_id=null;
    if(table==='approvals') { copy.decision_token=null; copy.decision_expires_at=null; if(copy.status==='pending') copy.status='rejected'; }
    if(table==='agent_runs') { copy.lease_token=null; copy.lease_expires_at=null; }
    if(table==='Run') { copy.claimTokenHash=null; copy.claimOwner=null; }
    if(table==='MaterialExtraction') {copy.leaseToken=null;copy.leaseUntil=null;if(['queued','running'].includes(copy.status)){copy.status='unsupported';copy.errorCode='MIGRATION_PAUSED';}}

    if(table==='agent_runs'&&['queued','running'].includes(copy.state)) copy.state='paused';
    if(table==='Run'&&['created','accepted','running','unknown'].includes(copy.status)) copy.status='interrupted';
    try {const placed=put.run(...cols.map(c=>copy[c]));added.get(table).add(Number(placed.lastInsertRowid));inserted++;continue;} catch(error) {
     if(!String(error).includes('UNIQUE constraint failed')) throw error;
    }
   }
   archive(table,row,key);
  }
 }
 // A unique-name collision can leave newly imported dependents without a parent.
 // Preserve that entire closure in the archive, never delete a pre-existing row.
 for(let pass=0;pass<tables.length;pass++) {
  const bad=db.prepare('PRAGMA foreign_key_check').all();if(!bad.length)break;
  for(const failure of bad) {
   if(!added.get(failure.table)?.has(Number(failure.rowid)))throw Error('Pre-existing relationship invalid: '+stable(failure));
   const row=db.prepare('SELECT * FROM '+q(failure.table)+' WHERE rowid=?').get(failure.rowid);
   archive(failure.table,row,['rowid',Number(failure.rowid)]);
   db.prepare('DELETE FROM '+q(failure.table)+' WHERE rowid=?').run(failure.rowid);added.get(failure.table).delete(Number(failure.rowid));inserted--;
  }
 }
 if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Relationship closure is invalid');
 db.prepare('INSERT OR IGNORE INTO sync_imports VALUES (?,?,?,?)').run(importId,proof.fingerprint,label,at);
 db.exec('COMMIT');return {inserted,archived,...proof};
 } catch(error) {try{db.exec('ROLLBACK');}catch{}throw error;} finally{db.close();from.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const [target,source,label='import']=process.argv.slice(2);
 if(!target||!source) throw Error('Usage: node --experimental-sqlite scripts/reconcile-workspaces.mjs TARGET_COPY SOURCE_COPY LABEL');
 console.log(JSON.stringify(reconcile(target,source,label,{includeArchives:process.argv.includes('--include-import-archives')})));
}
