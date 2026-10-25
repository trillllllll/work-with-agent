import { describe,it,expect } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheAuthorization,cacheIsDenied,workspaceCachePath } from './workspace-cache-access.js';
import { spawnSync } from 'node:child_process';

describe('cached workspace authorization',()=>{
 it('cannot clear durable revocation with racing or later successful responses, including after restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dovun-cache-access-')),previous=process.env.DOVUN_DATA_DIR;
  process.env.DOVUN_DATA_DIR=root;
  const binding={url:'https://fixture.test',token:'fixture-token',workspaceId:'workspace'};
  try{
   expect(await cacheIsDenied(binding)).toBe(true);
   await cacheAuthorization(binding,false);expect(await cacheIsDenied(binding)).toBe(false);
   await Promise.all([cacheAuthorization(binding,false),cacheAuthorization(binding,true),cacheAuthorization(binding,false)]);
   await cacheAuthorization(binding,false);expect(await cacheIsDenied(binding)).toBe(true);
   const file=await workspaceCachePath(binding,'@denied');
   const restarted=spawnSync(process.execPath,['-e','require("node:fs").accessSync(process.argv[1]);',file]);expect(restarted.status).toBe(0);
   expect(await cacheIsDenied({...binding,workspaceId:'another'})).toBe(true);
  }finally{if(previous===undefined)delete process.env.DOVUN_DATA_DIR;else process.env.DOVUN_DATA_DIR=previous;await rm(root,{recursive:true,force:true});}
 });
});
