import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { MarkdownView } from '@/components/chat/MarkdownView.js';
import { cn } from '@/lib/utils.js';
import { lineDiff, skillSaveRequest, type FromApproval, type OpenSkillEditorDetail, type SkillDetail, type SkillDiffLine, type SkillDraftInput } from './skill-format.js';

export const SKILL_SAVED_EVENT = 'wwa-skill-saved';
export type SkillSavedDetail = { skillId: string; revision: number; approvalId?: string };

type EditorState = { draft: SkillDraftInput; fromApproval?: FromApproval; title: string };

export function DiffLines({ lines, label }: { lines: SkillDiffLine[]; label?: string }) {
  return (
    <div className="max-h-72 overflow-auto rounded-lg border bg-muted/30 font-mono text-[12px] leading-relaxed" aria-label={label ?? '正文对比'} data-testid="skill-line-diff">
      {lines.map((line, index) => (
        <div key={index} data-type={line.type} className={cn('whitespace-pre-wrap break-words px-2', line.type === 'add' && 'bg-green-500/15 text-green-800 dark:text-green-300', line.type === 'remove' && 'bg-red-500/15 text-red-800 line-through dark:text-red-300')}>
          <span aria-hidden="true" className="mr-2 select-none text-muted-foreground">{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</span>{line.text || ' '}
        </div>
      ))}
    </div>
  );
}

export function SkillEditor({ state, onClose }: { state: EditorState; onClose: () => void }) {
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
      const request = skillSaveRequest(draft, reason.trim() || (editing || state.fromApproval ? '' : '新建'), state.fromApproval);
      const saved = await api<SkillDetail>(request.path, { method: request.method, body: JSON.stringify(request.body) });
      await client.invalidateQueries({ queryKey: ['skills'] });
      await client.invalidateQueries({ queryKey: ['skill', saved.id] });
      if (state.fromApproval) await client.invalidateQueries({ queryKey: ['proposals'] });
      window.dispatchEvent(new CustomEvent<SkillSavedDetail>(SKILL_SAVED_EVENT, { detail: { skillId: saved.id, revision: saved.revision, ...(state.fromApproval ? { approvalId: state.fromApproval.approvalId } : {}) } }));
      toast.success(`技能已保存为 v${saved.revision}`);
      onClose();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'VERSION_CONFLICT' && draft.id) {
        setError('这个技能已被其他窗口修改，本次没有保存。');
        try { setConflict(await api<SkillDetail>(`/api/skills/${draft.id}`)); } catch { setConflict(null); }
      } else if (failure instanceof ApiError && failure.code === 'SKILL_NAME_TAKEN') {
        setError('已有同名技能，请换一个名称。');
      } else {
        setError(failure instanceof Error ? failure.message : '保存失败');
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

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent data-assistant-floating data-testid="skill-editor" surface="glass" className="flex max-h-[calc(100dvh-48px)] w-[min(760px,calc(100vw-32px))] max-w-none flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{state.title}</DialogTitle>
          <DialogDescription>{state.fromApproval ? '保存即表示你确认这份技能，会同时关闭对应的待确认方案。不保存直接关闭，方案保持待确认。' : editing ? `当前 v${draft.expectedRevision ?? ''}，保存后生成新版本。` : '新建后可以在技能页启用或停用。'}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="grid gap-1 text-sm">名称<Input aria-label="技能名称" maxLength={80} value={draft.name} onChange={(event) => set({ name: event.target.value.replace(/\n/g, ' ') })} /></label>
          <label className="grid gap-1 text-sm">描述（告诉助手什么时候用）<Textarea aria-label="技能描述" rows={2} maxLength={1024} value={draft.description} onChange={(event) => set({ description: event.target.value })} /></label>
          <div className="grid gap-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="flex-1">正文（Markdown）</span>
              <div role="group" aria-label="正文模式" className="flex gap-1">
                <Button type="button" aria-pressed={mode === 'edit'} size="xs" variant={mode === 'edit' ? 'secondary' : 'ghost'} onClick={() => setMode('edit')}>编辑</Button>
                <Button type="button" aria-pressed={mode === 'preview'} size="xs" variant={mode === 'preview' ? 'secondary' : 'ghost'} onClick={() => setMode('preview')}>预览</Button>
              </div>
            </div>
            {mode === 'edit'
              ? <Textarea aria-label="技能正文" rows={12} className="font-mono text-[13px]" value={draft.instructions} onChange={(event) => set({ instructions: event.target.value })} />
              : <div className="min-h-40 rounded-lg border p-3" data-testid="skill-editor-preview">{draft.instructions.trim() ? <MarkdownView content={draft.instructions} /> : <p className="text-muted-foreground">还没有正文</p>}</div>}
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="启用技能" checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} />启用（助手可以按需读取）</label>
          <label className="grid gap-1 text-sm">修改说明<Input aria-label="修改说明" placeholder={editing ? '例如：补充周五的检查步骤' : state.fromApproval ? '在编辑器中保存' : '新建'} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          {error && <div role="alert" className="grid gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <p>{error}</p>
            {conflict && <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" onClick={loadLatest}>载入最新（v{conflict.revision}）</Button><Button type="button" size="sm" variant="outline" aria-expanded={compare} onClick={() => setCompare((value) => !value)}>{compare ? '收起对比' : '对比我的改动'}</Button></div>}
            {conflict && compare && <div className="text-foreground"><p className="mb-1 text-xs text-muted-foreground">最新 v{conflict.revision} → 我的改动</p><DiffLines lines={lineDiff(conflict.instructions, draft.instructions)} /></div>}
          </div>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={busy || missing}>{busy ? '正在保存…' : '保存'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Mounted once in App so the chat panel can open the editor on any page. Opening never writes. */
export function SkillEditorHost() {
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
            toast.error(failure instanceof Error ? failure.message : '读取技能失败');
            return;
          }
        }
        const title = detail.fromApproval ? '在编辑器中修改' : draft.id ? `编辑技能：${draft.name}` : '新建技能';
        setGeneration((value) => value + 1);
        setState({ draft, fromApproval: detail.fromApproval, title });
      })();
    };
    window.addEventListener('wwa-open-skill-editor', open);
    return () => window.removeEventListener('wwa-open-skill-editor', open);
  }, []);
  if (!state) return null;
  return <SkillEditor key={generation} state={state} onClose={() => setState(null)} />;
}
