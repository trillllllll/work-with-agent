// Verify/copy content-addressed files into a staging workspace; originals are read-only.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile,readdir,realpath } from 'node:fs/promises';
import { resolve,join,relative,isAbsolute } from 'node:path';
const [database,blobDirectory,...roots]=process.argv.slice(2);if(!database||!blobDirectory)throw Error('Usage: DB BLOBS [SOURCE_DATA_ROOT...]');
const db=new DatabaseSync(database),blobs=resolve(blobDirectory);await mkdir(blobs,{recursive:true,mode:0o700});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');const valid=name=>/^[a-f0-9]{64}$/.test(name);
async function save(name,bytes){if(!valid(name)||hash(bytes)!==name)throw Error('Invalid file digest');await writeFile(join(blobs,name),bytes,{mode:0o600,flag:'wx'}).catch(async error=>{if(error.code!=='EEXIST'||hash(await readFile(join(blobs,name)))!==name)throw error;});}
for(const root of roots)for(const name of await readdir(join(root,'knowledge-blobs')).catch(()=>[]))if(valid(name))await save(name,await readFile(join(root,'knowledge-blobs',name)));
let portableArtifacts=0;
for(const row of db.prepare("SELECT * FROM Artifact WHERE content IS NULL AND path IS NOT NULL AND path!=''").all()) {
 let bytes=await readFile(join(blobs,row.hash)).catch(()=>null);
 if(!bytes)for(const root of roots){
  const base=await realpath(root),actual=await realpath(row.path).catch(()=>null);if(!actual)continue;
  const rel=relative(base,actual);if(rel.startsWith('..')||isAbsolute(rel))continue;
  bytes=await readFile(actual);break;
 }
 if(!bytes||hash(bytes)!==row.hash)throw Error('Missing or changed artifact '+row.id);
 await save(row.hash,bytes);
 const metadata=JSON.parse(row.metadata||'{}');metadata.portableBlobHash=row.hash;
 db.prepare('UPDATE Artifact SET path=NULL,metadata=? WHERE id=?').run(JSON.stringify(metadata),row.id);portableArtifacts++;
}
const required=new Set();for(const [table,column] of [['task_images','path'],['MaterialVersion','attachmentPath']])for(const row of db.prepare('SELECT DISTINCT "'+column+'" AS path FROM "'+table+'" WHERE "'+column+'" IS NOT NULL').all())if(row.path)required.add(row.path);
for(const row of db.prepare('SELECT metadata FROM Artifact').all()){const metadata=JSON.parse(row.metadata||'{}');if(metadata.portableBlobHash)required.add(metadata.portableBlobHash);}
for(const name of required)if(!valid(name)||hash(await readFile(join(blobs,name)))!==name)throw Error('Missing or changed referenced file');
console.log(JSON.stringify({referencedFiles:required.size,portableArtifacts,foreignKeys:db.prepare('PRAGMA foreign_key_check').all().length,integrity:db.prepare('PRAGMA integrity_check').get().integrity_check}));db.close();
