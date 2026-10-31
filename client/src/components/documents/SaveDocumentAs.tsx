import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { NativeSelect } from '@/components/ui/native-select.js';
import { canSaveDocumentAs, pendingSaveAs, saveAsFormats, saveDocumentAs, type SaveAsFormat } from '@/lib/documents/save-as.js';
import type { DocumentSnapshot, ResourceDocument } from '@/lib/documents/types.js';
import type { DocumentSession } from '@/lib/documents/session.js';
import { openDocument } from './open.js';

/**
 * Save-as state and dialog. The caller places the entry point (a menu item) and renders `dialog` outside any
 * menu, so the dialog stays mounted after the menu closes.
 */
export function useSaveDocumentAs({ scopeKey, resource, snapshot, session }: { scopeKey: string; resource?: ResourceDocument; snapshot?: DocumentSnapshot; session: DocumentSession | null }) {
  const { t } = useTranslation('library'); const client = useQueryClient();
  const [source, setSource] = useState<ResourceDocument | null>(null);
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [locked, setLocked] = useState(false);
  const [format, setFormat] = useState<SaveAsFormat>('markdown'); const [title, setTitle] = useState(''); const [error, setError] = useState('');
  const formats = saveAsFormats(open ? source ?? undefined : resource); const eligible = canSaveDocumentAs(resource, snapshot);
  const ready = (selected = resource) => { session?.flushEditors(); return canSaveDocumentAs(selected, session?.getSnapshot() ?? snapshot); };
  const show = () => {
    if (!resource || !ready()) { toast.error(t('document.saveAsSaveFirst')); return; }
    try {
      const pending = pendingSaveAs(scopeKey, resource);
      setFormat(pending?.format ?? formats[0]); setTitle(pending?.title ?? `${resource.title.slice(0, 280)} — ${t('document.copySuffix')}`);
      setSource(resource); setLocked(Boolean(pending)); setError(''); setOpen(true);
    } catch (failure) { toast.error(failure instanceof Error ? failure.message : t('shared.actionFailed')); }
  };
  const save = async () => {
    if (!source || busy || !title.trim()) return;
    if (!ready(source)) { setError(t('document.saveAsSaveFirst')); return; }
    setBusy(true); setError('');
    try {
      const created = await saveDocumentAs(scopeKey, source, format, title);
      setOpen(false); void client.invalidateQueries({ queryKey: ['library'] });
      openDocument({ resourceId: created.id, title: created.title });
    } catch (failure) {
      try { setLocked(Boolean(pendingSaveAs(scopeKey, source))); } catch { setLocked(true); }
      setError(failure instanceof Error ? failure.message : t('shared.actionFailed'));
    } finally { setBusy(false); }
  };
  if (!resource || !formats.length) return { available: false, eligible: false, show, dialog: null, conversionSource: null };
  const dialog = <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}><DialogContent className="max-w-lg">
      <DialogTitle>{t('document.saveAs')}</DialogTitle>
      <DialogDescription>{t('document.saveAsDescription', { revision: source?.revision ?? resource.revision })}</DialogDescription>
      <Input aria-label={t('document.saveAsTitle')} maxLength={300} value={title} disabled={busy || locked} onChange={(event) => setTitle(event.target.value)} />
      <NativeSelect aria-label={t('document.saveAsFormat')} value={format} disabled={busy || locked} onChange={(event) => setFormat(event.target.value as SaveAsFormat)}>{formats.map((item) => <option key={item} value={item}>{item === 'markdown' ? 'Markdown' : t('kind.text')}</option>)}</NativeSelect>
      <p className="text-sm" data-testid="document-conversion-loss">{t((source ?? resource).format === 'richdoc-v1' ? format === 'markdown' ? 'document.saveAsRichMarkdownLoss' : 'document.saveAsRichTextLoss' : (source ?? resource).format === 'markdown' ? 'document.saveAsMarkdownTextLoss' : 'document.saveAsTextMarkdownLoss')}</p>
      {locked && <p role="status" className="text-sm">{t('document.saveAsPending')}</p>}
      {error && <p role="alert" className="text-sm">{error}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{t('shared.cancel')}</Button><Button disabled={busy || !title.trim()} onClick={() => { void save(); }}>{t(busy ? 'document.saveAsCreating' : locked ? 'document.retry' : 'document.saveAsConfirm')}</Button></div>
    </DialogContent></Dialog>;
  const conversionSource = resource.conversionSource ? { revision: resource.conversionSource.revision, open: () => openDocument({ resourceId: resource.conversionSource!.resourceId, revision: resource.conversionSource!.revision }) } : null;
  return { available: true, eligible, show, dialog, conversionSource };
}
