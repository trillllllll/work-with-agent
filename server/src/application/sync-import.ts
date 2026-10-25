import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopDataDir } from './desktop-paths.js';
import { syncWorkspaceIdentity } from './sync-log.js';
import { createHash } from 'node:crypto';
import { prisma } from '../infrastructure/prisma.js';
import { DomainError } from '../domain/task.js';
const historyTables = ['conversations','messages','approvals','agent_runs','agent_run_events','Material','MaterialVersion','Memory','MemoryVersion','Entity','GraphLink','WorkingBrief','Handoff','Run','RunEvent','Artifact','Skill','SkillVersion'];
function stable(value: unknown): string {
 if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
 if (value && typeof value === 'object') { const row=value as Record<string,unknown>; return '{'+Object.keys(row).sort().map(k=>JSON.stringify(k)+':'+stable(row[k])).join(',')+'}'; }
 return JSON.stringify(typeof value === 'bigint' ? Number(value) : value);
}
/** Same canonical inventory as the offline reconciliation tool, excluding credentials. */
export async function localHistoryFingerprint() {
 const rows: Array<[string,string[]]> = [];
 for (const table of historyTables) rows.push([table,(await prisma.$queryRawUnsafe<Array<Record<string,unknown>>>(`SELECT * FROM "${table}"`)).map(stable).sort()]);
 return { fingerprint:createHash('sha256').update(stable(rows)).digest('hex'), count:rows.reduce((n,[,r])=>n+r.length,0) };
}
export async function assertHistoryImported(check: (fingerprint:string)=>Promise<boolean>) {
 const local=await localHistoryFingerprint();
 if(local.count && !await check(local.fingerprint)) throw new DomainError('HISTORY_NOT_IMPORTED','本机聊天和资料尚未迁入共享工作区，请先合并完整备份，原数据已保留',409);
}

/** Written only by the explicit, verified three-source deployment procedure. */
export async function legacyDraftImportAllowed() {
 try {
  const manifest=JSON.parse(await readFile(join(desktopDataDir(),'legacy-draft-import.json'),'utf8')) as {workspaceId?:string;sourceFingerprints?:string[];filesVerified?:boolean};
  if(!manifest.filesVerified || manifest.workspaceId!==(await syncWorkspaceIdentity()).workspaceId || !Array.isArray(manifest.sourceFingerprints) || manifest.sourceFingerprints.length<2)return false;
  const fingerprints=[...new Set(manifest.sourceFingerprints)];
  return (await prisma.syncImport.findMany({where:{fingerprint:{in:fingerprints}},select:{fingerprint:true}})).length>=fingerprints.length;
 } catch {return false;}
}
