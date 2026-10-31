import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { patchLibrary } from '@/components/library/store.js';

export type DocumentOpenTarget = {
  resourceId: string;
  revision?: number | null;
  nodeId?: string | null;
  chunkId?: string | null;
  title?: string;
  returnHash?: string;
};
export type NewDocumentTarget = { requestId: string; format: 'richdoc-v1' | 'markdown' | 'text'; topicId: string | null; folderId: string | null };
export type OpenDocumentTab = DocumentOpenTarget & { key: string };
export type OpenDocuments = { tabs: OpenDocumentTab[]; active: string | null; secondary: string | null; create: NewDocumentTarget | null };

const empty: OpenDocuments = { tabs: [], active: null, secondary: null, create: null };
const states = new Map<string, OpenDocuments>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
/** One-shot, in memory only: the first surface of a freshly created document focuses its title. */
const titleFocus = new Set<string>();
export function takeTitleFocus(scope: string, key: string) { return titleFocus.delete(JSON.stringify([scope, key])); }

export function documentTargetKey(target: DocumentOpenTarget) { return JSON.stringify([target.resourceId, target.revision ?? null]); }

export function addDocumentTab(state: OpenDocuments, target: DocumentOpenTarget): OpenDocuments {
  const key = documentTargetKey(target);
  const previous = state.tabs.find((tab) => tab.key === key);
  const tab = { ...previous, ...target, key };
  return { ...state, tabs: previous ? state.tabs.map((item) => item.key === key ? tab : item) : [...state.tabs, tab], active: key };
}

function readState(scope: string) {
  const cached = states.get(scope);
  if (cached) return cached;
  let state = empty;
  if (scope && typeof sessionStorage !== 'undefined') {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`dovun.documents.views:${scope}`) ?? 'null') as OpenDocuments | null;
      if (saved && Array.isArray(saved.tabs)) {
        const tabs = saved.tabs.filter((tab) => typeof tab.resourceId === 'string' && tab.resourceId.length < 256 && tab.key === documentTargetKey(tab));
        state = { tabs, active: tabs.some((tab) => tab.key === saved.active) ? saved.active : null, secondary: tabs.some((tab) => tab.key === saved.secondary) ? saved.secondary : null, create: null };
      }
    } catch { /* View persistence is optional; document content lives in IndexedDB. */ }
  }
  states.set(scope, state);
  return state;
}
function writeState(scope: string, update: (state: OpenDocuments) => OpenDocuments) {
  const next = update(readState(scope));
  states.set(scope, next);
  try { sessionStorage.setItem(`dovun.documents.views:${scope}`, JSON.stringify({ ...next, create: null })); } catch { /* The draft store separately reports content persistence errors. */ }
  emit();
}

function reflectActive(scope: string) {
  const state = readState(scope);
  const active = state.tabs.find((tab) => tab.key === state.active);
  patchLibrary({ preview: active ? { materialId: active.resourceId, revision: active.revision ?? null, chunkId: active.chunkId ?? null } : null });
  const params = new URLSearchParams();
  if (active) { params.set('resource', active.resourceId); if (active.revision != null) params.set('revision', String(active.revision)); if (active.nodeId) params.set('node', active.nodeId); if (active.chunkId) params.set('chunk', active.chunkId); if (active.returnHash) params.set('from', active.returnHash); }
  history.replaceState(null, '', `${location.pathname}${location.search}#/library${params.size ? `?${params}` : ''}`);
}

/** Navigation carries identity and version only; authorization is checked when opening. */
export function openDocument(target: DocumentOpenTarget) {
  const params = new URLSearchParams({ resource: target.resourceId });
  if (target.revision != null) params.set('revision', String(target.revision));
  if (target.nodeId) params.set('node', target.nodeId);
  if (target.chunkId) params.set('chunk', target.chunkId);
  const returnHash = target.returnHash ?? (window.location.hash.startsWith('#/library') ? '' : window.location.hash);
  if (returnHash) params.set('from', returnHash);
  patchLibrary({ preview: { materialId: target.resourceId, revision: target.revision ?? null, chunkId: target.chunkId ?? null } });
  window.location.hash = `/library?${params}`;
  window.dispatchEvent(new CustomEvent('dovun-open-document', { detail: target }));
}

export function openNewDocument(format: NewDocumentTarget['format'] = 'richdoc-v1', context: { topicId?: string | null; folderId?: string | null } = {}) {
  const params = new URLSearchParams({ create: crypto.randomUUID(), format });
  if (context.topicId) params.set('topic', context.topicId);
  if (context.folderId) params.set('folder', context.folderId);
  window.location.hash = `/library?${params}`;
  window.dispatchEvent(new Event('dovun-open-document'));
}

export function useOpenDocuments(scope: string) {
  const subscribe = useCallback((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  const getSnapshot = useCallback(() => readState(scope), [scope]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (!scope) return;
    const sync = () => {
      if (!window.location.hash.startsWith('#/library')) return;
      const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
      const resourceId = query.get('resource');
      const revision = Number(query.get('revision'));
      if (resourceId) writeState(scope, (current) => addDocumentTab(current, { resourceId, revision: revision > 0 && Number.isInteger(revision) ? revision : null, nodeId: query.get('node'), chunkId: query.get('chunk'), returnHash: query.get('from') ?? undefined }));
      const requestId = query.get('create');
      const format = query.get('format');
      if (requestId && (format === 'richdoc-v1' || format === 'markdown' || format === 'text')) writeState(scope, (current) => current.create?.requestId === requestId ? current : { ...current, create: { requestId, format, topicId: query.get('topic'), folderId: query.get('folder') } });
    };
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('dovun-open-document', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('dovun-open-document', sync); };
  }, [scope]);
  return state;
}

export const documentTabs = {
  activate(scope: string, key: string) { writeState(scope, (state) => ({ ...state, active: key })); reflectActive(scope); },
  open(scope: string, target: DocumentOpenTarget) { writeState(scope, (state) => addDocumentTab(state, target)); reflectActive(scope); },
  title(scope: string, key: string, title: string) { writeState(scope, (state) => state.tabs.find((tab) => tab.key === key)?.title === title ? state : { ...state, tabs: state.tabs.map((tab) => tab.key === key ? { ...tab, title } : tab) }); },
  split(scope: string, key: string | null) { writeState(scope, (state) => ({ ...state, secondary: key })); },
  showList(scope: string) { writeState(scope, (state) => ({ ...state, active: null })); reflectActive(scope); },
  created(scope: string, target: DocumentOpenTarget) { titleFocus.add(JSON.stringify([scope, documentTargetKey(target)])); writeState(scope, (state) => ({ ...addDocumentTab(state, target), create: null })); reflectActive(scope); },
  close(scope: string, key: string) { writeState(scope, (state) => { const index = state.tabs.findIndex((tab) => tab.key === key); const tabs = state.tabs.filter((tab) => tab.key !== key); return { ...state, tabs, active: state.active === key ? (tabs[Math.max(0, index - 1)]?.key ?? null) : state.active, secondary: state.secondary === key ? null : state.secondary }; }); reflectActive(scope); },
};
