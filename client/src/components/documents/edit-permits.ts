import { useCallback, useSyncExternalStore } from 'react';
import { getDocumentRegistry } from '@/lib/documents/runtime.js';
import type { OpenDocumentTab } from './open.js';

/**
 * Edit permission per open document, keyed by scope and local draft id. It is granted on first sight within
 * the budget or by "edit anyway", and growth never revokes it, so an open editor never turns read-only.
 * Closing the document's tab drops it: reopening decides again from the size at that moment.
 */
const permits = new Map<string, boolean>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => { version += 1; listeners.forEach((listener) => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const currentVersion = () => version;

export function editPermitKey(scopeKey: string, localId: string) { return `${scopeKey}:${localId}`; }

/** A tab names its document by the id it was opened with; the session's local id is what permits use. */
export function forgetTabEditPermit(scopeKey: string, tab: OpenDocumentTab) {
  const localId = scopeKey ? getDocumentRegistry(scopeKey).get(tab.resourceId)?.getSnapshot().localId : undefined;
  let removed = permits.delete(editPermitKey(scopeKey, tab.resourceId));
  if (localId) removed = permits.delete(editPermitKey(scopeKey, localId)) || removed;
  if (removed) changed();
}

export function useEditPermit(key: string | null, withinBudget: boolean) {
  // Every pane showing the document re-renders when one of them grants "edit anyway".
  useSyncExternalStore(subscribe, currentVersion, currentVersion);
  if (key && (withinBudget || !permits.has(key))) permits.set(key, withinBudget || permits.get(key) === true);
  const permitted = key !== null && permits.get(key) === true;
  const allow = useCallback(() => { if (!key) return; permits.set(key, true); changed(); }, [key]);
  return [permitted, allow] as const;
}
