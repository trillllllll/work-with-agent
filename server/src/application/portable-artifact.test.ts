import {it,expect} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {prisma} from '../infrastructure/prisma.js';
import {ownerActor} from './security.js';import {RunService} from './runs.js';import {storeKnowledgeBlob} from './knowledge-blobs.js';
it('reads migrated file artifacts by verified content hash and retains run access controls',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dovun-artifact-')),previous=process.env.KNOWLEDGE_STORAGE_ROOT;process.env.KNOWLEDGE_STORAGE_ROOT=root;
 const at=new Date().toISOString(),task=await prisma.task.create({data:{title:'Portable artifact fixture'}});let handoffId='',runId='';
 try{
  const handoff=await prisma.handoff.create({data:{taskId:task.id,provider:'codex',instruction:'fixture',inputSnapshot:JSON.stringify({task:{topicId:null}}),inputHash:'fixture',createdAt:at,updatedAt:at}});handoffId=handoff.id;
  const run=await prisma.run.create({data:{handoffId,provider:'codex',mode:'manual',status:'completed',createdAt:at,updatedAt:at}});runId=run.id;
  const bytes=Buffer.from('original migrated result'),hash=await storeKnowledgeBlob(bytes);
  const artifact=await prisma.artifact.create({data:{runId,kind:'output_file',name:'answer.txt',hash,metadata:JSON.stringify({portableBlobHash:hash}),createdAt:at}});
  const service=new RunService();expect(await service.artifactContent(ownerActor,artifact.id)).toMatchObject({content:bytes.toString('base64'),encoding:'base64',hash});
  await expect(service.artifactContent({...ownerActor,id:'limited',kind:'connection',topicIds:[],includeInbox:false},artifact.id)).rejects.toThrow();
  await writeFile(join(root,hash),'changed');await expect(service.artifactContent(ownerActor,artifact.id)).rejects.toMatchObject({code:'ATTACHMENT_CORRUPT'});
 }finally{
  if(runId){await prisma.artifact.deleteMany({where:{runId}});await prisma.run.delete({where:{id:runId}});}if(handoffId)await prisma.handoff.delete({where:{id:handoffId}});await prisma.task.delete({where:{id:task.id}});
  if(previous===undefined)delete process.env.KNOWLEDGE_STORAGE_ROOT;else process.env.KNOWLEDGE_STORAGE_ROOT=previous;await rm(root,{recursive:true,force:true});
 }
});
