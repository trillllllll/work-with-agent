import { Checkbox } from '@/components/ui/checkbox.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { BodyText } from '@/components/shared/BodyText.js';
import { cn } from '@/lib/utils.js';
import { lineDiff, skillSaveRequest, type FromApproval, type OpenSkillEditorDetail, type SkillDetail, type SkillDiffLine, type SkillDraftInput } from './skill-format.js';

export const SKILL_SAVED_EVENT = 'dovun-skill-saved';
export type SkillSavedDetail = { skillId: string; revision: number; approvalId?: string };

type EditorState = { draft: SkillDraftInput; fromApproval?: FromApproval; title: string };

export function DiffLines({ lines, label }: { lines: SkillDiffLine[]; label?: string }) {
  const { t } = useTranslation('skills');
  return (
    <div className="max-h-72 min-w-0 max-w-full overflow-auto rounded-lg border bg-muted/30 font-mono text-[12px] leading-relaxed" aria-label={label ?? t('editor.diffLabel')} data-testid="skill-line-diff">
      {lines.map((line, index) => (
        <div key={index} data-type={line.type} className={cn('whitespace-pre-wrap break-words px-2', line.type === 'add' && 'bg-green-500/15 text-green-800 dark:text-green-300', line.type === 'remove' && 'bg-red-500/15 text-red-800 line-through dark:text-red-300')}>
          <span aria-hidden="true" className="mr-2 select-none text-muted-foreground">{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</span>{line.text || ' '}
        </div>
      ))}
    </div>
  );
}

export function SkillEditor({ state, onClose }: { state: EditorState; onClose: () => void }) {
  const { t } = useTranslation('skills');
  const client = useQueryClient();
  const [draft, setDraft] = useState<SkillDraftInput>(state.draft);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<SkillDetail | null>(null);
  const [compare, setCompare] = useState(false);
  const editing = Boolean(draft.id);
  const missing = !draft.name.trim() || !draft.description.trim() || !draft.instructions.trim();
  const set = (patch: Partial<SkillDraftInput>) => setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    if (missing || busy) return;
    setBusy(true);
    setError('');
    try {
      const request = skillSaveRequest(draft, reason.trim() || (editing || state.fromApproval ? '' : t('editor.defaultReason')), state.fromApproval);
      const saved = await api<SkillDetail>(request.path, { method: request.method, body: JSON.stringify(request.body) });
      await client.invalidateQueries({ queryKey: ['skills'] });
      await client.invalidateQueries({ queryKey: ['skill', saved.id] });
      if (state.fromApproval) await client.invalidateQueries({ queryKey: ['proposals'] });
      window.dispatchEvent(new CustomEvent<SkillSavedDetail>(SKILL_SAVED_EVENT, { detail: { skillId: saved.id, revision: saved.revision, ...(state.fromApproval ? { approvalId: state.fromApproval.approvalId } : {}) } }));
      toast.success(t('editor.saved', { revision: saved.revision }));
      onClose();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'VERSION_CONFLICT' && draft.id) {
        setError(t('editor.conflict'));
        try { setConflict(await api<SkillDetail>(`/api/skills/${draft.id}`)); } catch { setConflict(null); }
      } else if (failure instanceof ApiError && failure.code === 'SKILL_NAME_TAKEN') {
        setError(t('editor.nameTaken'));
      } else {
        setError(failure instanceof Error ? failure.message : t('editor.saveFailed'));
      }
    } finally { setBusy(false); }
  };

  const loadLatest = () => {
    if (!conflict) return;
    setDraft({ id: conflict.id, name: conflict.name, description: conflict.description, instructions: conflict.instructions, enabled: conflict.enabled, expectedRevision: conflict.revision });
    setConflict(null);
    setCompare(false);
    setError('');
  };

  const description = state.fromApproval
    ? t('editor.confirmClosesProposal')
    : editing
      ? t('editor.editingHint', { revision: draft.expectedRevision ?? '' })
      : t('editor.createHint');
  const reasonPlaceholder = editing ? t('editor.reasonPlaceholderEdit') : state.fromApproval ? t('editor.reasonPlaceholderProposal') : t('editor.reasonPlaceholderCreate');

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent data-assistant-floating data-testid="skill-editor" surface="glass" className="flex max-h-[calc(100dvh-48px)] w-[min(760px,calc(100vw-32px))] max-w-none flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{state.title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="grid gap-1 text-sm">{t('editor.name')}<Input aria-label={t('editor.nameLabel')} maxLength={80} value={draft.name} onChange={(event) => set({ name: event.target.value.replace(/\n/g, ' ') })} /></label>
          <label className="grid gap-1 text-sm">{t('editor.description')}<Textarea aria-label={t('editor.descriptionLabel')} rows={2} maxLength={1024} value={draft.description} onChange={(event) => set({ description: event.target.value })} /></label>
          <div className="grid gap-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="flex-1">{t('editor.body')}</span>
              <div role="group" aria-label={t('editor.bodyMode')} className="flex gap-1">
                <Button type="button" aria-pressed={mode === 'edit'} size="xs" variant={mode === 'edit' ? 'secondary' : 'ghost'} onClick={() => setMode('edit')}>{t('editor.edit')}</Button>
                <Button type="button" aria-pressed={mode === 'preview'} size="xs" variant={mode === 'preview' ? 'secondary' : 'ghost'} onClick={() => setMode('preview')}>{t('editor.preview')}</Button>
              </div>
            </div>
            {mode === 'edit'
              ? <Textarea aria-label={t('editor.bodyLabel')} rows={12} className="font-mono text-[13px]" value={draft.instructions} onChange={(event) => set({ instructions: event.target.value })} />
              : <div className="min-h-40 rounded-lg border p-3" data-testid="skill-editor-preview">{draft.instructions.trim() ? <BodyText text={draft.instructions} format="markdown" /> : <p className="text-muted-foreground">{t('editor.emptyBody')}</p>}</div>}
          </div>
          <label className="flex items-center gap-2 text-sm"><Checkbox  aria-label={t('editor.enableLabel')} checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} />{t('editor.enableHint')}</label>
          <label className="grid gap-1 text-sm">{t('editor.reason')}<Input aria-label={t('editor.reasonLabel')} placeholder={reasonPlaceholder} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          {error && <div role="alert" className="grid gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <p>{error}</p>
            {conflict && <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" onClick={loadLatest}>{t('editor.loadLatest', { revision: conflict.revision })}</Button><Button type="button" size="sm" variant="outline" aria-expanded={compare} onClick={() => setCompare((value) => !value)}>{compare ? t('editor.hideCompare') : t('editor.compareMine')}</Button></div>}
            {conflict && compare && <div className="text-foreground"><p className="mb-1 text-xs text-muted-foreground">{t('editor.compareCaption', { revision: conflict.revision })}</p><DiffLines lines={lineDiff(conflict.instructions, draft.instructions)} /></div>}
          </div>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('action.cancel')}</Button>
            <Button type="submit" disabled={busy || missing}>{busy ? t('action.saving') : t('action.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Mounted once in App so the chat panel can open the editor on any page. Opening never writes. */
export function SkillEditorHost() {
  const { t } = useTranslation('skills');
  const [state, setState] = useState<EditorState | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<OpenSkillEditorDetail>).detail ?? {};
      void (async () => {
        let draft: SkillDraftInput = { name: '', description: '', instructions: '', enabled: false, ...detail.draft };
        if (detail.skillId) {
          try {
            const current = await api<SkillDetail>(`/api/skills/${detail.skillId}`);
            draft = { id: current.id, name: current.name, description: current.description, instructions: current.instructions, enabled: current.enabled, expectedRevision: current.revision, ...detail.draft };
          } catch (failure) {
            toast.error(failure instanceof Error ? failure.message : t('editor.readFailed'));
            return;
          }
        }
        const title = detail.fromApproval ? t('editor.editProposal') : draft.id ? t('editor.editNamed', { name: draft.name }) : t('editor.create');
        setGeneration((value) => value + 1);
        setState({ draft, fromApproval: detail.fromApproval, title });
      })();
    };
    window.addEventListener('dovun-open-skill-editor', open);
    return () => window.removeEventListener('dovun-open-skill-editor', open);
  }, [t]);
  if (!state) return null;
  return <SkillEditor key={generation} state={state} onClose={() => setState(null)} />;
}
