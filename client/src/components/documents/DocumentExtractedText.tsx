import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { BodyText } from '@/components/shared/BodyText.js';
import { formatLocator, type MaterialChunk, type Page } from '@/components/library/types.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';

/** Exact source locations remain readable without loading every earlier page of extraction. */
export function DocumentExtractedText({ resourceId, revision, chunkId }: { resourceId: string; revision: number; chunkId?: string | null }) {
  const { t } = useTranslation('library');
  const scope = useEditorRuntime()?.scopeKey;
  const [cursor, setCursor] = useState(0);
  const [items, setItems] = useState<MaterialChunk[]>([]);
  const chunk = useQuery({ queryKey: ['library', 'document-chunk', scope, chunkId], queryFn: ({ signal }) => api<MaterialChunk>(`/api/v1/library/chunks/${encodeURIComponent(chunkId!)}`, { signal }), enabled: Boolean(scope && chunkId), retry: false });
  const page = useQuery({ queryKey: ['library', 'document-extracted', scope, resourceId, revision, cursor], queryFn: ({ signal }) => api<Page<MaterialChunk>>(`/api/v1/library/materials/${encodeURIComponent(resourceId)}/content?revision=${revision}&cursor=${cursor}&limit=40`, { signal }), enabled: Boolean(scope), retry: false });
  const selected = chunk.data?.materialId === resourceId && chunk.data.revision === revision ? chunk.data : null;
  useEffect(() => { if (page.data) setItems((current) => { const seen = new Set(current.map((item) => item.id)); return [...current, ...page.data.items.filter((item) => !seen.has(item.id))]; }); }, [page.data]);
  const shown = selected ? [selected, ...items.filter((item) => item.id !== selected.id)] : items;
  return <div className="document-extracted">
    {page.error && <p role="alert">{page.error.message}</p>}
    {chunkId && chunk.error && <p role="alert">{chunk.error.message}</p>}
    {shown.map((item) => <section key={item.id} className={item.id === selected?.id ? 'document-evidence-selected' : ''} data-testid={`library-chunk-${item.id}`} data-highlighted={item.id === selected?.id ? 'true' : 'false'}><p className="library-meta">{formatLocator(item.locator)}</p><BodyText text={item.text} /></section>)}
    {page.data?.nextCursor != null && <Button variant="outline" size="sm" disabled={page.isFetching} onClick={() => setCursor(page.data!.nextCursor!)}>{t('libraryPreview.loadMore')}</Button>}
  </div>;
}
