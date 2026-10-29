import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { disposeDocumentRegistry, getDocumentRegistry } from './runtime.js';

vi.mock('../task-editor-runtime.js', () => ({ isEditorRuntimeActive: () => true }));
vi.mock('./api.js', () => ({ documentTransport: () => ({ send: async () => ({ kind: 'unknown' }), receipt: async () => ({ kind: 'unknown' }) }) }));

let events: EventTarget;
function beforeUnload() { const event = new Event('beforeunload', { cancelable: true }); Object.defineProperty(event, 'returnValue', { value: '', writable: true }); return event; }
beforeEach(() => {
  events = new EventTarget();
  vi.stubGlobal('window', events);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('localStorage', { getItem: () => 'device-test', setItem: () => {} });
  vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => { disposeDocumentRegistry(); vi.unstubAllGlobals(); });

it('beforeunload captures the newest editor buffer and blocks until its IDB commit completes', async () => {
  const registry = getDocumentRegistry('authenticated-scope');
  const session = await registry.create({ title: 'Draft', format: 'text', content: 'durable body' });
  // A durable offline draft alone must not prompt: the cloud can be unavailable indefinitely.
  expect(events.dispatchEvent(beforeUnload())).toBe(true);
  let buffered = true;
  session.registerEditor('primary', () => { if (buffered) { buffered = false; session.edit('typed immediately before refresh'); session.setEditorPending('primary', false); } return true; });
  // Simulate a same-task DOM mutation whose observer has not yet raised pending.
  expect(session.getSnapshot().content).toBe('durable body');
  const first = beforeUnload();
  expect(events.dispatchEvent(first)).toBe(false);
  expect(first.defaultPrevented).toBe(true);
  expect(session.getSnapshot().content).toBe('typed immediately before refresh');
  await registry.flushLocal();
  expect((await registry.listDrafts())[0].content).toBe('typed immediately before refresh');
  expect(events.dispatchEvent(beforeUnload())).toBe(true);
});
