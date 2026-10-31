import { getDocumentRegistry } from '@/lib/documents/runtime.js';
import { documentTabs, type OpenDocumentTab } from './open.js';
import { forgetTabEditPermit } from './edit-permits.js';

/**
 * Hand each visible view's input to its session and persist it before navigation.
 * Untouched blank documents among `closing` are discarded and their tabs closed, so
 * leaving them creates nothing in Dovun and leaves no local draft behind.
 * Returns false when a draft could not be stored locally; the caller must not navigate.
 */
export async function leaveDocumentViews(scopeKey: string, visible: Array<OpenDocumentTab | undefined>, closing: Array<OpenDocumentTab | undefined> = []) {
  if (!scopeKey) return true;
  const registry = getDocumentRegistry(scopeKey);
  const sessions = new Set(visible.flatMap((tab) => { const session = tab && registry.get(tab.resourceId); return session ? [session] : []; }));
  if ((await Promise.all([...sessions].map((session) => session.flushLocal()))).some((saved) => !saved)) return false;
  for (const tab of closing) {
    const session = tab && tab.revision == null ? registry.get(tab.resourceId) : undefined;
    if (session && await registry.discardIfPristine(session)) { forgetTabEditPermit(scopeKey, tab!); documentTabs.close(scopeKey, tab!.key); }
  }
  return true;
}
