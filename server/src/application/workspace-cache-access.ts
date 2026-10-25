import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopDataDir } from './desktop-paths.js';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const denied=new Set<string>();
export async function workspaceCachePath(binding:{url:string;token:string;workspaceId?:string}, path:string) {
 const root=join(desktopDataDir(),'workspace-cache',hash(`${binding.url}:${binding.workspaceId??''}:${hash(binding.token)}`));
 await mkdir(root,{recursive:true,mode:0o700});return join(root,hash(path)+'.json');
}
/** Authorization and permanent revocation are separate files, so racing success cannot erase denial. */
export async function cacheAuthorization(binding:{url:string;token:string;workspaceId?:string}, revoke:boolean) {
 const file=await workspaceCachePath(binding,revoke?'@denied':'@authorized');
 if(revoke) denied.add(file);
 await writeFile(file,'true',{mode:0o600});
}
export async function cacheIsDenied(binding:{url:string;token:string;workspaceId?:string}) {
 const file=await workspaceCachePath(binding,'@denied');
 if(denied.has(file)) return true;
 try {await readFile(file);denied.add(file);return true;} catch { /* No revocation recorded. */ }
 try {return await readFile(await workspaceCachePath(binding,'@authorized'),'utf8')!=='true';} catch {return true;}
}
