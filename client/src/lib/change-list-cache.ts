import type { InfiniteData } from '@tanstack/react-query';
import type { ChangePage } from './api.js';

/** Mark one loaded row undone. A row that already has `undoneAt` keeps the server time. */
export function markChangeUndone(data: InfiniteData<ChangePage> | undefined, id: string, undoneAt: string): InfiniteData<ChangePage> | undefined {
  if (!data?.pages) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    if (!page?.items) return page;
    let pageChanged = false;
    const items = page.items.map((item) => {
      if (item.id !== id || item.undoneAt) return item;
      pageChanged = true;
      changed = true;
      return { ...item, undoneAt, canUndo: false, undoBlockedReason: { code: 'CHANGE_ALREADY_UNDONE' as const, reason: 'already_undone' as const } };
    });
    return pageChanged ? { ...page, items } : page;
  });
  return changed ? { ...data, pages } : data;
}
