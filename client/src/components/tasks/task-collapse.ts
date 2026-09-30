import { useCallback, useState } from 'react';

const STORAGE_KEY = 'todo.collapsedParents';

export function readCollapsedParents(storage: Pick<Storage, 'getItem'> = window.localStorage): string[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string'))];
  } catch {
    return [];
  }
}

export function writeCollapsedParents(ids: string[], storage: Pick<Storage, 'setItem'> = window.localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // 存储不可用时折叠只在当前会话生效。
  }
}

export function toggleCollapsedParent(ids: string[], parentId: string): string[] {
  return ids.includes(parentId) ? ids.filter((id) => id !== parentId) : [...ids, parentId];
}

export function useTaskCollapse() {
  const [collapsed, setCollapsed] = useState<string[]>(() => readCollapsedParents());
  const toggle = useCallback((parentId: string) => setCollapsed((current) => {
    const next = toggleCollapsedParent(current, parentId);
    writeCollapsedParents(next);
    return next;
  }), []);
  const expand = useCallback((parentId: string) => setCollapsed((current) => {
    if (!current.includes(parentId)) return current;
    const next = current.filter((id) => id !== parentId);
    writeCollapsedParents(next);
    return next;
  }), []);
  return { collapsed, toggle, expand };
}
