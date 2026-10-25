import {it,expect} from 'vitest';import {IDBFactory} from 'fake-indexeddb';
import {TaskDraftStore} from './task-draft-store.js';import type {TaskTextDraftV1} from './task-editor-types.js';
it('copies confirmed legacy drafts once without replaying old writes or replacing newer scoped drafts',async()=>{
 const store=new TaskDraftStore(new IDBFactory()),text={title:'unsaved original',description:'draft'};
 const row:TaskTextDraftV1={schemaVersion:1,scopeKey:'legacy',taskId:'task',branchId:'branch',recordVersion:1,editSeq:1,base:{...text,revision:1},draft:text,outbox:null,conflicts:{},blockedReason:null,retryCount:0,nextRetryAt:null,updatedAt:1};
 await store.put(row);await store.importLegacyScope('legacy','workspace');
 expect((await store.load('workspace','task'))[0]).toMatchObject({draft:text,outbox:null,blockedReason:'server-reset'});
 expect(await store.load('legacy','task')).toHaveLength(1);
 await store.importLegacyScope('legacy','another-workspace');expect(await store.load('another-workspace','task')).toHaveLength(0);
 await store.put({...row,scopeKey:'workspace',recordVersion:2,draft:{...text,title:'newer'}});await store.importLegacyScope('legacy','workspace');
 expect((await store.load('workspace','task'))[0].draft.title).toBe('newer');
 await store.deleteBranch('workspace','task','branch');await store.importLegacyScope('legacy','workspace');expect(await store.load('workspace','task')).toHaveLength(0);
});
