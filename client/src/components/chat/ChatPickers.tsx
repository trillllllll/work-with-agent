import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { History, Plus } from 'lucide-react';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import type { LibraryRow, Page } from '@/components/library/types.js';

type ConversationPage = { items: Array<{ id: string; title: string; createdAt: string }>; nextCursor: string | null };
export function ChatHistory({ busy, currentId, onSelect }: { busy: boolean; currentId: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const history = useInfiniteQuery({
    queryKey: ['assistant-history'], initialPageParam: '', enabled: open,
    queryFn: ({ pageParam }) => api<ConversationPage>(`/api/conversations${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (page) => page.nextCursor ?? undefined, staleTime: 0,
  });
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="历史对话" title="历史对话"><History /></Button></PopoverTrigger><PopoverContent data-assistant-floating align="end" className="w-80 max-w-[calc(100vw-2rem)] p-3">
    <h3 className="mb-2 text-sm font-semibold">历史对话</h3>
    {busy && <p className="mb-2 text-xs text-muted-foreground">当前回答结束或停止后可以切换。</p>}
    <div className="max-h-80 space-y-1 overflow-auto">
      {history.isLoading && <p role="status" className="p-2 text-xs">正在读取…</p>}
      {history.isError && <p role="alert" className="p-2 text-xs">读取失败。<button onClick={() => void history.refetch()}>重试</button></p>}
      {history.data?.pages.flatMap((page) => page.items).map((item) => <button key={item.id} disabled={busy} type="button" aria-current={currentId === item.id ? 'true' : undefined} className="block w-full rounded-lg p-2 text-left text-xs hover:bg-muted aria-[current=true]:bg-muted disabled:opacity-50" onClick={() => { onSelect(item.id); setOpen(false); }}><span className="block truncate">{item.title}</span><time className="mt-1 block text-[10px] text-muted-foreground">{new Date(item.createdAt).toLocaleDateString()}</time></button>)}
      {history.data?.pages[0]?.items.length === 0 && <p className="p-2 text-xs text-muted-foreground">还没有历史对话。</p>}
      {history.hasNextPage && <Button variant="ghost" size="sm" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>加载更多</Button>}
    </div>
  </PopoverContent></Popover>;
}

export function ChatReferencePicker({ selectedIds, onSelect }: { selectedIds: string[]; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const materials = useInfiniteQuery({ queryKey: ['assistant-reference-materials', query], enabled: open, initialPageParam: 0,
    queryFn: ({ signal, pageParam }) => api<Page<LibraryRow>>(`${query ? `/api/v1/library/search?q=${encodeURIComponent(query)}` : '/api/v1/library/materials?archived=exclude'}&limit=30&cursor=${pageParam}`, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button type="button" size="icon-sm" variant="ghost" aria-label="添加参考资料" title="添加参考资料"><Plus /></Button></PopoverTrigger><PopoverContent data-assistant-floating className="w-80 max-w-[calc(100vw-2rem)] p-3" side="top">
    <h3 className="mb-2 text-sm font-semibold">添加参考资料</h3>
    <input aria-label="搜索参考资料" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已保存的资料" className="mb-2 w-full rounded-lg border bg-transparent p-2 text-xs" />
    <p className="mb-2 text-[11px] text-muted-foreground">引用已保存的版本。未保存草稿需在编辑器里手动带入。</p>
    <div className="max-h-60 space-y-1 overflow-auto">
      {materials.isLoading && <p className="p-2 text-xs">正在读取…</p>}
      {materials.isError && <p role="alert" className="p-2 text-xs">资料读取失败。<button onClick={() => void materials.refetch()}>重试</button></p>}
      {materials.data?.pages.flatMap((page) => page.items).map((item) => <button type="button" key={item.id} className="block w-full truncate rounded-lg p-2 text-left text-xs hover:bg-muted disabled:opacity-50" onClick={() => { onSelect(item.id); setOpen(false); }}>{selectedIds.includes(item.id) ? '取消引用 · ' : ''}{item.title}</button>)}
      {materials.data?.pages[0]?.items.length === 0 && <p className="p-2 text-xs text-muted-foreground">没有匹配的资料。</p>}
      {materials.hasNextPage && <Button type="button" variant="ghost" size="sm" disabled={materials.isFetchingNextPage} onClick={() => void materials.fetchNextPage()}>加载更多资料</Button>}
    </div>
  </PopoverContent></Popover>;
}
