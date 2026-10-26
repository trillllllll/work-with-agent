import { Input } from '@/components/ui/input.js';
import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useInfiniteQuery } from '@tanstack/react-query';
import { History, Plus } from 'lucide-react';
import { api } from '@/lib/api.js';
import { intlLocale } from '../../i18n/index.js';
import { Button } from '@/components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import type { LibraryRow, Page } from '@/components/library/types.js';

type ConversationPage = { items: Array<{ id: string; identityId?: string; title: string; createdAt: string }>; nextCursor: string | null };
export function ChatHistory({ busy, currentId, identityId = 'work', onSelect }: { busy: boolean; currentId: string; identityId?: string; onSelect: (id: string) => void }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const history = useInfiniteQuery({
    queryKey: ['assistant-history', identityId], initialPageParam: '', enabled: open,
    queryFn: ({ pageParam }) => api<ConversationPage>(`/api/conversations?identityId=${encodeURIComponent(identityId)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (page) => page.nextCursor ?? undefined, staleTime: 0,
  });
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t('chatPickers.history')} title={t('chatPickers.history')}><History /></Button></PopoverTrigger><PopoverContent data-assistant-floating align="end" className="w-80 max-w-[calc(100vw-2rem)] p-3">
    <h3 className="mb-2 text-sm font-semibold">{t('chatPickers.history')}</h3>
    {busy && <p className="mb-2 text-xs text-muted-foreground">{t('chatPickers.switchLater')}</p>}
    <div className="max-h-80 space-y-1 overflow-auto">
      {history.isLoading && <p role="status" className="p-2 text-xs">{t('chatPickers.loading')}</p>}
      {history.isError && <p role="alert" className="p-2 text-xs"><Trans t={t} i18nKey="chatPickers.historyLoadFailed" components={{ retry: <Button variant="plain" size="bare" onClick={() => void history.refetch()} /> }} /></p>}
      {history.data?.pages.flatMap((page) => page.items).map((item) => <Button variant="row" size="bare" key={item.id} disabled={busy} type="button" aria-current={currentId === item.id ? 'true' : undefined} className="block w-full rounded-lg p-2 text-left text-xs aria-[current=true]: disabled:opacity-50" onClick={() => { onSelect(item.id); setOpen(false); }}><span className="block truncate">{item.title}</span><time className="mt-1 block text-[10px] text-muted-foreground">{new Date(item.createdAt).toLocaleDateString(intlLocale())}</time></Button>)}
      {history.data?.pages[0]?.items.length === 0 && <p className="p-2 text-xs text-muted-foreground">{t('chatPickers.emptyHistory')}</p>}
      {history.hasNextPage && <Button variant="ghost" size="sm" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{t('chatPickers.loadMore')}</Button>}
    </div>
  </PopoverContent></Popover>;
}

export function ChatReferencePicker({ selectedIds, onSelect }: { selectedIds: string[]; onSelect: (id: string) => void }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const materials = useInfiniteQuery({ queryKey: ['assistant-reference-materials', query], enabled: open, initialPageParam: 0,
    queryFn: ({ signal, pageParam }) => api<Page<LibraryRow>>(`${query ? `/api/v1/library/search?q=${encodeURIComponent(query)}` : '/api/v1/library/materials?archived=exclude'}&limit=30&cursor=${pageParam}`, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button type="button" size="icon-sm" variant="ghost" aria-label={t('chatPickers.addReference')} title={t('chatPickers.addReference')}><Plus /></Button></PopoverTrigger><PopoverContent data-assistant-floating className="w-80 max-w-[calc(100vw-2rem)] p-3" side="top">
    <h3 className="mb-2 text-sm font-semibold">{t('chatPickers.addReference')}</h3>
    <Input variant="inline" aria-label={t('chatPickers.searchReferences')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('chatPickers.searchSaved')} className="mb-2 w-full rounded-lg border bg-transparent p-2 text-xs" />
    <p className="mb-2 text-[11px] text-muted-foreground">{t('chatPickers.savedVersionHint')}</p>
    <div className="max-h-60 space-y-1 overflow-auto">
      {materials.isLoading && <p className="p-2 text-xs">{t('chatPickers.loading')}</p>}
      {materials.isError && <p role="alert" className="p-2 text-xs"><Trans t={t} i18nKey="chatPickers.materialsLoadFailed" components={{ retry: <Button variant="plain" size="bare" onClick={() => void materials.refetch()} /> }} /></p>}
      {materials.data?.pages.flatMap((page) => page.items).map((item) => <Button variant="row" size="bare" type="button" key={item.id} className="block w-full truncate rounded-lg p-2 text-left text-xs disabled:opacity-50" onClick={() => { onSelect(item.id); setOpen(false); }}>{selectedIds.includes(item.id) ? t('chatPickers.cancelReference', { title: item.title }) : item.title}</Button>)}
      {materials.data?.pages[0]?.items.length === 0 && <p className="p-2 text-xs text-muted-foreground">{t('chatPickers.noMaterials')}</p>}
      {materials.hasNextPage && <Button type="button" variant="ghost" size="sm" disabled={materials.isFetchingNextPage} onClick={() => void materials.fetchNextPage()}>{t('chatPickers.loadMoreMaterials')}</Button>}
    </div>
  </PopoverContent></Popover>;
}
