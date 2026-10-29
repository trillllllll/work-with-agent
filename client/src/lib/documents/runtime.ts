import { isEditorRuntimeActive } from '../task-editor-runtime.js';
import { DocumentDraftStore } from './draft-store.js';
import { documentTransport } from './api.js';
import { DocumentSessionRegistry } from './session.js';

let current: { scopeKey: string; registry: DocumentSessionRegistry; dispose: () => void } | null = null;
let deviceId: string | null = null;
function documentDeviceId() {
  if (deviceId) return deviceId;
  try {
    deviceId = localStorage.getItem('dovun.documents.device');
    if (!deviceId) { deviceId = crypto.randomUUID(); localStorage.setItem('dovun.documents.device', deviceId); }
  } catch {
    // Device identity is not an authorization grant. Missing persistence is exposed by the draft store itself.
    // IndexedDB itself is isolated per browser profile/device. A stable fallback preserves recovery if
    // localStorage is disabled while IndexedDB remains available; it is never sent as an auth claim.
    deviceId = 'local-browser-profile';
  }
  return deviceId;
}

export function disposeDocumentRegistry() { current?.dispose(); current = null; }

/** Takes the authenticated task runtime's exact scope; never infers a user from an origin alone. */
export function getDocumentRegistry(scopeKey: string) {
  if (current?.scopeKey === scopeKey) return current.registry;
  disposeDocumentRegistry();
  let active = true;
  const releases: Array<() => void> = [];
  const locks = new Set<string>();
  const isActive = () => active && isEditorRuntimeActive(scopeKey);
  const holdBranch = typeof navigator !== 'undefined' && navigator.locks?.request
    ? (name: string) => new Promise<boolean>((resolve) => {
      if (locks.has(name)) { resolve(true); return; }
      navigator.locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock || !active) { resolve(false); return; }
        locks.add(name); resolve(true);
        return new Promise<void>((release) => releases.push(() => { locks.delete(name); release(); }));
      }).catch(() => resolve(false));
    }) : undefined;
  const registry = new DocumentSessionRegistry({ scopeKey, deviceId: documentDeviceId(), sessionId: crypto.randomUUID(), store: new DocumentDraftStore(), transport: documentTransport(isActive), isActive, holdBranch });
  const onOnline = () => { void registry.reconnect(); };
  const onLeave = () => { void registry.flushLocal(); };
  const onVisibilityChange = () => { if (document.visibilityState === 'hidden') onLeave(); };
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    // Synchronous handoff closes the editor's 250ms serialization gap. IDB remains async:
    // prevent departure until a completed local transaction proves the new input durable.
    registry.flushEditors();
    const unsafe = registry.hasUnpersistedChanges();
    void registry.flushLocal();
    if (unsafe) { event.preventDefault(); event.returnValue = ''; }
  };
  const onExpired = () => { if (current?.registry === registry) disposeDocumentRegistry(); };
  window.addEventListener('online', onOnline);
  window.addEventListener('pagehide', onLeave);
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('workspace-session-expired', onExpired);
  current = { scopeKey, registry, dispose: () => {
    registry.flushEditors();
    active = false; registry.deactivate(); releases.forEach((release) => release());
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pagehide', onLeave);
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('workspace-session-expired', onExpired);
  } };
  return registry;
}
