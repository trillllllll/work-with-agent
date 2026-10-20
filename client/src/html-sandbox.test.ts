import { describe, it, expect } from 'vitest';
import { bridgeScript, buildCsp, buildSrcdoc, clampHeight, createNavigationGuard, createNonce, mergeFill, readBridgeMessage, safeCdn } from './lib/html-sandbox.js';

const nonceOf = (doc: string) => {
  const at = doc.indexOf('var NONCE=');
  const literal = /^"(\\.|[^"\\])*"/.exec(doc.slice(at + 'var NONCE='.length));
  return literal ? JSON.parse(literal[0]) as string : undefined;
};

describe('html sandbox document', () => {
  it('puts the CSP before any model markup and blocks every network path except the allowlist', () => {
    const doc = buildSrcdoc('<meta http-equiv="Content-Security-Policy" content="default-src *"><p>hi</p>', { cdn: ['https://cdn.jsdelivr.net'], theme: 'dark', nonce: 'nonce-1' });
    expect(doc.indexOf("default-src 'none'")).toBeLessThan(doc.indexOf('default-src *'));
    const csp = buildCsp(['https://cdn.jsdelivr.net']);
    for (const part of ["connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'", "worker-src 'none'"]) expect(csp).toContain(part);
    expect(csp).toContain("script-src 'unsafe-inline' https://cdn.jsdelivr.net");
    expect(csp).not.toContain('unsafe-eval');
    expect(doc).toContain('wwa:fill-input');
    const exported = buildSrcdoc('<p>x</p>', { cdn: [], theme: 'light', bridge: false, nonce: 'secret-nonce' });
    expect(exported).not.toContain('wwa:fill-input');
    expect(exported).not.toContain('wwa:ready');
    expect(exported).not.toContain('secret-nonce');
    expect(exported).not.toContain('postMessage');
    expect(exported).not.toContain('<script');
  });
  it('drops allowlist entries that could widen the CSP', () => {
    expect(safeCdn(['https://cdn.jsdelivr.net', "https://a.example 'unsafe-eval'", '*', 'https://x.example; connect-src *', 'http://evil.example'])).toEqual(['https://cdn.jsdelivr.net']);
  });
  it('accepts only exact bridge messages and rejects oversized fills instead of truncating', () => {
    expect(readBridgeMessage({ type: 'wwa:fill-input', text: ' 选 A\u202e ', nonce: 'n' })).toEqual({ type: 'fill', text: '选 A', nonce: 'n' });
    expect(readBridgeMessage({ type: 'wwa:resize', height: 400, nonce: 'n' })).toEqual({ type: 'resize', height: 400, nonce: 'n' });
    expect(readBridgeMessage({ type: 'wwa:ready', nonce: 'n' })).toEqual({ type: 'ready', nonce: 'n' });
    expect(readBridgeMessage({ type: 'wwa:fill-input', text: 'x'.repeat(2001), nonce: 'n' })).toMatchObject({ type: 'invalid', nonce: 'n' });
    expect(readBridgeMessage({ type: 'wwa:fill-input', text: ' \u202e ', nonce: 'n' })).toMatchObject({ type: 'invalid', nonce: 'n' });
    for (const data of [
      null,
      'wwa:fill-input',
      { type: 'wwa:fill-input', text: 'x', nonce: 'n', send: true },
      { type: 'wwa:send', text: 'x', nonce: 'n' },
      { type: 'wwa:resize', height: Infinity, nonce: 'n' },
      { type: 'wwa:ready' },
      { type: 'wwa:resize', height: 400 },
      { type: 'wwa:fill-input', text: 'x' },
      { type: 'wwa:ready', nonce: 1 },
      { type: 'wwa:resize', height: 1, nonce: null },
      { type: 'wwa:fill-input', text: 'x', nonce: { length: 1 } },
      Object.assign(Object.create({ evil: 1 }), { type: 'wwa:resize', height: 1, nonce: 'n' }),
      Object.assign(Object.create(null), { type: 'wwa:ready', nonce: 'n' }),
    ]) expect(readBridgeMessage(data)).toBeNull();
    expect(clampHeight(5, undefined)).toBe(120); expect(clampHeight(99999, undefined)).toBe(1200); expect(clampHeight(900, 600)).toBe(600);
  });
  it('fills an empty composer, replaces its own previous choice, and never overwrites what the user typed', () => {
    expect(mergeFill('', '选 A', null)).toBe('选 A');
    expect(mergeFill('选 A', '选 B', '选 A')).toBe('选 B');
    expect(mergeFill('我的想法', '选 B', null)).toBe('我的想法\n选 B');
    expect(mergeFill('我的想法\n选 A', '选 B', '选 A')).toBe('我的想法\n选 B');
  });
  it('embeds the nonce only in the bridge script and escapes characters that would close it', () => {
    const plain = 'nonce-token-42';
    const doc = buildSrcdoc('<p>hi</p>', { cdn: [], theme: 'light', nonce: plain });
    const script = doc.match(/<script>[\s\S]*<\/script>/)?.[0] ?? '';
    expect(script).toContain(plain);
    expect(doc.replace(script, '')).not.toContain(plain);
    expect(doc.indexOf("default-src 'none'")).toBeLessThan(doc.indexOf('<p>hi</p>'));
    const hostile = 'abc</script></SCRIPT><script>alert(1)</script>\u2028\u2029<img src=x>';
    const escaped = buildSrcdoc('<p>after</p>', { cdn: [], theme: 'dark', nonce: hostile });
    expect(escaped.match(/<script/gi)).toHaveLength(1);
    expect(escaped.match(/<\/script>/gi)).toHaveLength(1);
    expect(nonceOf(escaped)).toBe(hostile);
    expect(escaped).not.toContain(hostile);
    expect(escaped.indexOf('<p>after</p>')).toBeGreaterThan(escaped.indexOf('</script>'));
    expect(() => buildSrcdoc('<p>x</p>', { cdn: [], theme: 'light' })).toThrow(/nonce/);
  });
  it('captures window.parent and does not post through a bare parent', () => {
    const script = bridgeScript('n');
    expect(script).toContain('var el=document.currentScript');
    expect(script).toContain('var P=window.parent');
    expect(script).toContain('P.postMessage');
    expect(script).not.toContain('parent.postMessage');
    expect(script).toContain("window.addEventListener('load',function(){send({type:'wwa:ready'})},true)");
    expect(script.match(/wwa:ready/g)).toHaveLength(1);
    expect(script).not.toContain('type=module');
    expect(script).toContain('finally');
    expect(script).toContain('removeChild');
    const doc = buildSrcdoc('<p>x</p>', { cdn: [], theme: 'light', nonce: 'n' });
    expect(doc).toContain('<script>');
    expect(doc).not.toContain('type="module"');
  });
});

type Listener = { fn: (event: Record<string, unknown>) => void; capture: boolean };

function installBridge(nonce: string, baseURI = 'http://app.example/todo#/inbox') {
  const posted: unknown[] = [];
  const parent = { postMessage(message: unknown) { posted.push(message); } };
  const windowListeners: Record<string, Listener[]> = {};
  const documentListeners: Record<string, Listener[]> = {};
  const byId = new Map<string, { scrolled: boolean; scrollIntoView: () => void }>();
  const byName = new Map<string, { scrolled: boolean; scrollIntoView: () => void }[]>();
  const themeNode = { textContent: '' };
  const documentElement = {
    scrollHeight: 0,
    getAttribute(name: string) { return name === 'data-wwa-theme' ? (this.theme ?? 'light') : null; },
    setAttribute(name: string, value: string) { if (name === 'data-wwa-theme') this.theme = value; },
    theme: 'light',
  };
  const script: { parentNode: { removeChild: (node: unknown) => void } | null } = { parentNode: null };
  script.parentNode = { removeChild(node: unknown) { if (node !== script) throw new Error('removed a different node'); script.parentNode = null; } };
  const fakeDocument = {
    currentScript: script,
    baseURI,
    documentElement,
    body: { scrollHeight: 0 },
    getElementById(id: string) { return id === 'wwa-theme' ? themeNode : byId.get(id) ?? null; },
    getElementsByName(name: string) { return byName.get(name) ?? []; },
    addEventListener(type: string, fn: Listener['fn'], capture?: boolean) { (documentListeners[type] ??= []).push({ fn, capture: Boolean(capture) }); },
  };
  const fakeWindow: { parent: typeof parent; wwa?: { fillInput: (text: unknown) => boolean; theme: string }; addEventListener: (type: string, fn: Listener['fn'], capture?: boolean) => void } = {
    parent,
    addEventListener(type, fn, capture) { (windowListeners[type] ??= []).push({ fn, capture: Boolean(capture) }); },
  };
  const run = new Function('window', 'document', 'requestAnimationFrame', 'ResizeObserver', bridgeScript(nonce));
  run(fakeWindow, fakeDocument, () => {}, undefined);
  const dispatch = (bucket: Record<string, Listener[]>, type: string, event: Record<string, unknown>) => {
    for (const item of bucket[type] ?? []) if (item.capture) item.fn(event);
    for (const item of bucket[type] ?? []) if (!item.capture) item.fn(event);
  };
  const element = () => {
    const node = { scrolled: false, scrollIntoView() { node.scrolled = true; } };
    return node;
  };
  const link = (href: string) => ({
    nodeType: 1,
    localName: 'a',
    parentNode: fakeDocument as unknown,
    getAttribute(name: string) { return name === 'href' ? href : null; },
  });
  const click = (target: unknown, type = 'click') => {
    let prevented = false;
    let stopped = false;
    dispatch(documentListeners, type, {
      type,
      target,
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; },
      stopImmediatePropagation() { stopped = true; },
    });
    return { prevented, stopped };
  };
  return { posted, parent, fakeWindow, fakeDocument, windowListeners, documentListeners, byId, byName, script, themeNode, documentElement, dispatch, element, link, click };
}

describe('bridge runtime', () => {
  it('removes its script, sends ready on the child load, and keeps posting through the captured parent', () => {
    const bridge = installBridge('nonce-a');
    expect(bridge.script.parentNode).toBeNull();
    expect(bridge.posted).toEqual([]);
    expect(bridge.windowListeners.load?.some((item) => item.capture)).toBe(true);
    expect(bridge.documentListeners.click?.every((item) => item.capture)).toBe(true);
    expect(bridge.documentListeners.auxclick?.every((item) => item.capture)).toBe(true);
    bridge.dispatch(bridge.windowListeners, 'load', {});
    expect(bridge.posted).toEqual([{ type: 'wwa:ready', nonce: 'nonce-a' }]);
    const hijacked: unknown[] = [];
    bridge.fakeWindow.parent = { postMessage(message: unknown) { hijacked.push(message); } };
    expect(bridge.fakeWindow.wwa?.fillInput('hello')).toBe(true);
    expect(bridge.fakeWindow.wwa?.fillInput(1)).toBe(false);
    expect(bridge.posted[bridge.posted.length - 1]).toEqual({ type: 'wwa:fill-input', text: 'hello', nonce: 'nonce-a' });
    expect(hijacked).toEqual([]);
    bridge.dispatch(bridge.windowListeners, 'message', { source: bridge.parent, data: { type: 'wwa:theme', theme: 'dark', css: '.x{}' } });
    expect(bridge.documentElement.theme).toBe('dark');
    expect(bridge.themeNode.textContent).toBe('.x{}');
    bridge.dispatch(bridge.windowListeners, 'message', { source: bridge.fakeWindow.parent, data: { type: 'wwa:theme', theme: 'light', css: 'no' } });
    expect(bridge.documentElement.theme).toBe('dark');
  });
  it('cancels same-document link clicks, including empty href and svg anchors, and scrolls named fragments', () => {
    const bridge = installBridge('nonce-b');
    const section = bridge.element();
    bridge.byId.set('section', section);
    const spaced = bridge.element();
    bridge.byId.set('my id', spaced);
    const named = bridge.element();
    bridge.byName.set('alias', [named]);
    const hashLink = bridge.link('#section');
    const child = { nodeType: 1, localName: 'span', parentNode: hashLink, getAttribute: () => null };
    const text = { nodeType: 3, parentNode: hashLink };
    expect(bridge.click(child)).toEqual({ prevented: true, stopped: false });
    expect(section.scrolled).toBe(true);
    expect(bridge.click(text).prevented).toBe(true);
    const svgChild = { nodeType: 1, localName: 'tspan', parentNode: bridge.link('#section') };
    section.scrolled = false;
    expect(bridge.click(svgChild).prevented).toBe(true);
    expect(section.scrolled).toBe(true);
    section.scrolled = false;
    expect(bridge.click(bridge.link('#'))).toEqual({ prevented: true, stopped: false });
    expect(bridge.click(bridge.link(''))).toEqual({ prevented: true, stopped: false });
    expect(section.scrolled).toBe(false);
    expect(bridge.click(bridge.link('#my%20id')).prevented).toBe(true);
    expect(spaced.scrolled).toBe(true);
    expect(bridge.click(bridge.link('#alias')).prevented).toBe(true);
    expect(named.scrolled).toBe(true);
    named.scrolled = false;
    expect(bridge.click(bridge.link('#alias'), 'auxclick')).toEqual({ prevented: true, stopped: false });
    expect(named.scrolled).toBe(false);
    expect(bridge.click(bridge.link('https://example.com/out')).prevented).toBe(false);
    expect(bridge.click(bridge.link('?a=1')).prevented).toBe(false);
    expect(bridge.click(bridge.link('/other')).prevented).toBe(false);
    expect(bridge.click({ nodeType: 1, localName: 'button', parentNode: bridge.fakeDocument, getAttribute: () => null }).prevented).toBe(false);
  });
});

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer(fn: () => void, ms: number) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id: number) { pending.delete(id); },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let next: { id: number; at: number; fn: () => void } | null = null;
        for (const [id, timer] of pending) {
          if (timer.at <= target && (!next || timer.at < next.at || (timer.at === next.at && id < next.id))) next = { id, at: timer.at, fn: timer.fn };
        }
        if (!next) break;
        now = next.at;
        pending.delete(next.id);
        next.fn();
      }
      now = target;
    },
  };
}

function guardHarness() {
  const clock = fakeClock();
  const events: string[] = [];
  const guard = createNavigationGuard({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onHide: () => events.push('hide'),
    onShow: () => events.push('show'),
    onBlock: () => events.push('block'),
  });
  return { clock, events, guard };
}

describe('navigation guard', () => {
  it('accepts a ready that arrives before its load', () => {
    const { clock, events, guard } = guardHarness();
    guard.ready();
    guard.load();
    clock.advance(2000);
    expect(events).toEqual([]);
  });
  it('accepts a ready that arrives after load and inside the grace period', () => {
    const { clock, events, guard } = guardHarness();
    guard.load();
    clock.advance(200);
    guard.ready();
    clock.advance(2000);
    expect(events).toEqual([]);
  });
  it('hides at 500ms and blocks at 1000ms when no ready arrives', () => {
    const { clock, events, guard } = guardHarness();
    guard.load();
    clock.advance(499);
    expect(events).toEqual([]);
    clock.advance(1);
    expect(events).toEqual(['hide']);
    clock.advance(499);
    expect(events).toEqual(['hide']);
    clock.advance(1);
    expect(events).toEqual(['hide', 'block']);
  });
  it('shows again when a ready arrives after hide and before the block', () => {
    const { clock, events, guard } = guardHarness();
    guard.load();
    clock.advance(500);
    guard.ready();
    clock.advance(2000);
    expect(events).toEqual(['hide', 'show']);
  });
  it('does not let one ready cover two loads', () => {
    const { clock, events, guard } = guardHarness();
    guard.load();
    guard.load();
    guard.ready();
    clock.advance(1000);
    expect(events).toEqual(['hide', 'block']);
  });
  it('blocks a later load that never gets its own ready', () => {
    const { clock, events, guard } = guardHarness();
    guard.load();
    guard.ready();
    guard.load();
    clock.advance(1000);
    expect(events).toEqual(['hide', 'block']);
  });
  it('lets a reload pass when the new document sends its own ready', () => {
    const { clock, events, guard } = guardHarness();
    guard.load();
    guard.ready();
    guard.load();
    clock.advance(100);
    guard.ready();
    clock.advance(2000);
    expect(events).toEqual([]);
  });
  it('restarts the grace timers from the latest unconfirmed load and drops them on dispose', () => {
    const restarted = guardHarness();
    restarted.guard.load();
    restarted.clock.advance(400);
    restarted.guard.load();
    restarted.clock.advance(400);
    expect(restarted.events).toEqual([]);
    restarted.clock.advance(100);
    expect(restarted.events).toEqual(['hide']);
    const disposed = guardHarness();
    disposed.guard.load();
    disposed.guard.dispose();
    disposed.clock.advance(2000);
    expect(disposed.events).toEqual([]);
  });
});

describe('createNonce', () => {
  it('uses randomUUID when present and 16 hex bytes otherwise', () => {
    expect(createNonce()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const cryptoApi = globalThis.crypto;
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    const expected = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const randomUUID = Object.getOwnPropertyDescriptor(cryptoApi, 'randomUUID');
    const getRandomValues = cryptoApi.getRandomValues.bind(cryptoApi);
    Object.defineProperty(cryptoApi, 'randomUUID', { configurable: true, value: undefined });
    cryptoApi.getRandomValues = ((target: Uint8Array) => { target.set(bytes); return target; }) as typeof cryptoApi.getRandomValues;
    try {
      expect(createNonce()).toBe(expected);
    } finally {
      if (randomUUID) Object.defineProperty(cryptoApi, 'randomUUID', randomUUID);
      else Reflect.deleteProperty(cryptoApi, 'randomUUID');
      cryptoApi.getRandomValues = getRandomValues;
    }
  });
});
