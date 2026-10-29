import { describe,expect,it } from 'vitest';
import {createChatStorage, type ChatComposerSnapshot} from './chat-storage.js';
class MemoryStorage implements Storage{private rows=new Map<string,string>();get length(){return this.rows.size;}clear(){this.rows.clear();}getItem(key:string){return this.rows.get(key)??null;}key(index:number){return [...this.rows.keys()][index]??null;}removeItem(key:string){this.rows.delete(key);}setItem(key:string,value:string){this.rows.set(key,value);}}
const composer=(input:string):ChatComposerSnapshot=>({schemaVersion:1,conversationId:`conversation-${input}`,input,attachments:[{id:`attachment-${input}`,kind:'draft',title:input,text:`reference-${input}`,unsaved:true}],pinnedContext:null,referencedApproval:null,webSearchEnabled:false,webSearchPending:false,refusedRequest:null});
describe('workspace chat storage',()=>{
  it('keeps rendering possible with unavailable storage but refuses an undurable send snapshot',()=>{
    const storage=new MemoryStorage();storage.getItem=()=>{throw new Error('Storage disabled');};
    const chat=createChatStorage('a',storage);
    expect(chat.get('conversationId')).toBeNull();
    expect(chat.legacyPending()).toBeNull();
    expect(()=>chat.set('pendingRequestBody','original body')).toThrow('Storage disabled');
  });
  it('restores unknown requests only in their original workspace',()=>{
    const storage=new MemoryStorage();const a=createChatStorage('a',storage);a.set('pendingRequestBody','{"message":"a"}');a.set('pendingRequestKey','request-a');
    const b=createChatStorage('b',storage);expect(b.get('pendingRequestKey')).toBeNull();b.set('pendingRequestKey','request-b');
    expect(createChatStorage('a',storage).get('pendingRequestKey')).toBe('request-a');
    expect(createChatStorage('b',storage).get('pendingRequestKey')).toBe('request-b');
  });
  it('does not let a late receipt from the old workspace erase the new snapshot',()=>{
    const storage=new MemoryStorage();const a=createChatStorage('a',storage);a.set('pendingRequestKey','request-a');const b=createChatStorage('b',storage);b.set('pendingRequestKey','request-b');a.remove('pendingRequestKey');a.set('conversationId','old-conversation');
    expect(storage.getItem('dovun.pendingRequestKey')).toBe('request-b');expect(b.get('pendingRequestKey')).toBe('request-b');expect(b.get('conversationId')).toBeNull();expect(storage.getItem('dovun.conversationId')).toBeNull();
  });
  it('quarantines unscoped legacy sends without losing their original text',()=>{
    const storage=new MemoryStorage();storage.setItem('dovun.pendingRequestKey','old');storage.setItem('dovun.pendingRequestBody',JSON.stringify({message:'original',requestKey:'old'}));const a=createChatStorage('a',storage);
    expect(a.get('pendingRequestKey')).toBeNull();expect(a.legacyPending()).toBeNull();expect(a.hasLegacyPending()).toBe(true);expect(storage.getItem('dovun.chat.unscopedPending')).toContain('original');expect(createChatStorage('b',storage).legacyPending()).toBeNull();
  });
  it('restores both identities after a workspace round trip and a new hook instance',()=>{
    const storage=new MemoryStorage();const a=createChatStorage('a',storage);a.writeComposer('work',composer('work-a'));a.writeComposer('study',composer('study-a'));
    const b=createChatStorage('b',storage);expect(b.readComposer('work').snapshot).toBeNull();b.writeComposer('work',composer('work-b'));
    const restoredA=createChatStorage('a',storage);expect(restoredA.readComposer('work').snapshot).toEqual(composer('work-a'));expect(restoredA.readComposer('study').snapshot).toEqual(composer('study-a'));expect(createChatStorage('b',storage).readComposer('work').snapshot).toEqual(composer('work-b'));
  });
  it('keeps an unknown sent snapshot separate from a newer unsent draft and references',()=>{
    const storage=new MemoryStorage();const a=createChatStorage('a',storage);a.set('pendingRequestBody',JSON.stringify({message:'original send',requestKey:'r',attachments:['old']}));a.set('pendingRequestKey','r');a.writeComposer('study',composer('new unsent text'));
    const restored=createChatStorage('a',storage);expect(JSON.parse(restored.get('pendingRequestBody')!).message).toBe('original send');expect(restored.readComposer('study').snapshot).toEqual(composer('new unsent text'));
    restored.remove('pendingRequestBody');restored.remove('pendingRequestKey');expect(restored.readComposer('study').snapshot).toEqual(composer('new unsent text'));
  });
  it('preserves draft text and reports missing reference metadata instead of silently trusting it',()=>{
    const storage=new MemoryStorage();const chat=createChatStorage('a',storage);const value=composer('keep original');value.attachments[0].learningSessionId='partial-reference';chat.writeComposer('study',value);
    const restored=chat.readComposer('study');expect(restored.incomplete).toBe(true);expect(restored.snapshot?.input).toBe('keep original');expect(restored.snapshot?.attachments).toEqual([]);
  });
  it('surfaces storage failure without overwriting the last durable composer',()=>{
    const storage=new MemoryStorage();const chat=createChatStorage('a',storage);chat.writeComposer('work',composer('durable'));const write=storage.setItem.bind(storage);storage.setItem=()=>{throw new Error('full');};expect(()=>chat.writeComposer('work',composer('newer'))).toThrow('full');storage.setItem=write;expect(chat.readComposer('work').snapshot?.input).toBe('durable');
  });
  it('backs up unreadable or partial records before a restored composer can replace them',()=>{
    const storage=new MemoryStorage();const draftKey='dovun.chat:'+JSON.stringify(['a','composer:work']);storage.setItem(draftKey,'{"schemaVersion":');const chat=createChatStorage('a',storage);
    expect(chat.readComposer('work')).toEqual({snapshot:null,incomplete:true,unavailable:false});chat.writeComposer('work',composer('new draft'));
    expect(storage.getItem('dovun.chat:'+JSON.stringify(['a','composer:work:recovery']))).toBe('{"schemaVersion":');expect(chat.readComposer('work').snapshot?.input).toBe('new draft');
  });
  it('does not erase an unreadable record when its recovery backup cannot be saved',()=>{
    const storage=new MemoryStorage();const draftKey='dovun.chat:'+JSON.stringify(['a','composer:work']);storage.setItem(draftKey,'original unparsed data');const chat=createChatStorage('a',storage);chat.readComposer('work');
    storage.setItem=()=>{throw new Error('full');};expect(()=>chat.writeComposer('work',composer('empty fallback'))).toThrow('full');expect(storage.getItem(draftKey)).toBe('original unparsed data');
  });
});
