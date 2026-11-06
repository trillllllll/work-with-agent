import { t } from '@/i18n/index.js';
import DOMPurify from 'dompurify';
import { htmlFragments } from '../../../server/src/shared/streaming-markup.js';

export function cleanHtmlFragments(source: string, final: boolean) {
  let snapshot: ReturnType<typeof htmlFragments>;
  try { snapshot = htmlFragments(source, final); } catch { throw new Error(t('chat:html.fragmentUnsupported')); }
  return { parts: snapshot.parts.map(part => DOMPurify.sanitize(part, {
    FORCE_BODY: true, ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'meta', 'base', 'link', 'template'],
    FORBID_ATTR: ['autofocus', 'srcdoc', 'formaction'],
  })), script: snapshot.script };
}

/** Trusted append-only transport. The root and token live in a closure, outside model markup. */
export function fragmentDocument(nonce: string) {
  return `<body><script>(function(){
var el=document.currentScript,P=parent,token=${JSON.stringify(nonce)},applied=[],finished=false;
var root=document.createElement('main');document.body.appendChild(root);
window.addEventListener('message',function(e){
var d=e.data;if(e.source!==P||!d||d.type!=='wwa:fragments'||d.nonce!==token)return;
if(!Array.isArray(d.parts)||d.parts.length<applied.length||d.parts.some(function(p){return typeof p!=='string'}))return;
if(applied.some(function(p,i){return d.parts[i]!==p}))return;
if(!finished){
for(var i=applied.length;i<d.parts.length;i++){root.insertAdjacentHTML('beforeend',d.parts[i]);}applied=d.parts.slice();
if(d.done===true){finished=true;if(typeof d.script==='string'){var s=document.createElement('script');s.textContent=d.script;document.body.appendChild(s);s.remove();}}
}
P.postMessage({type:'wwa:paint',nonce:token,count:applied.length,done:finished},'*');
});if(el)el.remove();})();</script></body>`;
}
