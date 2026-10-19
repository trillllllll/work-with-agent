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

/** Runs before any model script. Exposes only fillInput, the theme and automatic height reports. */
export const BRIDGE_HELPER = `(function(){
var send=function(m){try{parent.postMessage(m,'*')}catch(e){}};
try{delete window.RTCPeerConnection;delete window.webkitRTCPeerConnection;delete window.RTCDataChannel}catch(e){}
var listeners=[];
var api={fillInput:function(text){if(typeof text!=='string')return false;send({type:'wwa:fill-input',text:text});return true},
theme:document.documentElement.getAttribute('data-wwa-theme')||'light',
onThemeChange:function(fn){if(typeof fn==='function')listeners.push(fn)}};
Object.defineProperty(window,'wwa',{value:Object.freeze(api),writable:false,configurable:false});
window.addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data;if(!d||d.type!=='wwa:theme'||(d.theme!=='light'&&d.theme!=='dark'))return;
document.documentElement.setAttribute('data-wwa-theme',d.theme);var s=document.getElementById('wwa-theme');if(s&&typeof d.css==='string')s.textContent=d.css;
listeners.forEach(function(fn){try{fn(d.theme)}catch(err){}})});
var last=0,queued=false;var report=function(){queued=false;var h=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0));if(h&&h!==last){last=h;send({type:'wwa:resize',height:h})}};
var schedule=function(){if(!queued){queued=true;requestAnimationFrame(report)}};
if(typeof ResizeObserver==='function'){var ro=new ResizeObserver(schedule);ro.observe(document.documentElement);document.addEventListener('DOMContentLoaded',function(){if(document.body)ro.observe(document.body)})}
window.addEventListener('load',schedule);
})();`;

/**
 * Our head comes first in the token stream, so the CSP meta is in force before any model markup.
 * A model-supplied <html>/<head> later in the stream is merged or ignored by the HTML parser,
 * and any extra CSP it adds can only narrow the policy (all policies apply).
 */
export function buildSrcdoc(source: string, options: { cdn: readonly string[]; theme: SandboxTheme; bridge?: boolean }) {
  const csp = buildCsp(options.cdn).replace(/"/g, '&quot;');
  return `<!doctype html><html data-wwa-theme="${options.theme}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="wwa-theme">${themeCss(options.theme)}</style>${options.bridge === false ? '' : `<script>${BRIDGE_HELPER}</script>`}</head>${source}`;
}

export type BridgeMessage = { type: 'fill'; text: string } | { type: 'resize'; height: number } | { type: 'invalid'; reason: string };
/** Validates the shape of a message whose source has already been matched to the iframe. */
export function readBridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype) return null;
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (record.type === 'wwa:resize') {
    if (keys !== 'height,type' || typeof record.height !== 'number' || !Number.isFinite(record.height)) return null;
    return { type: 'resize', height: record.height };
  }
  if (record.type === 'wwa:fill-input') {
    if (keys !== 'text,type' || typeof record.text !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const text = record.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/\r\n?/g, '\n').trim();
    if (!text) return { type: 'invalid', reason: '小页面填入的内容为空' };
    if ([...text].length > FILL_TEXT_LIMIT) return { type: 'invalid', reason: `小页面填入的内容超过 ${FILL_TEXT_LIMIT} 字，已忽略` };
    return { type: 'fill', text };
  }
  return null;
}

export function clampHeight(height: number, max = HEIGHT_MAX) { return Math.min(max, Math.max(HEIGHT_MIN, Math.ceil(height))); }

/** Empty → fill; unchanged since this block's last fill → replace (a changed choice); otherwise append on a new line. */
export function mergeFill(current: string, text: string, lastFilled: string | null) {
  if (!current.trim()) return text;
  if (lastFilled !== null && current === lastFilled) return text;
  if (lastFilled !== null && current.endsWith(`\n${lastFilled}`)) return `${current.slice(0, -lastFilled.length)}${text}`;
  return `${current.replace(/\s+$/, '')}\n${text}`;
}
