import { useSyncExternalStore } from 'react';
import type { LibraryFilters, LibraryViewName, MaterialKind } from './types.js';

const storageKey = 'wwa.library';

export type LibrarySnapshot = {
  query: string;
  kind: '' | MaterialKind;
  taskTopicId: string;
  taskId: string;
  folderId: string;
  tagIds: string[];
  view: LibraryViewName;
  selectedId: string;
  scrollTop: number;
};

const defaults: LibrarySnapshot = {
  query: '', kind: '', taskTopicId: '', taskId: '', folderId: '', tagIds: [], view: 'all', selectedId: '', scrollTop: 0,
};

function readSnapshot(): LibrarySnapshot {
  if (typeof sessionStorage === 'undefined') return { ...defaults };
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as Partial<LibrarySnapshot> | null;
    if (!parsed || typeof parsed !== 'object') return { ...defaults };
    return {
      ...defaults,
      ...parsed,
      tagIds: Array.isArray(parsed.tagIds) ? parsed.tagIds.filter((id) => typeof id === 'string') : [],
    };
  } catch {
    return { ...defaults };
  }
}

let snapshot = readSnapshot();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function getLibrarySnapshot() {
  return snapshot;
}

export function patchLibrary(patch: Partial<LibrarySnapshot>) {
  snapshot = { ...snapshot, ...patch };
  try { sessionStorage.setItem(storageKey, JSON.stringify(snapshot)); } catch { /* Private mode can reject storage. */ }
  emit();
}

export function subscribeLibrary(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLibrarySnapshot() {
  return useSyncExternalStore(subscribeLibrary, getLibrarySnapshot, getLibrarySnapshot);
}

export function libraryFilters(state: LibrarySnapshot): LibraryFilters {
  return {
    ...(state.view !== 'all' ? { view: state.view } : {}),
    ...(state.folderId ? { folderId: state.folderId } : {}),
    ...(state.tagIds.length ? { tagIds: state.tagIds } : {}),
    ...(state.taskId ? { taskId: state.taskId } : {}),
    ...(state.taskTopicId ? { taskTopicId: state.taskTopicId } : {}),
    ...(state.kind ? { kind: state.kind } : {}),
  };
}

export function librarySearchParams(state: LibrarySnapshot) {
  const params = new URLSearchParams();
  const filters = libraryFilters(state);
  if (filters.view) params.set('view', filters.view);
  if (filters.folderId) params.set('folderId', filters.folderId);
  if (filters.tagIds?.length) params.set('tagIds', filters.tagIds.join(','));
  if (filters.taskId) params.set('taskId', filters.taskId);
  if (filters.taskTopicId) params.set('taskTopicId', filters.taskTopicId);
  if (filters.kind) params.set('kind', filters.kind);
  params.set('limit', '100');
  return params;
}

export function clearLibraryFilters() {
  patchLibrary({ query: '', kind: '', taskTopicId: '', taskId: '', folderId: '', tagIds: [], view: 'all', scrollTop: 0 });
}
