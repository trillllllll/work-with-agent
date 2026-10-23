/** Historical HTML block attributes and CSS aliases remain a saved-content contract. */
import { t } from '../i18n/index.js';

/** Pure helpers for html reply blocks: srcdoc assembly, CSP and bridge message checks. */
export const FILL_TEXT_LIMIT = 2000;
export const HEIGHT_MIN = 120;
export const HEIGHT_MAX = 1200;
export const DEFAULT_HEIGHT = 320;
export const FILL_THROTTLE_MS = 500;

const origin = /^(https:\/\/[a-z0-9.-]+(?::\d{1,5})?|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?)$/;
/** Only plain origins reach the policy text, so a stored value can never inject another directive. */
export function safeCdn(cdn: readonly string[]) { return cdn.filter((item) => origin.test(item)); }

export function buildCsp(cdn: readonly string[]) {
  const hosts = safeCdn(cdn).join(' ');
  const withHosts = (base: string) => hosts ? `${base} ${hosts}` : base;
  return [
    "default-src 'none'",
    withHosts("script-src 'unsafe-inline'"),
    withHosts("style-src 'unsafe-inline'"),
    'img-src data: blob:',
    withHosts('font-src data:'),
    "connect-src 'none'",
    'media-src data: blob:',
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "webrtc 'block'",
  ].join('; ');
}

export type SandboxTheme = 'light' | 'dark';
export function themeCss(theme: SandboxTheme) {
  const vars = theme === 'dark'
    ? { bg: '#1f1f1f', fg: '#e5e5e5', muted: '#a3a3a3', border: '#3a3a3a', accent: '#8fb3c4' }
    : { bg: '#ffffff', fg: '#262626', muted: '#737373', border: '#e5e5e5', accent: '#416e85' };
  return `:root{color-scheme:${theme};--wwa-bg:${vars.bg};--wwa-fg:${vars.fg};--wwa-muted:${vars.muted};--wwa-border:${vars.border};--wwa-accent:${vars.accent}}html,body{margin:0;background:var(--wwa-bg);color:var(--wwa-fg);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}`;
}

/** A JS string literal that cannot close the surrounding classic script (`<`, U+2028, U+2029). */
function embedScriptString(value: string) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Classic (not module) bridge. Captures `window.parent` before model script can replace it,
 * announces ready on the child document's own load, and drops the nonce-bearing script element
 * before that model script runs.
 */
export function bridgeScript(nonce: string) {
  const literal = embedScriptString(nonce);
  return `(function(){
var el=document.currentScript;
var P=window.parent;
try{
var NONCE=${literal};
var send=function(m){m.nonce=NONCE;try{P.postMessage(m,'*')}catch(e){}};
try{delete window.RTCPeerConnection;delete window.webkitRTCPeerConnection;delete window.RTCDataChannel}catch(e){}
var listeners=[];
var api={fillInput:function(text){if(typeof text!=='string')return false;send({type:'wwa:fill-input',text:text});return true},
theme:document.documentElement.getAttribute('data-wwa-theme')||'light',
onThemeChange:function(fn){if(typeof fn==='function')listeners.push(fn)}};
Object.defineProperty(window,'wwa',{value:Object.freeze(api),writable:false,configurable:false});
window.addEventListener('message',function(e){if(e.source!==P)return;var d=e.data;if(d&&d.type==='wwa:ping'&&typeof d.id==='number'){send({type:'wwa:alive',id:d.id});return;}if(!d||d.type!=='wwa:theme'||(d.theme!=='light'&&d.theme!=='dark'))return;
document.documentElement.setAttribute('data-wwa-theme',d.theme);var s=document.getElementById('wwa-theme');if(s&&typeof d.css==='string')s.textContent=d.css;
listeners.forEach(function(fn){try{fn(d.theme)}catch(err){}})});
var last=0,queued=false;var report=function(){queued=false;var h=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0));if(h&&h!==last){last=h;send({type:'wwa:resize',height:h})}};
var schedule=function(){if(!queued){queued=true;requestAnimationFrame(report)}};
if(typeof ResizeObserver==='function'){var ro=new ResizeObserver(schedule);ro.observe(document.documentElement);document.addEventListener('DOMContentLoaded',function(){if(document.body)ro.observe(document.body)})}
window.addEventListener('load',schedule);
window.addEventListener('load',function(){send({type:'wwa:ready'})},true);
var onSameDocumentLink=function(e){
var node=e.target,a=null;
while(node&&node!==document){if(node.nodeType===1&&node.localName==='a'&&node.getAttribute('href')!==null){a=node;break;}node=node.parentNode;}
if(!a)return;
var href=a.getAttribute('href'),url,base;
try{url=new URL(href,document.baseURI);base=new URL(document.baseURI);}catch(err){return;}
if(url.origin!==base.origin||url.pathname!==base.pathname||url.search!==base.search)return;
e.preventDefault();
if(e.type!=='click'||url.hash.length<2)return;
var id;try{id=decodeURIComponent(url.hash.slice(1));}catch(err){return;}
var target=document.getElementById(id);
if(!target){var named=document.getElementsByName(id);target=named&&named[0];}
if(target&&target.scrollIntoView)target.scrollIntoView();
};
document.addEventListener('click',onSameDocumentLink,true);
document.addEventListener('auxclick',onSameDocumentLink,true);
}finally{if(el&&el.parentNode)el.parentNode.removeChild(el);}
})();`;
}

/**
 * Our head comes first in the token stream, so the CSP meta is in force before any model markup.
 * A model-supplied <html>/<head> later in the stream is merged or ignored by the HTML parser,
 * and any extra CSP it adds can only narrow the policy (all policies apply).
 * `nonce` is required whenever the bridge is on. `bridge: false` (HTML export) omits the bridge and the nonce.
 */
export function buildSrcdoc(source: string, options: { cdn: readonly string[]; theme: SandboxTheme; bridge?: boolean; nonce?: string }) {
  const csp = buildCsp(options.cdn).replace(/"/g, '&quot;');
  const bridge = options.bridge !== false;
  if (bridge && typeof options.nonce !== 'string') throw new Error('nonce is required when the bridge is enabled');
  const script = bridge ? `<script>${bridgeScript(options.nonce as string)}</script>` : '';
  return `<!doctype html><html data-wwa-theme="${options.theme}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="wwa-theme">${themeCss(options.theme)}</style>${script}</head>${source}`;
}

export type BridgeMessage =
  | { type: 'ready'; nonce: string }
  | { type: 'alive'; id: number; nonce: string }
  | { type: 'resize'; height: number; nonce: string }
  | { type: 'fill'; text: string; nonce: string }
  | { type: 'invalid'; reason: string; nonce: string };
/** Validates the shape of a message whose source has already been matched to the iframe. Every accepted message carries its nonce. */
export function readBridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype) return null;
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  const nonce = record.nonce;
  if (record.type === 'wwa:ready') {
    if (keys !== 'nonce,type' || typeof nonce !== 'string') return null;
    return { type: 'ready', nonce };
  }
  if (record.type === 'wwa:alive') {
    if (keys !== 'id,nonce,type' || typeof nonce !== 'string' || typeof record.id !== 'number' || !Number.isInteger(record.id)) return null;
    return { type: 'alive', id: record.id, nonce };
  }
  if (record.type === 'wwa:resize') {
    if (keys !== 'height,nonce,type' || typeof nonce !== 'string' || typeof record.height !== 'number' || !Number.isFinite(record.height)) return null;
    return { type: 'resize', height: record.height, nonce };
  }
  if (record.type === 'wwa:fill-input') {
    if (keys !== 'nonce,text,type' || typeof nonce !== 'string' || typeof record.text !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const text = record.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/\r\n?/g, '\n').trim();
    if (!text) return { type: 'invalid', reason: t('chat:html.fillEmpty'), nonce };
    if ([...text].length > FILL_TEXT_LIMIT) return { type: 'invalid', reason: t('chat:html.fillTooLong', { limit: FILL_TEXT_LIMIT }), nonce };
    return { type: 'fill', text, nonce };
  }
  return null;
}

export function clampHeight(height: number, max = HEIGHT_MAX) { return Math.min(max, Math.max(HEIGHT_MIN, Math.ceil(height))); }

/** Per-mount token embedded only in the bridge script. `randomUUID` when the platform has it, otherwise 16 random bytes as hex. */
export function createNonce() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * `load` returns the load's id and whether it is still unconfirmed. `alive(id)` confirms that load when the
 * frame's current document answered a ping for it: WebKit fires a load for a same-document fragment change
 * (`location.hash = ...`) without a new document, so no second ready ever comes.
 */
export type NavigationGuard = { load: () => { id: number; pending: boolean }; ready: () => void; alive: (id: number) => void; dispose: () => void };
/**
 * Pairs iframe load events with bridge ready messages.
 * One ready cannot cover a later load. A ready that arrives before its load still counts.
 * While a load is unconfirmed, `onHide` runs at `hideMs` and `onBlock` at `graceMs`.
 */
export function createNavigationGuard<Timer>(options: {
  graceMs?: number;
  hideMs?: number;
  setTimer: (callback: () => void, delayMs: number) => Timer;
  clearTimer: (handle: Timer) => void;
  onHide: () => void;
  onShow: () => void;
  onBlock: () => void;
}): NavigationGuard {
  const graceMs = options.graceMs ?? 1000;
  const hideMs = options.hideMs ?? 500;
  let loads = 0;
  // Ready messages are counted on their own; a ping answer only marks the load it answered. Keeping them apart
  // stops a reload (which sends both) from banking a spare confirmation for a later navigation.
  let readies = 0;
  let aliveThrough = 0;
  let hidden = false;
  let hideHandle: Timer | undefined;
  let blockHandle: Timer | undefined;
  const confirmed = () => readies >= loads || aliveThrough >= loads;
  const clearTimers = () => {
    if (hideHandle !== undefined) options.clearTimer(hideHandle);
    if (blockHandle !== undefined) options.clearTimer(blockHandle);
    hideHandle = undefined;
    blockHandle = undefined;
  };
  const settle = () => {
    if (!confirmed()) return;
    clearTimers();
    if (!hidden) return;
    hidden = false;
    options.onShow();
  };
  return {
    load() {
      loads += 1;
      if (confirmed()) return { id: loads, pending: false };
      clearTimers();
      hideHandle = options.setTimer(() => {
        hideHandle = undefined;
        if (confirmed()) return;
        hidden = true;
        options.onHide();
      }, hideMs);
      blockHandle = options.setTimer(() => {
        blockHandle = undefined;
        if (confirmed()) return;
        options.onBlock();
      }, graceMs);
      return { id: loads, pending: true };
    },
    ready() {
      readies += 1;
      settle();
    },
    alive(id) {
      // Only an answer for the latest load counts, so a late answer cannot cover a later navigation.
      if (id !== loads) return;
      aliveThrough = id;
      settle();
    },
    dispose() { clearTimers(); },
  };
}

/** Empty → fill; unchanged since this block's last fill → replace (a changed choice); otherwise append on a new line. */
export function mergeFill(current: string, text: string, lastFilled: string | null) {
  if (!current.trim()) return text;
  if (lastFilled !== null && current === lastFilled) return text;
  if (lastFilled !== null && current.endsWith(`\n${lastFilled}`)) return `${current.slice(0, -lastFilled.length)}${text}`;
  return `${current.replace(/\s+$/, '')}\n${text}`;
}
