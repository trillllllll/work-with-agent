import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { ApiError, api, type ChangeListItem, type ChangePage } from '@/lib/api.js';
import { usePageContext } from '@/lib/assistant-context.js';
import { markChangeUndone } from '@/lib/change-list-cache.js';
import { useHashRoute } from '@/hooks/useHashRoute.js';
import { useTodoActions } from '@/hooks/useTodo.js';
import { EMPTY_CHANGE_FILTERS, changeChips, filtersFromQuery, filtersToPageState, filtersToQueryPatch, hasActiveFilters, toChangeApiQuery, type ChangeDateRange, type ChangeFilters } from './change-filters.js';
import { ChangesFilters } from './ChangesFilters.js';
import { ChangesList } from './ChangesList.js';

export function ChangesPage() {
  const { t } = useTranslation('settings');
  const { query, setQuery } = useHashRoute();
  const filters = useMemo(() => filtersFromQuery(query), [query]);
  const filterKey = useMemo(() => JSON.stringify(filtersToQueryPatch(filters)), [filters]);
  // One clock for every page of this filter. `from` is part of the cursor fingerprint, so a fresh `Date` per request would reject the next page.
  const now = useMemo(() => new Date(), [filterKey]);
  const pageState = useMemo(() => filtersToPageState(filters, now), [filters, now]);
  const seenFilter = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const actions = useTodoActions();
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  usePageContext('changes', { pageState });
  useLayoutEffect(() => {
    if (seenFilter.current === null) { seenFilter.current = filterKey; return; }
    if (seenFilter.current === filterKey) return;
    seenFilter.current = filterKey;
    const scroller = document.querySelector<HTMLElement>('[data-page-scroll]');
    if (scroller) scroller.scrollTop = 0;
  }, [filterKey]);

  const list = useInfiniteQuery({
    queryKey: ['changes', 'page', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api<ChangePage>(`/api/changes?${toChangeApiQuery(filters, { cursor: pageParam, limit: 50, now })}`, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const cursorError = list.isFetchNextPageError && list.error instanceof ApiError && list.error.code === 'INVALID_CURSOR' ? list.error : null;
  const resetCursor = useRef<unknown>(null);
  useEffect(() => {
    if (!cursorError || resetCursor.current === cursorError) return;
    resetCursor.current = cursorError;
    void queryClient.resetQueries({ queryKey: ['changes', 'page', filters] });
  }, [cursorError, queryClient, filters]);

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const total = list.data?.pages[0]?.total ?? null;
  const connections = list.data?.pages[0]?.connections ?? [];
  const commitSearch = useCallback((q: string) => { setQuery({ q: filtersToQueryPatch({ ...EMPTY_CHANGE_FILTERS, q }).q }); }, [setQuery]);
  const commitList = useCallback((key: 'type' | 'op' | 'source' | 'status', values: string[]) => { setQuery({ [key]: values.length ? values.join(',') : null }); }, [setQuery]);
  const commitRange = useCallback((range: ChangeDateRange) => { setQuery({ range: range === 'all' ? null : range }); }, [setQuery]);
  const replaceFilters = useCallback((next: ChangeFilters) => { setQuery(filtersToQueryPatch(next)); }, [setQuery]);
  const filtersSummary = changeChips(filters, connections).map((chip) => t('changes.chip', { name: t(chip.nameKey), value: chip.valueKey ? t(chip.valueKey) : chip.valueText ?? '' })).join(', ');

  async function undo(item: ChangeListItem) {
    setPendingIds((current) => new Set(current).add(item.id));
    try {
      await actions.write(`/api/changes/${item.id}/undo`, 'POST', undefined, ['*', item.entityId], t('changes.undoneToast'));
      // write() already paints this row undone before it invalidates. Repeat after the refetch so a slow page cannot flash the old button.
      queryClient.setQueriesData<InfiniteData<ChangePage>>({ queryKey: ['changes', 'page'] }, (current) => markChangeUndone(current, item.id, new Date().toISOString()));
    } catch { /* write() toasts the server message and leaves this row clickable. */ }
    finally {
      setPendingIds((current) => { const next = new Set(current); next.delete(item.id); return next; });
    }
  }

  return <div className="min-h-full px-4 pt-5 pb-24 sm:px-8 sm:pt-7 lg:pb-7">
    <header className="border-b glass-divider pb-4">
      <div className="flex items-center gap-2"><History className="size-5 text-brand-link" /><div><span className="text-[11px] font-bold tracking-[0.13em] text-muted-foreground uppercase">{t('changes.eyebrow')}</span><h1 className="mt-1 text-2xl font-semibold tracking-tight">{t('changes.title')}</h1></div></div>
      <p className="mt-2 text-[13px] text-muted-foreground">{t('changes.description')}</p>
    </header>
    <ChangesFilters filters={filters} connections={connections} loaded={list.data ? items.length : null} total={total} onSearch={commitSearch} onList={commitList} onRange={commitRange} onReplace={replaceFilters} />
    <ChangesList
      items={items}
      total={total ?? 0}
      loading={list.isLoading}
      errorMessage={!list.data && list.isError ? (list.error instanceof Error ? list.error.message : t('changes.loadFailedFirst')) : ''}
      hasNextPage={Boolean(list.hasNextPage)}
      fetchingNextPage={list.isFetchingNextPage}
      nextPageError={list.isFetchNextPageError && !cursorError}
      filtered={hasActiveFilters(filters)}
      filtersSummary={filtersSummary}
      pendingIds={pendingIds}
      onRetry={() => { void list.refetch(); }}
      onRetryNext={() => { void list.fetchNextPage(); }}
      onLoadMore={() => { void list.fetchNextPage(); }}
      onClear={() => replaceFilters(EMPTY_CHANGE_FILTERS)}
      onUndo={(item) => { void undo(item); }}
    />
  </div>;
}
