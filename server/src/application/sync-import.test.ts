import { describe,it,expect } from 'vitest';
import { mkdtemp,mkdir,rm,writeFile,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { hooksFingerprint } from '../node-agent/git.js';

describe('workspace migration safeguards',()=>{
 it('preserves differing originals, inserts missing rows once and never imports credentials or executes history',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dovun-import-'));
  try{
   const script=join(root,'verify.mjs'), module=pathToFileURL(resolve('../scripts/reconcile-workspaces.mjs')).href;
   await writeFile(script,`import { DatabaseSync } from 'node:sqlite';import {reconcile} from ${JSON.stringify(module)};
   import assert from 'node:assert/strict';
   for(const name of ['cloud','local']){const d=new DatabaseSync(${JSON.stringify(root)}+'/'+name+'.db');d.exec('CREATE TABLE LibraryTag(id TEXT PRIMARY KEY, normalizedName TEXT UNIQUE); CREATE TABLE MaterialTag(id TEXT PRIMARY KEY,tagId TEXT REFERENCES LibraryTag(id)); CREATE TABLE MaterialExtraction(id TEXT PRIMARY KEY,status TEXT,leaseToken TEXT,leaseUntil TEXT,errorCode TEXT); CREATE TABLE NodeJob(id TEXT PRIMARY KEY,status TEXT,leaseToken TEXT); CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT); CREATE TABLE conversations(id TEXT PRIMARY KEY,active_run_id TEXT); CREATE TABLE agent_runs(id TEXT PRIMARY KEY,state TEXT,lease_token TEXT,lease_expires_at TEXT); CREATE TABLE app_settings(id TEXT PRIMARY KEY,secret TEXT); CREATE TABLE sync_imports(id TEXT PRIMARY KEY,fingerprint TEXT,source TEXT,created_at TEXT); CREATE TABLE sync_import_archive(id TEXT PRIMARY KEY,source TEXT,table_name TEXT,entity_key TEXT,payload TEXT,created_at TEXT)');d.prepare('INSERT INTO tasks VALUES(?,?)').run('same',name);d.prepare('INSERT INTO app_settings VALUES(?,?)').run('main',name);d.prepare('INSERT INTO LibraryTag VALUES(?,?)').run(name,'same-tag');if(name==='local'){d.exec("INSERT INTO MaterialTag VALUES('link','local');INSERT INTO MaterialExtraction VALUES('extract','queued','secret','later',null);INSERT INTO NodeJob VALUES('job','leased','secret');INSERT INTO tasks VALUES('new','offline');INSERT INTO conversations VALUES('c','r');INSERT INTO agent_runs VALUES('r','running','secret','later')");}d.close();}
   const a=reconcile(${JSON.stringify(root+'/cloud.db')},${JSON.stringify(root+'/local.db')},'local');const b=reconcile(${JSON.stringify(root+'/cloud.db')},${JSON.stringify(root+'/local.db')},'local');assert.equal(a.archived,4);assert.equal(b.inserted,0);assert.equal(b.archived,0);const d=new DatabaseSync(${JSON.stringify(root+'/cloud.db')});assert.equal(d.prepare('SELECT count(*) AS n FROM MaterialTag').get().n,0);assert.equal(d.prepare('SELECT count(*) AS n FROM NodeJob').get().n,0);assert.equal(d.prepare('SELECT status FROM MaterialExtraction').get().status,'unsupported');assert.equal(d.prepare('SELECT leaseToken FROM MaterialExtraction').get().leaseToken,null);assert.equal(d.prepare("SELECT title FROM tasks WHERE id='same'").get().title,'cloud');assert.equal(d.prepare('SELECT state FROM agent_runs').get().state,'paused');assert.equal(d.prepare('SELECT secret FROM app_settings').get().secret,'cloud');assert.equal(d.prepare('SELECT active_run_id FROM conversations').get().active_run_id,null);assert.equal(d.prepare('SELECT lease_token FROM agent_runs').get().lease_token,null);d.close();const changed=new DatabaseSync(${JSON.stringify(root+'/local.db')});changed.exec("INSERT INTO tasks VALUES('third','same-history-new-task')");changed.close();assert.equal(reconcile(${JSON.stringify(root+'/cloud.db')},${JSON.stringify(root+'/local.db')},'local-again').inserted,1);console.log('passed');`);
   expect(execFileSync(process.execPath,['--experimental-sqlite',script],{encoding:'utf8'})).toContain('passed');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('does not mistake upstream metadata for changed hooks, but detects actual hook changes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dovun-hooks-'));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
  try{
   git('init','-q');const before=await hooksFingerprint(root);
   git('config','branch.example.remote','origin');git('config','branch.example.merge','refs/heads/example');
   expect(await hooksFingerprint(root)).toBe(before);
   await writeFile(join(root,'.git/hooks/pre-commit'),'#!/bin/sh\nexit 1');
   expect(await hooksFingerprint(root)).not.toBe(before);
   await mkdir(join(root,'custom-hooks'));git('config','core.hooksPath',join(root,'custom-hooks'));
   await writeFile(join(root,'custom-hooks/pre-commit'),'first');const custom=await hooksFingerprint(root);
   await writeFile(join(root,'custom-hooks/pre-commit'),'second');expect(await hooksFingerprint(root)).not.toBe(custom);
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
