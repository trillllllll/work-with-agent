import { useLayoutEffect, useSyncExternalStore } from 'react';
import type { ChatContextV3, ChatAttachment } from '../../../server/src/agent/chat-context.js';
import { t } from '../i18n/index.js';
export type { ChatContextV3, ChatAttachment };

const pageNameIds = ['inbox', 'board', 'today', 'plan', 'search', 'tags', 'library', 'knowledge', 'topics', 'quadrant', 'archived', 'trash', 'focus', 'settings', 'connections', 'skills', 'proposals', 'changes', 'runs', 'reviews', 'more'] as const;
export const pageNames: Record<string, string> = {};
for (const id of pageNameIds) Object.defineProperty(pageNames, id, { enumerable: true, get: () => t(`chat:pageNames.${id}`) });
type PublishedContext = { page: string; value: Partial<ChatContextV3> };
const pages = new Map<string, PublishedContext>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, PublishedContext> = new Map();
function notify() { snapshot = new Map(pages); listeners.forEach((listener) => listener()); }
export function usePageContext(page: string, value: Partial<ChatContextV3>) {
  const serialized = JSON.stringify(value);
  useLayoutEffect(() => {
    const entry = { page, value: JSON.parse(serialized) as Partial<ChatContextV3> };
    pages.set(page, entry); notify();
    return () => { if (pages.get(page) === entry) { pages.delete(page); notify(); } };
  }, [page, serialized]);
}
export function usePageContexts() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
}
/** Only the display label is shortened; keep object titles and attachment text intact. */
export function contextLabel(label: string) {
  const clipped = label.slice(0, 300);
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}
export function attachmentError(items: ChatAttachment[]) {
  if (items.length > 20) return t('chat:attachments.tooMany');
  if (items.some((item) => [...item.text].length > 20000)) return t('chat:attachments.tooLong');
  if (items.reduce((sum, item) => sum + [...item.text].length, 0) > 40000) return t('chat:attachments.totalTooLong');
  return '';
}
export function askAssistant(attachment?: Omit<ChatAttachment, 'id'>) {
  window.dispatchEvent(new CustomEvent('wwa-open-assistant', { detail: attachment ? { attachment: { ...attachment, id: crypto.randomUUID() } } : {} }));
}
export function suggestions(page: string): string[] {
  const group = page === 'plan' ? 'plan' : page === 'library' ? 'library' : page === 'settings' || page === 'connections' ? 'settings' : 'default';
  return [1, 2, 3].map((index) => t(`chat:suggestions.${group}.${index}`));
}
