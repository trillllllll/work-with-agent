import { Checkbox } from '@/components/ui/checkbox.js';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';

export type Evidence = { type: 'material' | 'memory' | 'task'; id: string; revision: number; hash?: string };
export function ContextPicker({ topicId, selected, onChange, memories = false }: { topicId: string | null; selected: Evidence[]; onChange: (value: Evidence[]) => void; memories?: boolean }) {
  const { t } = useTranslation('workspace');
  return <fieldset className="space-y-2 rounded-lg border p-3"><legend className="px-1 text-sm">{t('contextPicker.legend')}</legend><SourceList type="material" topicId={topicId} selected={selected} onChange={onChange} />{memories && <SourceList type="memory" topicId={topicId} selected={selected} onChange={onChange} />}{selected.length > 0 && <p className="text-xs text-muted-foreground">{t('contextPicker.selectedCount', { count: selected.length })}</p>}</fieldset>;
}
function SourceList({ type, topicId, selected, onChange }: { type: 'material' | 'memory'; topicId: string | null; selected: Evidence[]; onChange: (value: Evidence[]) => void }) {
  const { t } = useTranslation('workspace');
  const query = useInfiniteQuery({ queryKey: ['context-picker', type, topicId], initialPageParam: 0, queryFn: ({ pageParam }) => api<{ items: any[]; nextCursor: number | null }>(`/api/v1/knowledge/${type === 'material' ? 'materials' : 'memories'}?topicId=${encodeURIComponent(topicId ?? 'inbox')}&cursor=${pageParam}&limit=100`), getNextPageParam: (page) => page.nextCursor ?? undefined });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const versionKey = type === 'material' ? 'contextPicker.materialVersion' : 'contextPicker.memoryVersion';
  const staleKey = type === 'material' ? 'contextPicker.materialVersionStale' : 'contextPicker.memoryVersionStale';
  return <div className="space-y-2">{query.error && <p role="alert" className="text-xs">{query.error.message}</p>}{items.map((item) => <label key={item.id} className="flex items-start gap-2 text-sm"><Checkbox className="mt-1"  checked={selected.some((ref) => ref.type === type && ref.id === item.id)} disabled={type === 'memory' && item.health !== 'current'} onChange={(event) => onChange(event.target.checked ? [...selected.filter((ref) => ref.type !== type || ref.id !== item.id), { type, id: item.id, revision: item.revision, ...(item.contentHash ? { hash: item.contentHash } : {}) }] : selected.filter((ref) => ref.type !== type || ref.id !== item.id))} /><span className="min-w-0 break-words">{item.title}<span className="ml-2 text-xs text-muted-foreground">{t(item.health && item.health !== 'current' ? staleKey : versionKey, { revision: item.revision })}</span></span></label>)}{!query.isLoading && !items.length && <p className="text-xs text-muted-foreground">{t(type === 'material' ? 'contextPicker.emptyMaterial' : 'contextPicker.emptyMemory')}</p>}{query.hasNextPage && <Button type="button" size="sm" variant="ghost" onClick={() => void query.fetchNextPage()}>{t('contextPicker.loadMore')}</Button>}</div>;
}
