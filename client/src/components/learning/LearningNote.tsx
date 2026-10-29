import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, Save, Trash2, Pencil, BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { DescriptionEditor } from '@/components/tasks/DescriptionEditor.js';
import { MarkdownView } from '@/components/shared/MarkdownView.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { askAssistant, contextLabel } from '@/lib/assistant-context.js';
import { ApiError } from '@/lib/api.js';
import { submitCommands } from '@/lib/platform.js';
import { learningKey, learningWrite } from '@/lib/learning-api.js';
import { EditorRuntime } from '@/lib/task-editor-runtime.js';
import type { LearningNode, LearningMap } from './learning-model.js';
import { masteryStates } from './learning-model.js';
import { draftDirty, freshDraft, noteFields, readNoteDraft, rebaseDraft, storeNoteDraft, type NoteDraft, type NoteFields } from './note-draft.js';

export function LearningNote({ node, map, scope, onBack, onDelete, onAskAssistant, onPractice, path }: {
  node: LearningNode; map: LearningMap; scope: string; onBack: () => void; onDelete: () => void; onAskAssistant?: () => boolean | void;
  onPractice?: () => void; path?: string[];
}) {
  const { t } = useTranslation('learning');
  const client = useQueryClient();
  const [draft, setDraft] = useState(() => readNoteDraft(scope, node));
  const [editing, setEditing] = useState(() => draftDirty(readNoteDraft(scope, node)) || !node.detail.trim());
  const draftRef = useRef(draft); draftRef.current = draft;
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const [composing, setComposing] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const openDescription = useRef<() => void>(() => {});
  const dirty = draftDirty(draft);
  const conflict = dirty && node.revision !== draft.revision;
  const pending = Boolean(draft.pending);
  const changed = (values: Partial<NoteFields>) => setDraft(current => ({ ...current, ...values }));
  useEffect(() => { setStorageFailed(!storeNoteDraft(scope, node.id, draft)); }, [scope, node.id, draft]);
  useEffect(() => {
    setDraft(current => {
      // A retry after a lost response can observe the already committed snapshot.
      const input = current.pending?.command.input;
      if (input && node.revision > current.revision && Object.entries(input).every(([key,value]) => node[key as keyof NoteFields] === value)) return freshDraft(node);
      if (!draftDirty(current) && !current.pending && current.revision !== node.revision) return freshDraft(node);
      return current;
    });
  }, [node]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (draftDirty(draftRef.current) || draftRef.current.pending) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  async function save() {
    if (saveLock.current || EditorRuntime.current()?.scopeKey!==scope || composing || conflict && !draft.pending || !draft.title.trim() || draft.detail.length > 20000) return;
    saveLock.current = true; setSaving(true);
    const operation = draft.pending ?? { requestId: crypto.randomUUID(), command: { kind: 'learning.node.update', targetId: node.id, expectedRevision: draft.revision, input: noteFields(draft) } };
    const next: NoteDraft = { ...draft, pending: operation };
    setDraft(next); storeNoteDraft(scope, node.id, next);
    try {
      const result = await submitCommands([operation.command], operation.requestId);
      if (result.status !== 'applied') throw new Error(t('savePending'));
      const saved = result.results?.[0] as LearningNode | undefined;
      const clean = saved ? freshDraft(saved) : { ...freshDraft(node), ...noteFields(draft), base: noteFields(draft), revision: draft.revision + 1 };
      setDraft(clean); storeNoteDraft(scope,node.id,clean);
      await client.invalidateQueries({ queryKey: ['learning-map', map.id] });
      await client.invalidateQueries({ queryKey: ['learning-maps'] });
      toast.success(t('saved'));
      if(EditorRuntime.current()?.scopeKey===scope)void learningWrite('/resume', { requestId: crypto.randomUUID(), nodeId: node.id, reason: 'note_saved' }).then(()=>client.invalidateQueries({queryKey:learningKey(scope,'overview')})).catch(() => {});
    } catch (error) {
      // A definitive server rejection can be edited; uncertain network outcomes retry the same request ID.
      if (error instanceof ApiError && error.status!==401 && (error.status ?? 0) >= 400 && (error.status ?? 0) < 500) setDraft(current => ({ ...current, pending: undefined }));
      toast.error(error instanceof Error ? error.message : t('saveFailed'));
      void client.invalidateQueries({ queryKey: ['learning-map', map.id] });
    } finally { setSaving(false); saveLock.current = false; }
  }
  function attach(text?: string, intent?: 'explain' | 'example' | 'summarize') {
    if (onAskAssistant?.() === false) return;
    askAssistant({ kind: text === undefined ? 'draft' : 'selection', title: contextLabel(draft.title), text: text ?? draft.detail,
      learningMapId: map.id, learningNodeId: node.id, learningRevision: draft.revision, unsaved: dirty || pending,
      ...(intent ? { learningIntent: intent } : {}) }, intent ? { prompt: t(`workflow.prompts.${intent}`) } : undefined);
  }
  return <section className="mx-auto w-full max-w-4xl space-y-4" aria-label={t('note')}>
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" className="min-h-11" onClick={() => attach()} disabled={draft.detail.length > 20000}><MessageSquarePlus />{t('addContext')}</Button>
        <Button variant="outline" className="min-h-11" onClick={() => setEditing(value => !value)}>{editing ? <BookOpen /> : <Pencil />}{t(editing ? 'workflow.readNote' : 'workflow.editNote')}</Button>
        {(editing || dirty || pending) && <Button className="min-h-11" disabled={saving || composing || !dirty && !pending || conflict && !pending || !draft.title.trim() || draft.detail.length > 20000} onClick={() => void save()}><Save />{saving ? t('saving') : pending ? t('retrySave') : t('save')}</Button>}
      </div>
    </header>
    <p className="break-words text-xs text-muted-foreground">{[map.title, ...(path ?? [])].join(' / ')} · {t('revision', { revision: node.revision })}</p>
    {conflict && <div role="alert" className="space-y-3 rounded-lg border border-amber-400/40 bg-amber-500/5 p-3 text-sm"><p>{t('conflict')}</p><div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" disabled={saving} onClick={() => setDiscard(true)}>{t('loadLatest')}</Button><Button variant="outline" className="min-h-11" disabled={saving} onClick={() => setDraft(rebaseDraft(draft,node))}>{t('rebase')}</Button></div></div>}
    {pending && <p role="status" className="text-sm text-muted-foreground">{t('uncertain')}</p>}
    {storageFailed && <p role="alert" className="text-sm text-destructive">{t('storageFailed')}</p>}
    {editing ? <Input aria-label={t('noteTitle')} value={draft.title} maxLength={300} disabled={saving || pending} className="h-12 text-xl font-semibold md:text-xl" onChange={event => changed({ title: event.target.value })} /> : <h2 className="break-words text-xl font-semibold">{draft.title}</h2>}
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-3"><label htmlFor="learning-note-status">{t('mastery')}</label><Select value={draft.status} onValueChange={status => changed({ status })} disabled={saving || pending}><SelectTrigger id="learning-note-status" className="min-h-11 w-36" aria-label={t('mastery')}><SelectValue /></SelectTrigger><SelectContent>{masteryStates.map(state => <SelectItem key={state.id} value={state.id}>{state.symbol} {t(`status.${state.id}`)}</SelectItem>)}</SelectContent></Select></div>
      <span role="status">{dirty ? t('unsaved') : t('saved')} · {t('characters', { count: draft.detail.length })}</span>
    </div>
    <div className="flex flex-wrap gap-2">{(['explain','example','summarize'] as const).map(intent => <Button key={intent} variant="outline" className="min-h-11" onClick={() => attach(undefined, intent)}>{t(`workflow.actions.${intent}`)}</Button>)}{onPractice && <Button className="min-h-11" onClick={onPractice}>{t('workflow.actions.practice')}</Button>}</div>
    {editing ? <div className="learning-note-editor min-h-80 rounded-lg border p-4" data-testid="learning-note-editor">
      <DescriptionEditor taskId={`learning-note:${scope}:${node.id}`} value={draft.detail} readonly={saving || pending} fill={false} openDescription={openDescription}
        onEdit={detail => changed({ detail })} onComposeStart={() => setComposing(true)} onComposeEnd={() => setComposing(false)}
        onPasteImages={() => toast.info(t('imagesUnsupported'))} onZoom={() => {}} onAskSelection={text => attach(text)} />
    </div> : <div className="learning-note-reading min-h-48 rounded-lg border p-4 sm:p-6" data-testid="learning-note-reading"><MarkdownView content={draft.detail || t('workflow.emptyNote')} diagrams className="text-sm leading-7" /></div>}
    {draft.detail.length > 20000 && <p role="alert" className="text-sm text-destructive">{t('tooLong')}</p>}
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
      <Button variant="ghost" className="min-h-11" disabled={saving || !dirty && !pending} onClick={() => setDiscard(true)}>{t('discard')}</Button>
      <Button variant="ghost" className="min-h-11 text-destructive" disabled={saving} onClick={onDelete}><Trash2 />{t('deleteNode')}</Button>
    </footer>
    {discard && <ConfirmDialog title={t('discard')} itemName={draft.title} description={t('discardHint')} onCancel={() => setDiscard(false)} onConfirm={() => { setDraft(freshDraft(node)); setDiscard(false); }} />}
  </section>;
}
