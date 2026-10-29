import { chatAttachment, chatContextV2, chatContextV3, type ChatAttachment, type ChatContextV2, type ChatContextV3 } from '../../../server/src/domain/chat-context.js';

export type ChatComposerSnapshot={schemaVersion:1;conversationId:string;input:string;attachments:ChatAttachment[];pinnedContext:ChatContextV3|null;referencedApproval:{id:string;title:string}|null;webSearchEnabled:boolean;webSearchPending:boolean;refusedRequest:{message:string;context:ChatContextV2|ChatContextV3;reference:{id:string;title:string}|null}|null};
export type ComposerRestore={snapshot:ChatComposerSnapshot|null;incomplete:boolean;unavailable:boolean};
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const reference=(value:unknown)=>object(value)&&typeof value.id==='string'&&typeof value.title==='string'?{id:value.id,title:value.title}:null;
function restoredContext(value:unknown){if(!object(value))return null;const {timeZoneSource:_source,language:_language,...plain}=value;const parsed=(plain.schemaVersion===3?chatContextV3:chatContextV2).safeParse(plain);return parsed.success?parsed.data:null;}
export function validateChatComposer(value:unknown):ComposerRestore{
  if(!object(value)||value.schemaVersion!==1||typeof value.input!=='string')return {snapshot:null,incomplete:true,unavailable:false};
  let incomplete=false;const attachments:ChatAttachment[]=[];
  for(const item of Array.isArray(value.attachments)?value.attachments:[]){const parsed=chatAttachment.safeParse(item);if(parsed.success&&attachments.length<20&&attachments.reduce((sum,a)=>sum+[...a.text].length,0)+[...parsed.data.text].length<=40000)attachments.push(parsed.data);else incomplete=true;}
  if(!Array.isArray(value.attachments))incomplete=true;
  const pinned=restoredContext(value.pinnedContext);if(value.pinnedContext&&pinned?.schemaVersion!==3)incomplete=true;
  let refused:ChatComposerSnapshot['refusedRequest']=null;
  if(object(value.refusedRequest)){const context=restoredContext(value.refusedRequest.context);if(typeof value.refusedRequest.message==='string'&&context)refused={message:value.refusedRequest.message,context,reference:reference(value.refusedRequest.reference)};else incomplete=true;}
  return {snapshot:{schemaVersion:1,conversationId:typeof value.conversationId==='string'?value.conversationId:'',input:value.input,attachments,pinnedContext:pinned?.schemaVersion===3?pinned:null,referencedApproval:reference(value.referencedApproval),webSearchEnabled:value.webSearchEnabled===true,webSearchPending:value.webSearchPending===true,refusedRequest:refused},incomplete,unavailable:false};
}

/** Scope-owned chat state. Legacy keys are a compatibility mirror, never the
 * authority after a workspace changes. Late results update only their own scope. */
export type ChatStorageField = 'conversationId' | 'pendingRequestKey' | 'pendingRequestBody' | 'assistantIdentity';
const fields: ChatStorageField[] = ['conversationId','pendingRequestKey','pendingRequestBody','assistantIdentity'];
const marker = 'dovun.chatScope';
const legacyPendingKey = 'dovun.chat.unscopedPending';
const key = (scope:string,field:string)=>`dovun.chat:${JSON.stringify([scope,field])}`;
export function createChatStorage(scope:string|undefined,storage:Storage=localStorage){
  const unreadableComposers=new Map<'work'|'study',string>();
  try { if(scope){
    const previous=storage.getItem(marker);
    if(!previous){
      // An older app did not identify the workspace of unknown sends. Preserve
      // these separately; automatically replaying them into the current scope is unsafe.
      const body=storage.getItem('dovun.pendingRequestBody');
      const requestId=storage.getItem('dovun.pendingRequestKey');
      if(body||requestId){if(!storage.getItem(legacyPendingKey))storage.setItem(legacyPendingKey,JSON.stringify({body,requestId}));}
      for(const field of ['conversationId','assistantIdentity'] as const){const value=storage.getItem(`dovun.${field}`);if(value!==null&&storage.getItem(key(scope,field))===null)storage.setItem(key(scope,field),value);}
    }
    if(previous!==scope){
      storage.setItem(marker,scope);
      for(const field of fields){const value=storage.getItem(key(scope,field));if(value===null)storage.removeItem(`dovun.${field}`);else storage.setItem(`dovun.${field}`,value);}
    }
  } } catch { /* Storage can be disabled or full. Rendering remains available;
    * writes still throw so a send can never start without a recovery snapshot. */ }
  return {
    get(field:ChatStorageField){try{return scope?storage.getItem(key(scope,field)):null;}catch{return null;}},
    set(field:ChatStorageField,value:string){
      if(!scope)throw new Error('Authenticated chat scope unavailable');
      // Preserve compatibility with browser storage failure handling before any send.
      if(storage.getItem(marker)===scope)storage.setItem(`dovun.${field}`,value);
      storage.setItem(key(scope,field),value);
    },
    remove(field:ChatStorageField){if(!scope)return;storage.removeItem(key(scope,field));if(storage.getItem(marker)===scope)storage.removeItem(`dovun.${field}`);},
    readComposer(identity:'work'|'study'):ComposerRestore{
      if(!scope)return {snapshot:null,incomplete:false,unavailable:true};
      let raw:string|null;try{raw=storage.getItem(key(scope,`composer:${identity}`));}catch{return {snapshot:null,incomplete:false,unavailable:true};}
      if(!raw)return {snapshot:null,incomplete:false,unavailable:false};
      let restored:ComposerRestore;try{restored=validateChatComposer(JSON.parse(raw));}catch{restored={snapshot:null,incomplete:true,unavailable:false};}
      // Preserve the exact original if its schema/references cannot be recovered.
      // A failed backup must block the subsequent write, not replace it with an
      // empty or partially restored draft on the first render.
      if(restored.incomplete)unreadableComposers.set(identity,raw);
      return restored;
    },
    writeComposer(identity:'work'|'study',value:ChatComposerSnapshot){
      if(!scope)throw new Error('Authenticated chat scope unavailable');
      const original=unreadableComposers.get(identity);
      if(original!==undefined){storage.setItem(key(scope,`composer:${identity}:recovery`),original);unreadableComposers.delete(identity);}
      storage.setItem(key(scope,`composer:${identity}`),JSON.stringify(value));
    },
    hasLegacyPending(){try{return storage.getItem(legacyPendingKey)!==null;}catch{return false;}},
    // Unknown legacy ownership is never assigned to the first workspace opened.
    legacyPending():string|null{return null;},
  };
}
