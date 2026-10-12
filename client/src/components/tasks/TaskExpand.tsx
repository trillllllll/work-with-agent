import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Check, Clock, Flag, Hash, Timer, X } from 'lucide-react';
import { priorities, type Status, type Tag, type Task, type TaskPriority } from '@/lib/api.js';
import { draftPatch, isCompositionKey, mergeTaskDraft, taskDraft, type TaskDraft } from '@/lib/todo.js';
import { scheduleLabel } from '@/lib/schedule.js';
import { ScheduleFields, scheduleError, type ScheduleValue } from './ScheduleFields.js';
import { useHashRoute } from '@/hooks/useHashRoute.js';
import { useTask, useTodoActions } from '@/hooks/useTodo.js';
import { useFocus } from '@/components/focus/FocusProvider.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { TaskActivityDialog } from './TaskActivityDialog.js';
import { placeDescriptionCaret, readDescriptionCaret } from './DescriptionEditor.js';
import { TaskDescription } from './TaskDescription.js';
import { SubtasksSection } from './TaskSubtasks.js';
import { cn } from '@/lib/utils.js';

type Editing = { base: TaskDraft; draft: TaskDraft; conflicts: string[] };
export type TaskDetailHandle = { requestTransition: (action: () => void) => void };
const fieldLabels: Record<string, string> = { title: '标题', description: '说明', status: '状态', priority: '优先级', dueDate: '安排日期', estimatedMinutes: '预计时长', scheduledStart: '开始时间', scheduledEnd: '结束时间', resultSummary: '结果摘要', topicId: '所属清单', parentId: '父任务', tagIds: '标签' };
const flagTone: Record<TaskPriority, string> = { none: 'text-muted-foreground', low: 'text-primary', medium: 'text-warning', high: 'text-destructive' };

function inEditor(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('[data-task-editor]'));
}
function stopDrag(event: { stopPropagation: () => void }) { event.stopPropagation(); }

type EditContext = {
  draft: TaskDraft;
  base: TaskDraft;
  readonly: boolean;
  tags: Tag[];
  conflicts: string[];
  acknowledge: boolean;
  setAcknowledge: (value: boolean) => void;
  updateText: (patch: Partial<Pick<TaskDraft, 'title' | 'description'>>) => void;
  onTextBlur: (event: FocusEvent<HTMLElement>) => void;
  onTitleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  taskId: string;
  task: Task;
  openDescription: MutableRefObject<() => void>;
  onComposeStart: () => void;
  onComposeEnd: () => void;
  setStatus: (status: Status) => void;
  setPriority: (priority: TaskPriority) => void;
  setSchedule: (schedule: ScheduleValue, task: Task) => Promise<boolean>;
  setEstimate: (estimatedMinutes: number | null, task: Task) => Promise<boolean>;
  toggleTag: (id: string, checked: boolean) => void;
  resetDraft: () => void;
  requestClose: () => void;
  saveText: () => Promise<void>;
  toggleSubtask: (task: Task) => Promise<unknown>;
  createSubtask: (input: { title: string; topicId: string | null; parentId: string | null }) => Promise<unknown>;
  openSubtask: (id: string) => void;
};
const EditContext = createContext<EditContext | null>(null);
export function useEdit() {
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
  onToggleTask?: (task: Task) => Promise<unknown>;
  onCreateTask?: (input: { title: string; topicId: string | null; parentId: string | null }) => Promise<unknown>;
  onOpenTask?: (id: string) => void;
  children: ReactNode;
};

export const TaskExpand = forwardRef<TaskDetailHandle, Props>(function TaskExpand({ id, fallback, tags, readonly = false, onSave, onClose, onDirtyChange, onToggleTask, onCreateTask, onOpenTask, children }, ref) {
  const query = useTask(id);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  const [acknowledgeConflict, setAcknowledgeConflict] = useState(false);
  const seeded = useRef(false);
  const composing = useRef(false);
  const openDescription = useRef<() => void>(() => {});
  const flushOnNull = useRef(false);
  const flushTimer = useRef(0);
  const savingCount = useRef(0);
  const savedVersions = useRef(new Map<number, number>());
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
  const runSave = async (patch: Partial<TaskDraft>, current = taskRef.current) => {
    if (!current || !Object.keys(patch).length) return undefined;
    savingCount.current += 1;
    setSaving(true);
    try {
      // An open popover keeps its original version. Advance only through writes
      // completed by this editor; an external refresh never supplies a version.
      let revision = current.revision;
      while (revision !== undefined && savedVersions.current.has(revision)) revision = savedVersions.current.get(revision)!;
      const result = await onSaveRef.current({ ...current, revision }, patch);
      if (result) {
        if (revision !== undefined && result.revision !== undefined && result.revision > revision) savedVersions.current.set(revision, result.revision);
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
  const flushText = async (held?: Editing | null) => {
    const current = held === undefined ? editingRef.current : held;
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
    const held = editingRef.current;
    // The timer lets a second blur in this turn replace the save. Keystrokes after the blur stay in the draft.
    flushTimer.current = window.setTimeout(() => { flushTimer.current = 0; void flushText(held); }, 0);
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
    const current = editingRef.current;
    if (!current) return;
    const next = { ...current, draft: { ...current.draft, ...patch } };
    editingRef.current = next;
    setEditing(next);
  };
  const onTextBlur = (event: FocusEvent<HTMLElement>) => {
    const allowNull = flushOnNull.current;
    flushOnNull.current = false;
    if (!event.currentTarget.isConnected || composing.current || readonly) return;
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
  const applyImmediate = async (patch: Partial<TaskDraft>, currentTask = taskRef.current) => {
    if (readonly) return false;
    setEditing((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current);
    try {
      const result = await runSave(patch, currentTask);
      if (!result) revertImmediate(patch);
      return Boolean(result);
    } catch { revertImmediate(patch); return false; }
  };
  const resetDraft = () => {
    const latest = taskDraft(taskRef.current);
    dirtyRef.current = false;
    setEditing({ base: latest, draft: latest, conflicts: [] });
    setAcknowledgeConflict(false);
  };
  const draft = editing?.draft ?? taskDraft(fallback);
  const base = editing?.base ?? draft;
  const value: EditContext = {
    draft, base, readonly, tags, conflicts: editing?.conflicts ?? [], acknowledge: acknowledgeConflict, setAcknowledge: setAcknowledgeConflict,
    updateText, onTextBlur, onComposeStart: () => { composing.current = true; }, onComposeEnd: () => { composing.current = false; },
    taskId: id,
    task: taskRef.current,
    openDescription,
    onTitleKeyDown: (event) => {
      if (event.key !== 'Enter' || composing.current || isCompositionKey(event.nativeEvent)) return;
      event.preventDefault();
      flushOnNull.current = true;
      const title = event.currentTarget;
      openDescription.current();
      requestAnimationFrame(() => { if (document.activeElement?.getAttribute('aria-label') !== '详情') title.blur(); });
    },
    setStatus: (status) => { void applyImmediate({ status }); },
    setPriority: (priority) => { void applyImmediate({ priority }); },
    setSchedule: (schedule, task) => applyImmediate(schedule, task),
    setEstimate: (estimatedMinutes, task) => applyImmediate({ estimatedMinutes }, task),
    toggleTag: (tagId, checked) => {
      const current = editingRef.current?.draft.tagIds ?? [];
      void applyImmediate({ tagIds: checked ? [...current, tagId] : current.filter((item) => item !== tagId) });
    },
    resetDraft,
    requestClose: () => requestTransition(onCloseRef.current),
    saveText: async () => { cancelFlush(); await flushText(); },
    toggleSubtask: onToggleTask ?? (async () => {}),
    createSubtask: onCreateTask ?? (async () => {}),
    openSubtask: onOpenTask ?? (() => {}),
  };

  const blocked = Boolean(editing?.conflicts.length && !acknowledgeConflict) || !draft.title.trim();
  const leaveDialog = leaveAction && <Dialog open onOpenChange={(open) => { if (!open) setLeaveAction(null); }}><DialogContent surface="glass"><DialogHeader><DialogTitle>保存未完成的编辑？</DialogTitle><DialogDescription>任务有未保存的更改。</DialogDescription></DialogHeader><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => setLeaveAction(null)}>继续编辑</Button><Button variant="outline" onClick={() => { const action = leaveAction; resetDraft(); setLeaveAction(null); action(); }}>舍弃更改</Button><Button disabled={saving || blocked} onClick={() => { void flushText().then(() => { if (dirtyRef.current) return; const action = leaveAction; setLeaveAction(null); action?.(); }); }}>保存并继续</Button></div></DialogContent></Dialog>;

  return <EditContext.Provider value={value}>{children}{leaveDialog}{saving && <p className="sr-only" role="status">正在保存…</p>}</EditContext.Provider>;
});

function flattenTitle(value: string) {
  return value.replace(/[^\S\n]*[\r\n]+[^\S\n]*/g, ' ');
}

function fitTitle(node: HTMLTextAreaElement) {
  node.style.height = '0px';
  const style = getComputedStyle(node);
  const line = Number.parseFloat(style.lineHeight);
  const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  const max = (Number.isFinite(line) ? line : 28) * 4 + padding;
  const next = Math.min(node.scrollHeight, max);
  node.style.height = `${next}px`;
  node.style.overflowY = node.scrollHeight > max + 1 ? 'auto' : 'hidden';
}

export function TaskTitleField({ className }: { className?: string }) {
  const edit = useEdit();
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const parent = node?.parentElement;
    if (!node || !parent) return;
    let width = parent.clientWidth;
    const fit = () => fitTitle(node);
    fit();
    const observer = new ResizeObserver(() => {
      const next = parent.clientWidth;
      if (next === width) return;
      width = next;
      fit();
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [edit.draft.title]);
  return <textarea ref={ref} data-task-editor aria-label="任务标题" required rows={1} value={edit.draft.title} disabled={edit.readonly} onChange={(event) => edit.updateText({ title: flattenTitle(event.target.value) })} onPaste={(event) => {
    const text = event.clipboardData.getData('text');
    if (!/[\r\n]/.test(text)) return;
    event.preventDefault();
    const flat = flattenTitle(text);
    const node = event.currentTarget;
    const start = node.selectionStart ?? node.value.length;
    const end = node.selectionEnd ?? start;
    edit.updateText({ title: `${node.value.slice(0, start)}${flat}${node.value.slice(end)}` });
    const caret = start + flat.length;
    requestAnimationFrame(() => node.setSelectionRange(caret, caret));
  }} onBlur={edit.onTextBlur} onKeyDown={edit.onTitleKeyDown} onCompositionStart={edit.onComposeStart} onCompositionEnd={edit.onComposeEnd} className={cn('task-writing task-title', edit.draft.status === 'done' && 'text-muted-foreground line-through', className)} />;
}

function TaskStatusCheckbox() {
  const edit = useEdit();
  const done = edit.draft.status === 'done';
  return <button type="button" role="checkbox" aria-checked={done} aria-label={`${done ? '重开' : '完成'}任务：${edit.draft.title}`} disabled={edit.readonly} className="task-check-round mt-[5px] shrink-0" onClick={() => edit.setStatus(done ? 'todo' : 'done')}>{done && <Check className="size-3" aria-hidden />}</button>;
}

const InfoRow = forwardRef<HTMLButtonElement, { icon: typeof CalendarDays; label: string; value: string; hasValue: boolean; disabled?: boolean; 'aria-label': string }>(function InfoRow({ icon: Icon, label, value, hasValue, ...props }, ref) {
  return <button ref={ref} type="button" {...props} className="task-info-row">
    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    <span className="w-20 shrink-0 text-left text-muted-foreground">{label}</span>
    <span className={cn('min-w-0 flex-1 truncate text-right', hasValue ? '' : 'text-muted-foreground')}>{value}</span>
  </button>;
});

export function TaskExpandBody({ fill = false }: { fill?: boolean }) {
  const edit = useEdit();
  return <div data-task-editor className={cn('flex flex-col', fill && 'min-h-0 flex-1')}>
    {edit.conflicts.length > 0 && <div role="alert" className="mb-3 rounded-xl border border-warning-border bg-warning-bg p-3 text-sm text-warning"><p>后台已更新{edit.conflicts.map((field) => fieldLabels[field] ?? field).join('、')}，你的编辑已保留。</p><label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={edit.acknowledge} onChange={(event) => edit.setAcknowledge(event.target.checked)} />保存时使用我的编辑</label><Button type="button" variant="ghost" size="sm" onClick={edit.resetDraft}>使用最新内容</Button></div>}
    <TaskDescription taskId={edit.taskId} value={edit.draft.description} readonly={edit.readonly} fill={fill} openDescription={edit.openDescription} onChange={(description) => edit.updateText({ description })} onBlur={edit.onTextBlur} onComposeStart={edit.onComposeStart} onComposeEnd={edit.onComposeEnd} onSave={edit.saveText} />
    <div className="mt-3 shrink-0"><SubtasksSection /></div>
    <div className="task-info-rows mt-auto shrink-0">
      <ScheduleControl />
      <EstimateControl />
      <FlagRow />
      <TagPicker />
      <StartFocusButton />
    </div>
  </div>;
}

function FlagRow() {
  const edit = useEdit();
  return <div className="task-info-row">
    <Flag className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    <span className="w-20 shrink-0 text-left text-muted-foreground">旗标</span>
    <div role="group" aria-label="旗标" className="flex min-w-0 flex-1 items-center justify-end gap-0.5">
      {priorities.map((item) => <Button key={item.value} type="button" variant="ghost" size="icon-sm" disabled={edit.readonly} aria-pressed={edit.draft.priority === item.value} aria-label={`旗标：${item.label}`} title={item.label} onClick={() => edit.setPriority(item.value)}><Flag className={cn(flagTone[item.value], edit.draft.priority === item.value && 'fill-current')} /></Button>)}
    </div>
  </div>;
}

function TagPicker() {
  const edit = useEdit();
  const actions = useTodoActions();
  const [name, setName] = useState('');
  const selected = edit.tags.filter((tag) => edit.draft.tagIds?.includes(tag.id));
  const add = async () => {
    const value = name.trim();
    if (!value || edit.readonly || actions.pending) return;
    const existing = edit.tags.find((tag) => tag.name === value);
    if (existing) {
      if (!edit.draft.tagIds?.includes(existing.id)) edit.toggleTag(existing.id, true);
      setName('');
      return;
    }
    try {
      const created = await actions.write<Tag>('/api/tags', 'POST', { name: value }, ['tag-create'], '标签已创建');
      if (created.data?.id) edit.toggleTag(created.data.id, true);
      setName('');
    } catch { /* The shared write already reports the failure and keeps the typed name. */ }
  };
  return <Popover>
    <div className={cn('task-info-row', edit.readonly && 'opacity-50')}>
      <PopoverTrigger asChild>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-[0.625rem] bg-transparent p-0 text-left" aria-label="标签" disabled={edit.readonly}>
          <Hash className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="w-20 shrink-0 text-left text-muted-foreground">标签</span>
          {selected.length === 0 && <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">设置</span>}
        </button>
      </PopoverTrigger>
      {selected.length > 0 && <div className="flex min-w-0 flex-wrap justify-end gap-1.5">{selected.map((tag) => <span key={tag.id} className="task-tag-chip inline-flex items-center gap-1" data-color={tag.color || 'violet'}>#{tag.name}{!edit.readonly && <button type="button" className="grid size-4 place-items-center rounded-full hover:bg-black/10 dark:hover:bg-white/10" aria-label={`从任务去掉标签：${tag.name}`} onClick={() => edit.toggleTag(tag.id, false)}><X className="size-3" /></button>}</span>)}</div>}
    </div>
    <PopoverContent data-task-editor className="space-y-2">
      <form className="space-y-1" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <Input aria-label="新标签名称" value={name} disabled={edit.readonly} placeholder="新标签" onChange={(event) => setName(event.target.value)} className="h-8" />
        <Button type="submit" size="sm" className="w-full" disabled={edit.readonly || actions.pending || !name.trim()}>添加标签</Button>
      </form>
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {!edit.tags.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">输入名称即可新增标签。</p>}
        {edit.tags.map((tag) => <label key={tag.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--glass-hover)]"><input type="checkbox" checked={edit.draft.tagIds?.includes(tag.id) ?? false} onChange={(event) => edit.toggleTag(tag.id, event.target.checked)} />{tag.name}</label>)}
      </div>
    </PopoverContent>
  </Popover>;
}

function CloseDetailButton() {
  const edit = useEdit();
  return <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭任务详情" onClick={edit.requestClose}><X /></Button>;
}

function ActivityButton({ onOpen }: { onOpen: () => void }) {
  const edit = useEdit();
  return <Button type="button" variant="outline" size="sm" className="shrink-0 rounded-lg" aria-label="任务动态" onClick={() => { void edit.saveText().then(onOpen); }}>动态</Button>;
}

type EditorCaret = { label: '任务标题' | '详情'; start: number; end: number };

function editorCaret(node: Element | null): EditorCaret | null {
  if (node instanceof HTMLTextAreaElement && node.getAttribute('aria-label') === '任务标题') return { label: '任务标题', start: node.selectionStart ?? 0, end: node.selectionEnd ?? 0 };
  const content = node?.closest('[aria-label="详情"]');
  if (content instanceof HTMLElement && content.closest('[data-task-editor]')) {
    const range = readDescriptionCaret(content);
    if (range) return { label: '详情', ...range };
  }
  return null;
}

function visibleEditor(label: EditorCaret['label']) {
  const selector = label === '任务标题' ? 'textarea[aria-label="任务标题"]' : '[aria-label="详情"]';
  for (const node of document.querySelectorAll(selector)) {
    if (!(node instanceof HTMLElement) || !node.closest('[data-task-editor]')) continue;
    if (node.getClientRects().length === 0) continue;
    return node;
  }
  return null;
}

function placeCaret(caret: EditorCaret) {
  const node = visibleEditor(caret.label);
  if (!node) return false;
  if (caret.label === '详情') return placeDescriptionCaret(node, caret.start, caret.end);
  if (!(node instanceof HTMLTextAreaElement) || node.disabled) return false;
  node.focus();
  node.setSelectionRange(caret.start, caret.end);
  return document.activeElement === node;
}

function rememberEditorCaret(pending: { current: EditorCaret | null }) {
  if (typeof document === 'undefined') return;
  const caret = editorCaret(document.activeElement);
  if (caret) {
    pending.current = caret;
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !active.closest('[data-task-editor]')) pending.current = null;
}

function DetailFrame({ presentation, panelSlot, children }: { presentation: 'panel' | 'modal' | 'retained'; panelSlot: HTMLElement | null; children: ReactNode }) {
  const edit = useEdit();
  const presentationRef = useRef(presentation);
  const pendingFocus = useRef<EditorCaret | null>(null);
  presentationRef.current = presentation;
  rememberEditorCaret(pendingFocus);
  useLayoutEffect(() => {
    const saved = pendingFocus.current;
    if (!saved) return;
    // The modal content is portaled on a later layout pass. Leave the caret for that dialog's autofocus.
    if (placeCaret(saved) && presentation !== 'modal') pendingFocus.current = null;
  }, [presentation, panelSlot]);
  if (presentation === 'retained') return <div hidden>{children}</div>;
  if (presentation === 'panel') {
    const aside = <aside role="dialog" aria-modal="false" aria-label="任务详情" className="flex h-full min-h-0 flex-col">{children}</aside>;
    if (!panelSlot) return <div hidden>{aside}</div>;
    return createPortal(aside, panelSlot);
  }
  return <Dialog open onOpenChange={(open) => { if (!open && presentationRef.current === 'modal') edit.requestClose(); }}><DialogContent showCloseButton={false} surface="glass" className="flex h-[min(92dvh,840px)] max-h-[92dvh] max-w-[min(42rem,calc(100%-3rem))] flex-col overflow-hidden p-0" onOpenAutoFocus={(event) => { const saved = pendingFocus.current; if (!saved) return; event.preventDefault(); if (placeCaret(saved)) pendingFocus.current = null; else requestAnimationFrame(() => { if (pendingFocus.current && placeCaret(pendingFocus.current)) pendingFocus.current = null; }); }} onCloseAutoFocus={(event) => { if (presentationRef.current !== 'modal') event.preventDefault(); }}><DialogTitle className="sr-only">任务详情</DialogTitle><DialogDescription className="sr-only">编辑任务详情、标签、旗标和日期。</DialogDescription>{children}</DialogContent></Dialog>;
}

export const TaskDetailPane = forwardRef<TaskDetailHandle, Omit<Props, 'children' | 'fallback'> & { fallback?: Task; presentation: 'panel' | 'modal' | 'retained'; panelSlot: HTMLElement | null }>(function TaskDetailPane({ presentation, panelSlot, fallback, ...props }, ref) {
  const [activity, setActivity] = useState(false);
  const placeholder: Task = fallback ?? { id: props.id, title: '', description: '', status: 'todo', priority: 'none', dueDate: null, estimatedMinutes: null, scheduledStart: null, scheduledEnd: null, resultSummary: '', topicId: null, parentId: null, tagIds: [], allowedTransitions: [] };
  return <TaskExpand ref={ref} {...props} fallback={placeholder}>
    <DetailFrame presentation={presentation} panelSlot={panelSlot}>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-start gap-2 px-5 pt-5"><TaskStatusCheckbox /><div className="min-w-0 flex-1"><TaskTitleField /></div><ActivityButton onOpen={() => setActivity(true)} /><CloseDetailButton /></header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-5"><TaskExpandBody fill /></div>
      </div>
    </DetailFrame>
    <TaskActivityDialog taskId={props.id} open={activity} onOpenChange={setActivity} />
  </TaskExpand>;
});

function StartFocusButton() {
  const edit = useEdit();
  const { dispatch } = useFocus();
  const { navigate } = useHashRoute();
  return <button type="button" className="task-info-row" disabled={edit.readonly} onClick={() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
    dispatch({ type: 'START', taskId: edit.taskId, taskTitle: edit.draft.title, now: Date.now() });
    navigate('focus');
  }}>
    <Timer className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    <span className="w-20 shrink-0 text-left text-muted-foreground">开始专注</span>
    <span className="min-w-0 flex-1 truncate text-right" />
  </button>;
}

function ScheduleControl() {
  const edit = useEdit();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<ScheduleValue>({ dueDate: null, scheduledStart: null, scheduledEnd: null });
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const openedTask = useRef(edit.task);
  const changeOpen = (next: boolean) => {
    if (lock.current) return;
    if (next) { openedTask.current = edit.task; setValue({ dueDate: edit.draft.dueDate, scheduledStart: edit.draft.scheduledStart, scheduledEnd: edit.draft.scheduledEnd }); }
    setOpen(next);
  };
  return <Popover open={open} onOpenChange={changeOpen}>
    <PopoverTrigger asChild><InfoRow icon={CalendarDays} label="安排时间" value={scheduleLabel(edit.draft)} hasValue={Boolean(edit.draft.dueDate || edit.draft.scheduledStart)} disabled={edit.readonly} aria-label="安排时间" /></PopoverTrigger>
    <PopoverContent data-task-editor className="max-h-[75dvh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto space-y-3">
      <ScheduleFields value={value} onChange={setValue} estimatedMinutes={edit.draft.estimatedMinutes} disabled={saving} />
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={saving} onClick={() => changeOpen(false)}>取消</Button><Button type="button" disabled={saving || Boolean(scheduleError(value))} onClick={() => {
        if (lock.current) return;
        lock.current = true; setSaving(true);
        void edit.setSchedule(value, openedTask.current).then((saved) => { if (saved) setOpen(false); }).finally(() => { lock.current = false; setSaving(false); });
      }}>{saving ? '保存中…' : '保存安排'}</Button></div>
    </PopoverContent>
  </Popover>;
}

function EstimateControl() {
  const edit = useEdit();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const openedTask = useRef(edit.task);
  const minutes = value === '' ? null : Number(value);
  return <Popover open={open} onOpenChange={(next) => { if (lock.current) return; if (next) { openedTask.current = edit.task; setValue(String(edit.draft.estimatedMinutes ?? '')); } setOpen(next); }}>
    <PopoverTrigger asChild><InfoRow icon={Clock} label="预计时长" value={edit.draft.estimatedMinutes ? `${edit.draft.estimatedMinutes}分钟` : '设置'} hasValue={Boolean(edit.draft.estimatedMinutes)} disabled={edit.readonly} aria-label="预计时长" /></PopoverTrigger>
    <PopoverContent data-task-editor className="w-64 space-y-3"><p className="text-xs text-muted-foreground">用于首次安排时间段，不改变已有安排。</p><Input type="number" min={1} max={10080} aria-label="预计时长分钟" value={value} disabled={saving} onChange={(event) => setValue(event.target.value)} /><div className="flex justify-end gap-2"><Button variant="ghost" disabled={saving} onClick={() => setOpen(false)}>取消</Button><Button disabled={saving || (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080))} onClick={() => {
      if (lock.current) return;
      lock.current = true; setSaving(true);
      void edit.setEstimate(minutes, openedTask.current).then((saved) => { if (saved) setOpen(false); }).finally(() => { lock.current = false; setSaving(false); });
    }}>{saving ? '保存中…' : '保存'}</Button></div></PopoverContent>
  </Popover>;
}
