import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { CalendarDays, Flag, Hash, X } from 'lucide-react';
import { priorities, type Tag, type Task, type TaskPriority } from '@/lib/api.js';
import { draftPatch, isCompositionKey, localDate, mergeTaskDraft, taskDraft, type TaskDraft } from '@/lib/todo.js';
import { useTask } from '@/hooks/useTodo.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { cn } from '@/lib/utils.js';

type Editing = { base: TaskDraft; draft: TaskDraft; conflicts: string[] };
export type TaskDetailHandle = { requestTransition: (action: () => void) => void };
const fieldLabels: Record<string, string> = { title: '标题', description: '说明', status: '状态', priority: '优先级', dueDate: '截止日期', resultSummary: '结果摘要', topicId: '所属清单', parentId: '父任务', tagIds: '标签' };
const flagTone: Record<TaskPriority, string> = { none: 'text-muted-foreground', low: 'text-primary', medium: 'text-warning', high: 'text-destructive' };

function shiftDate(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDate(date);
}
function inEditor(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('[data-task-editor]'));
}
function stopDrag(event: { stopPropagation: () => void }) { event.stopPropagation(); }

type EditContext = {
  draft: TaskDraft;
  readonly: boolean;
  tags: Tag[];
  conflicts: string[];
  acknowledge: boolean;
  setAcknowledge: (value: boolean) => void;
  updateText: (patch: Partial<Pick<TaskDraft, 'title' | 'description'>>) => void;
  onTextBlur: (event: FocusEvent<HTMLElement>) => void;
  onTitleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onComposeStart: () => void;
  onComposeEnd: () => void;
  setPriority: (priority: TaskPriority) => void;
  setDue: (dueDate: string | null) => void;
  toggleTag: (id: string, checked: boolean) => void;
  resetDraft: () => void;
  requestClose: () => void;
};
const EditContext = createContext<EditContext | null>(null);
function useEdit() {
  const value = useContext(EditContext);
  if (!value) throw new Error('任务编辑尚未展开');
  return value;
}

type Props = {
  id: string;
  fallback: Task;
  tags: Tag[];
  readonly?: boolean;
  onSave: (task: Task, patch: Partial<TaskDraft>) => Promise<Task | undefined>;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  children: ReactNode;
};

export const TaskExpand = forwardRef<TaskDetailHandle, Props>(function TaskExpand({ id, fallback, tags, readonly = false, onSave, onClose, onDirtyChange, children }, ref) {
  const query = useTask(id);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  const [acknowledgeConflict, setAcknowledgeConflict] = useState(false);
  const seeded = useRef(false);
  const composing = useRef(false);
  const flushOnNull = useRef(false);
  const flushTimer = useRef(0);
  const savingCount = useRef(0);
  const pending = useRef<(() => void) | null>(null);
  const editingRef = useRef(editing);
  const taskRef = useRef(query.data ?? fallback);
  const acknowledgeRef = useRef(acknowledgeConflict);
  const dirtyRef = useRef(false);
  const onSaveRef = useRef(onSave);
  const onCloseRef = useRef(onClose);
  editingRef.current = editing;
  taskRef.current = query.data ?? fallback;
  acknowledgeRef.current = acknowledgeConflict;
  onSaveRef.current = onSave;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (query.data || seeded.current) return;
    seeded.current = true;
    const incoming = taskDraft(fallback);
    setEditing({ base: incoming, draft: incoming, conflicts: [] });
  }, [query.data, fallback]);

  useEffect(() => {
    if (!query.data) return;
    const incoming = taskDraft(query.data);
    setEditing((current) => {
      if (!current) return { base: incoming, draft: incoming, conflicts: [] };
      const merged = mergeTaskDraft(current.base, current.draft, incoming);
      return { base: incoming, draft: merged.draft, conflicts: [...new Set([...current.conflicts, ...merged.conflicts])] };
    });
  }, [query.data]);

  const dirty = Boolean(editing && (editing.draft.title !== editing.base.title || editing.draft.description !== editing.base.description || editing.conflicts.length > 0));
  dirtyRef.current = dirty;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);

  const finishPending = () => {
    const next = pending.current;
    if (!next || savingCount.current) return;
    pending.current = null;
    if (dirtyRef.current) setLeaveAction(() => next);
    else next();
  };
  const runSave = async (patch: Partial<TaskDraft>) => {
    const current = taskRef.current;
    if (!current || !Object.keys(patch).length) return undefined;
    savingCount.current += 1;
    setSaving(true);
    try {
      const result = await onSaveRef.current(current, patch);
      if (result) {
        const incoming = taskDraft(result);
        const currentEdit = editingRef.current;
        const merged = currentEdit ? mergeTaskDraft({ ...currentEdit.base, ...patch }, currentEdit.draft, incoming) : { draft: incoming, conflicts: [] as string[] };
        const stillDirty = merged.draft.title !== incoming.title || merged.draft.description !== incoming.description || merged.conflicts.length > 0;
        dirtyRef.current = stillDirty;
        setEditing({ base: incoming, draft: merged.draft, conflicts: merged.conflicts });
        if (!stillDirty) setAcknowledgeConflict(false);
      }
      return result;
    } finally {
      savingCount.current -= 1;
      if (!savingCount.current) setSaving(false);
      finishPending();
    }
  };
  const flushText = async () => {
    const current = editingRef.current;
    if (!current || readonly) return;
    if (current.conflicts.length && !acknowledgeRef.current) return;
    const patch = draftPatch(current.base, current.draft);
    const text: Partial<TaskDraft> = {};
    if (patch.title !== undefined && patch.title.trim()) text.title = patch.title;
    if (patch.description !== undefined) text.description = patch.description;
    if (!Object.keys(text).length) return;
    try { await runSave(text); }
    catch { /* The shared mutation already reports the failure and the draft stays. */ }
  };
  const cancelFlush = () => { window.clearTimeout(flushTimer.current); flushTimer.current = 0; };
  const flushSoon = () => {
    cancelFlush();
    flushTimer.current = window.setTimeout(() => { flushTimer.current = 0; void flushText(); }, 0);
  };
  const requestTransition = (action: () => void) => {
    cancelFlush();
    if (savingCount.current) { pending.current = action; return; }
    if (dirtyRef.current) setLeaveAction(() => action);
    else action();
  };
  const transitionRef = useRef(requestTransition);
  transitionRef.current = requestTransition;
  useImperativeHandle(ref, () => ({ requestTransition: (action: () => void) => transitionRef.current(action) }), []);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('[data-task-editor]')) return;
      if (target.closest('[data-radix-popper-content-wrapper]')) return;
      event.preventDefault();
      transitionRef.current(onCloseRef.current);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => () => { window.clearTimeout(flushTimer.current); }, []);

  const updateText = (patch: Partial<Pick<TaskDraft, 'title' | 'description'>>) => {
    setAcknowledgeConflict(false);
    setEditing((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current);
  };
  const onTextBlur = (event: FocusEvent<HTMLElement>) => {
    const allowNull = flushOnNull.current;
    flushOnNull.current = false;
    if (composing.current || readonly) return;
    if (inEditor(event.relatedTarget) || (allowNull && event.relatedTarget === null)) flushSoon();
  };
  const revertImmediate = (patch: Partial<TaskDraft>) => {
    setEditing((current) => {
      if (!current) return current;
      const reverted = { ...current.draft };
      for (const key of Object.keys(patch) as (keyof TaskDraft)[]) Object.assign(reverted, { [key]: current.base[key] });
      return { ...current, draft: reverted };
    });
  };
  const applyImmediate = async (patch: Partial<TaskDraft>) => {
    if (readonly) return;
    setEditing((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current);
    try {
      const result = await runSave(patch);
      if (!result) revertImmediate(patch);
    } catch { revertImmediate(patch); }
  };
  const resetDraft = () => {
    const latest = taskDraft(taskRef.current);
    dirtyRef.current = false;
    setEditing({ base: latest, draft: latest, conflicts: [] });
    setAcknowledgeConflict(false);
  };
  const draft = editing?.draft ?? taskDraft(fallback);
  const value: EditContext = {
    draft, readonly, tags, conflicts: editing?.conflicts ?? [], acknowledge: acknowledgeConflict, setAcknowledge: setAcknowledgeConflict,
    updateText, onTextBlur, onComposeStart: () => { composing.current = true; }, onComposeEnd: () => { composing.current = false; },
    onTitleKeyDown: (event) => {
      if (event.key === 'Enter' && !composing.current && !isCompositionKey(event.nativeEvent)) {
        event.preventDefault();
        flushOnNull.current = true;
        event.currentTarget.blur();
      }
    },
    setPriority: (priority) => { void applyImmediate({ priority }); },
    setDue: (dueDate) => { void applyImmediate({ dueDate }); },
    toggleTag: (tagId, checked) => {
      const current = editingRef.current?.draft.tagIds ?? [];
      void applyImmediate({ tagIds: checked ? [...current, tagId] : current.filter((item) => item !== tagId) });
    },
    resetDraft,
    requestClose: () => requestTransition(onCloseRef.current),
  };

  const blocked = Boolean(editing?.conflicts.length && !acknowledgeConflict) || !draft.title.trim();
  const leaveDialog = leaveAction && <Dialog open onOpenChange={(open) => { if (!open) setLeaveAction(null); }}><DialogContent surface="glass"><DialogHeader><DialogTitle>保存未完成的编辑？</DialogTitle><DialogDescription>任务有未保存的更改。</DialogDescription></DialogHeader><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => setLeaveAction(null)}>继续编辑</Button><Button variant="outline" onClick={() => { const action = leaveAction; resetDraft(); setLeaveAction(null); action(); }}>舍弃更改</Button><Button disabled={saving || blocked} onClick={() => { void flushText().then(() => { if (dirtyRef.current) return; const action = leaveAction; setLeaveAction(null); action?.(); }); }}>保存并继续</Button></div></DialogContent></Dialog>;

  return <EditContext.Provider value={value}>{children}{leaveDialog}{saving && <p className="sr-only" role="status">正在保存…</p>}</EditContext.Provider>;
});

export function TaskTitleField({ className }: { className?: string }) {
  const edit = useEdit();
  return <Input data-task-editor aria-label="任务标题" required value={edit.draft.title} disabled={edit.readonly} onChange={(event) => edit.updateText({ title: event.target.value })} onBlur={edit.onTextBlur} onKeyDown={edit.onTitleKeyDown} onCompositionStart={edit.onComposeStart} onCompositionEnd={edit.onComposeEnd} className={cn('border-transparent bg-transparent px-0 font-medium shadow-none focus-visible:ring-0', className ?? 'h-8 text-sm')} />;
}

export function TaskExpandBody({ fill = false }: { fill?: boolean }) {
  const edit = useEdit();
  const selected = edit.tags.filter((tag) => edit.draft.tagIds?.includes(tag.id));
  return <div data-task-editor className={cn('space-y-3', fill && 'flex min-h-0 flex-1 flex-col')}>
    {edit.conflicts.length > 0 && <div role="alert" className="rounded-xl border border-warning-border bg-warning-bg p-3 text-sm text-warning"><p>后台已更新{edit.conflicts.map((field) => fieldLabels[field] ?? field).join('、')}，你的编辑已保留。</p><label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={edit.acknowledge} onChange={(event) => edit.setAcknowledge(event.target.checked)} />保存时使用我的编辑</label><Button type="button" variant="ghost" size="sm" onClick={edit.resetDraft}>使用最新内容</Button></div>}
    <Textarea aria-label="详情" placeholder="添加详情" value={edit.draft.description} disabled={edit.readonly} onChange={(event) => edit.updateText({ description: event.target.value })} onBlur={edit.onTextBlur} onCompositionStart={edit.onComposeStart} onCompositionEnd={edit.onComposeEnd} className={fill ? 'min-h-64 flex-1 resize-none' : 'min-h-20'} />
    {selected.length > 0 && <div className="flex flex-wrap gap-1.5">{selected.map((tag) => <span key={tag.id} className="task-tag-chip" data-color={tag.color || 'violet'}>#{tag.name}</span>)}</div>}
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      <DateControl />
      <div role="group" aria-label="旗标" className="flex items-center gap-0.5">
        {priorities.map((item) => <Button key={item.value} type="button" variant="ghost" size="icon-sm" disabled={edit.readonly} aria-pressed={edit.draft.priority === item.value} aria-label={`旗标：${item.label}`} title={item.label} onClick={() => edit.setPriority(item.value)}><Flag className={cn(flagTone[item.value], edit.draft.priority === item.value && 'fill-current')} /></Button>)}
      </div>
      <Popover>
        <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" disabled={edit.readonly} aria-label="标签"><Hash />标签</Button></PopoverTrigger>
        <PopoverContent data-task-editor className="max-h-72 space-y-1 overflow-y-auto">
          {!edit.tags.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">在标签页面创建标签后即可分配。</p>}
          {edit.tags.map((tag) => <label key={tag.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--glass-hover)]"><input type="checkbox" checked={edit.draft.tagIds?.includes(tag.id) ?? false} onChange={(event) => edit.toggleTag(tag.id, event.target.checked)} />{tag.name}</label>)}
        </PopoverContent>
      </Popover>
    </div>
  </div>;
}

function CloseDetailButton() {
  const edit = useEdit();
  return <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭任务详情" onClick={edit.requestClose}><X /></Button>;
}

function DetailFrame({ presentation, children }: { presentation: 'panel' | 'modal' | 'retained'; children: ReactNode }) {
  const edit = useEdit();
  if (presentation === 'retained') return <div hidden>{children}</div>;
  if (presentation === 'panel') return <aside role="dialog" aria-modal="false" aria-label="任务详情" className="flex h-full min-h-0 flex-col">{children}</aside>;
  return <Dialog open onOpenChange={(open) => { if (!open) edit.requestClose(); }}><DialogContent showCloseButton={false} surface="glass" className="flex h-[min(92dvh,840px)] max-h-[92dvh] max-w-[min(42rem,calc(100%-3rem))] flex-col overflow-hidden p-0"><DialogTitle className="sr-only">任务详情</DialogTitle><DialogDescription className="sr-only">编辑任务详情、标签、旗标和日期。</DialogDescription>{children}</DialogContent></Dialog>;
}

export const TaskDetailPane = forwardRef<TaskDetailHandle, Omit<Props, 'children' | 'fallback'> & { fallback?: Task; presentation: 'panel' | 'modal' | 'retained' }>(function TaskDetailPane({ presentation, fallback, ...props }, ref) {
  const placeholder: Task = fallback ?? { id: props.id, title: '', description: '', status: 'todo', priority: 'none', dueDate: null, resultSummary: '', topicId: null, parentId: null, tagIds: [], allowedTransitions: [] };
  return <TaskExpand ref={ref} {...props} fallback={placeholder}>
    <DetailFrame presentation={presentation}>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-start gap-3 px-5 pb-2 pt-5"><div className="min-w-0 flex-1"><TaskTitleField className="h-11 text-lg font-semibold" /></div><CloseDetailButton /></header>
        <div className="flex min-h-0 flex-1 flex-col px-5 pb-5"><TaskExpandBody fill /></div>
      </div>
    </DetailFrame>
  </TaskExpand>;
});

function DateControl() {
  const edit = useEdit();
  const [open, setOpen] = useState(false);
  const choose = (dueDate: string | null) => { edit.setDue(dueDate); setOpen(false); };
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" disabled={edit.readonly} aria-label="日期"><CalendarDays />{edit.draft.dueDate ?? '日期'}</Button></PopoverTrigger>
    <PopoverContent data-task-editor className="space-y-1">
      <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => choose(shiftDate(0))}>今天</Button>
      <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => choose(shiftDate(1))}>明天</Button>
      <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => choose(shiftDate(7))}>下周</Button>
      <Input type="date" aria-label="截止日期" value={edit.draft.dueDate ?? ''} onChange={(event) => choose(event.target.value || null)} />
      <Button type="button" variant="ghost" size="sm" className="w-full justify-start" disabled={!edit.draft.dueDate} onClick={() => choose(null)}>清除</Button>
    </PopoverContent>
  </Popover>;
}
