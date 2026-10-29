import { useSyncExternalStore } from 'react';
import type { LibraryFilters, LibraryPreviewTarget, LibraryViewName, MaterialKind } from './types.js';

const storageKey = 'wwa.library';
export const libraryPageSize = 40;

export type LibrarySnapshot = {
  query: string;
  kind: '' | MaterialKind;
  taskTopicId: string;
  taskId: string;
  folderId: string;
  tagIds: string[];
  view: LibraryViewName;
  cursor: number;
  pageSize: 40;
  selectedIds: string[];
  preview: LibraryPreviewTarget | null;
  scrollTop: number;
};

const defaults: LibrarySnapshot = {
  query: '', kind: '', taskTopicId: '', taskId: '', folderId: '', tagIds: [], view: 'all', cursor: 0, pageSize: libraryPageSize, selectedIds: [], preview: null, scrollTop: 0,
};

const kindValues = new Set(['', 'document', 'text', 'markdown', 'link', 'thread', 'attachment']);
const viewValues = new Set<LibraryViewName>(['all', 'recent', 'unfiled', 'archived']);
const filterKeys = ['query', 'kind', 'taskTopicId', 'taskId', 'folderId', 'tagIds', 'view'] as const;

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function readPreview(parsed: Record<string, unknown>): LibraryPreviewTarget | null {
  const preview = parsed.preview;
  if (preview && typeof preview === 'object') {
    const record = preview as Record<string, unknown>;
    if (typeof record.materialId === 'string' && record.materialId) {
      return {
        materialId: record.materialId,
        revision: typeof record.revision === 'number' ? record.revision : null,
        chunkId: typeof record.chunkId === 'string' && record.chunkId ? record.chunkId : null,
      };
    }
  }
  if (typeof parsed.selectedId === 'string' && parsed.selectedId) return { materialId: parsed.selectedId, revision: null, chunkId: null };
  return null;
}

function readSnapshot(): LibrarySnapshot {
  if (typeof sessionStorage === 'undefined') return { ...defaults, tagIds: [], selectedIds: [] };
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return { ...defaults, tagIds: [], selectedIds: [] };
    const kind = typeof parsed.kind === 'string' && kindValues.has(parsed.kind) ? parsed.kind as LibrarySnapshot['kind'] : '';
    const view = typeof parsed.view === 'string' && viewValues.has(parsed.view as LibraryViewName) ? parsed.view as LibraryViewName : 'all';
    return {
      query: typeof parsed.query === 'string' ? parsed.query : '',
      kind,
      taskTopicId: typeof parsed.taskTopicId === 'string' ? parsed.taskTopicId : '',
      taskId: typeof parsed.taskId === 'string' ? parsed.taskId : '',
      folderId: typeof parsed.folderId === 'string' ? parsed.folderId : '',
      tagIds: Array.isArray(parsed.tagIds) ? parsed.tagIds.filter((id): id is string => typeof id === 'string') : [],
      view,
      cursor: typeof parsed.cursor === 'number' && parsed.cursor >= 0 ? Math.floor(parsed.cursor) : 0,
      pageSize: libraryPageSize,
      selectedIds: Array.isArray(parsed.selectedIds) ? parsed.selectedIds.filter((id): id is string => typeof id === 'string') : [],
      preview: readPreview(parsed),
      scrollTop: typeof parsed.scrollTop === 'number' && parsed.scrollTop >= 0 ? parsed.scrollTop : 0,
    };
  } catch {
    return { ...defaults, tagIds: [], selectedIds: [] };
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
  const filtersChanged = filterKeys.some((key) => {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) return false;
    if (key === 'tagIds') return !sameIds(snapshot.tagIds, patch.tagIds ?? []);
    return patch[key] !== snapshot[key];
  });
  const next: LibrarySnapshot = { ...snapshot, ...patch, pageSize: libraryPageSize };
  if (filtersChanged) {
    if (!Object.prototype.hasOwnProperty.call(patch, 'cursor')) next.cursor = 0;
    if (!Object.prototype.hasOwnProperty.call(patch, 'selectedIds')) next.selectedIds = [];
  }
  snapshot = next;
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
  params.set('cursor', String(state.cursor));
  params.set('limit', String(libraryPageSize));
  return params;
}

export function clearLibraryFilters() {
  patchLibrary({ query: '', kind: '', taskTopicId: '', taskId: '', folderId: '', tagIds: [], view: 'all', scrollTop: 0 });
}
