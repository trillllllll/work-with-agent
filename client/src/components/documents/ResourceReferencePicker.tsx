import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.js';
import { api } from '@/lib/api.js';
import { kindLabel, type LibraryRow, type Page } from '@/components/library/types.js';
import type { DraftBlock, DraftContent } from '@/lib/documents/types.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';

export function insertResourceReference(content: DraftContent, reference: DraftBlock, bookmark?: string): DraftContent | null {
  if (typeof content === 'string') return null;
  if (!bookmark) return { ...content, blocks: [...content.blocks, reference] };
  let inserted = false;
  const visit = (blocks: DraftBlock[]): DraftBlock[] => blocks.flatMap((block) => {
    if (block.id === bookmark) { inserted = true; return [block, reference]; }
    if ('children' in block && block.children) return [{ ...block, children: visit(block.children) }];
    return [block];
  });
  const blocks = visit(content.blocks);
  return inserted ? { ...content, blocks } : null;
}

export function ResourceReferencePicker({ onSelect, onClose }: { onSelect: (resourceId: string, revision: number) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation('library');
  const scope = useEditorRuntime()?.scopeKey;
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [composing, setComposing] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (composing) return; const timer = setTimeout(() => { setSubmitted(query.trim()); setCursor(0); }, 200); return () => clearTimeout(timer); }, [query, composing]);
  const page = useQuery({ queryKey: ['library', 'resource-reference-picker', scope, submitted, cursor], queryFn: ({ signal }) => api<Page<LibraryRow>>(`/api/v1/library/${submitted ? `search?q=${encodeURIComponent(submitted)}&` : 'materials?'}limit=40&cursor=${cursor}`, { signal }), enabled: Boolean(scope), retry: false });
  const choose = async (row: LibraryRow) => { if (busy) return; setBusy(true); setError(''); try { await onSelect(row.id, row.revision); onClose(); } catch (failure) { setError(failure instanceof Error ? failure.message : t('shared.actionFailed')); } finally { setBusy(false); } };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="max-w-xl"><DialogTitle>{t('document.reuse')}</DialogTitle><DialogDescription>{t('document.reuseDescription')}</DialogDescription><Input autoFocus value={query} aria-label={t('shared.searchMaterials')} placeholder={t('shared.searchPlaceholder')} onChange={(event) => setQuery(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />{(error || page.error) && <p role="alert">{error || page.error?.message}</p>}<div className="max-h-[55vh] overflow-auto">{page.isLoading && <p role="status">{t('document.loading')}</p>}{page.data?.items.length === 0 && <p className="library-meta">{t('document.noResources')}</p>}{page.data?.items.map((row) => <Button key={row.id} variant="row" size="bare" disabled={busy} className="flex w-full items-center justify-between gap-3 p-3 text-left" onClick={() => { void choose(row); }}><span className="min-w-0 truncate">{row.title}</span><span className="library-meta">{kindLabel(row.kind)} · v{row.revision}</span></Button>)}</div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={cursor === 0 || busy} onClick={() => setCursor(Math.max(0, cursor - 40))}>{t('shared.previousPage')}</Button><Button variant="outline" size="sm" disabled={page.data?.nextCursor == null || busy} onClick={() => setCursor(page.data?.nextCursor ?? 0)}>{t('shared.nextPage')}</Button><Button className="ml-auto" variant="ghost" size="sm" disabled={busy} onClick={onClose}>{t('shared.cancel')}</Button></div></DialogContent></Dialog>;
}
