import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.js';
import { getDocumentRegistry } from '@/lib/documents/runtime.js';
import { isPristineDraft } from '@/lib/documents/session.js';
import type { DocumentDraft } from '@/lib/documents/types.js';
import { documentTabs } from './open.js';

export function LocalDocumentDrafts({ scopeKey }: { scopeKey: string }) {
  const { t } = useTranslation('library');
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<DocumentDraft[]>([]);
  const [error, setError] = useState('');
  const show = async () => {
    setOpen(true); setError('');
    try { setDrafts((await getDocumentRegistry(scopeKey).listDrafts()).filter((draft) => !isPristineDraft(draft) && (!draft.resourceId || draft.editSeq !== draft.confirmedSeq || draft.pending || draft.blocked || draft.conflict || draft.organizationPending || draft.title !== draft.confirmedTitle)).sort((a, b) => b.updatedAt - a.updatedAt)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t('shared.actionFailed')); }
  };
  return <><Button size="sm" variant="ghost" disabled={!scopeKey} onClick={() => { void show(); }}>{t('document.localDrafts')}</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogTitle>{t('document.localDrafts')}</DialogTitle><DialogDescription>{t('document.draftsDescription')}</DialogDescription>{error && <p role="alert">{error}</p>}<div className="max-h-[60vh] overflow-auto space-y-3">{!drafts.length && !error && <p className="library-meta">{t('document.noDrafts')}</p>}{drafts.map((draft) => <div key={`${draft.localId}:${draft.sessionId}`} className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate">{draft.title}</p><p className="text-xs text-muted-foreground">{new Date(draft.updatedAt).toLocaleString()}</p></div><Button size="sm" variant="outline" onClick={() => { void getDocumentRegistry(scopeKey).restoreLocalDraft(draft.localId, draft.sessionId).then((session) => { documentTabs.open(scopeKey, { resourceId: session.getSnapshot().localId, title: session.getSnapshot().title }); setOpen(false); }).catch((failure) => toast.error(failure instanceof Error ? failure.message : t('shared.actionFailed'))); }}>{t('document.recover')}</Button></div>)}</div></DialogContent></Dialog></>;
}
