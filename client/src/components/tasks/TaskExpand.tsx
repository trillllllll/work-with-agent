import { askAssistant, usePageContext } from '@/lib/assistant-context.js';
import { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CalendarDays, Check, ChevronRight, Clock, Flag, Hash, Timer, X } from 'lucide-react';
import { ApiError, priorities, type Status, type Tag, type Task, type TaskPriority } from '@/lib/api.js';
import { isCompositionKey, sameField, taskDraft, queryKeys, type TaskDraft } from '@/lib/todo.js';
import { scheduleLabel } from '@/lib/schedule.js';
import { ScheduleFields, scheduleError, type ScheduleValue } from './ScheduleFields.js';
import { useHashRoute } from '@/hooks/useHashRoute.js';
import { useTask, useTodoActions } from '@/hooks/useTodo.js';
import { useFocus } from '@/components/focus/FocusProvider.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';
import type { SaveStatus, TaskDetailHandle, TaskTextDraftV1, TextField } from '@/lib/task-editor-types.js';
export type { TaskDetailHandle };
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { TaskActivityDialog } from './TaskActivityDialog.js';
import { placeDescriptionCaret, readDescriptionCaret } from './DescriptionEditor.js';
import { TaskMaterials } from '@/components/library/TaskMaterials.js';
import { TaskDescription } from './TaskDescription.js';
import { SubtasksSection } from './TaskSubtasks.js';
import { saveStatusLabel, SaveStatusRow } from './task-save-status.js';
import { cn } from '@/lib/utils.js';

// 非文字字段仍走本地草稿；title/description 由应用级协调器负责。
const metaFields = ['status', 'priority', 'dueDate', 'estimatedMinutes', 'scheduledStart', 'scheduledEnd', 'resultSummary', 'topicId', 'parentId', 'tagIds'] as const;
type MetaDraft = Pick<TaskDraft, typeof metaFields[number]>;
type Editing = { base: MetaDraft; draft: MetaDraft; conflicts: string[] };

const fieldLabels: Record<string, string> = { title: '标题', description: '说明', status: '状态', priority: '优先级', dueDate: '安排日期', estimatedMinutes: '预计时长', scheduledStart: '开始时间', scheduledEnd: '结束时间', resultSummary: '结果摘要', topicId: '所属清单', parentId: '父任务', tagIds: '标签' };
const flagTone: Record<TaskPriority, string> = { none: 'text-muted-foreground', low: 'text-primary', medium: 'text-warning', high: 'text-destructive' };

function metaOf(task: Task): MetaDraft {
  const draft = taskDraft(task);
  return Object.fromEntries(metaFields.map((field) => [field, draft[field]])) as MetaDraft;
}

function inEditor(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('[data-task-editor]'));
}

type EditContext = {
  draft: TaskDraft;
  base: TaskDraft;
  readonly: boolean;
  tags: Tag[];
  conflicts: string[];
  acknowledge: boolean;
  setAcknowledge: (value: boolean) => void;
  updateText: (patch: Partial<Pick<TaskDraft, 'title' | 'description'>>) => void;
  onTitleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  taskId: string;
  task: Task;
  openDescription: MutableRefObject<() => void>;
  onComposeStart: () => void;
  onComposeEnd: () => void;
  textStatus: SaveStatus;
  textRecord: TaskTextDraftV1 | null;
  resolveKeepMine: () => void;
  resolveKeepRemote: () => void;
  setStatus: (status: Status) => void;
  setPriority: (priority: TaskPriority) => void;
  setSchedule: (schedule: ScheduleValue, task: Task) => Promise<boolean>;
  setEstimate: (estimatedMinutes: number | null, task: Task) => Promise<boolean>;
  toggleTag: (id: string, checked: boolean) => void;
  resetDraft: () => void;
  requestClose: () => void;
  saveText: () => Promise<boolean>;
  openLinkedTask: (taskId: string) => Promise<void>;
  toggleSubtask: (task: Task) => Promise<unknown>;
  createSubtask: (input: { title: string; topicId: string | null; parentId: string | null }) => Promise<unknown>;
  openSubtask: (id: string) => void;
  openTask: (id: string) => void;
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
  const coordinator = useEditorRuntime()?.coordinator ?? null;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  const [acknowledgeConflict, setAcknowledgeConflict] = useState(false);
  const [textRecord, setTextRecord] = useState<TaskTextDraftV1 | null>(null);
  const [textStatus, setTextStatus] = useState<SaveStatus>('clean');
  const [staleBranches, setStaleBranches] = useState<TaskTextDraftV1[]>([]);
  const seeded = useRef(false);
  const openDescription = useRef<() => void>(() => {});
  const savingCount = useRef(0);
  const saveWaiters = useRef<Array<() => void>>([]);
  const savedVersions = useRef(new Map<number, number>());
  const pending = useRef<(() => void) | null>(null);
  const editingRef = useRef(editing);
  const taskRef = useRef(query.data ?? fallback);
  const dirtyRef = useRef(false);
  const onSaveRef = useRef(onSave);
  const onCloseRef = useRef(onClose);
  const textRecordRef = useRef<TaskTextDraftV1 | null>(null);
  const textDirtyRef = useRef(false);
  editingRef.current = editing;
  taskRef.current = query.data ?? fallback;
  onSaveRef.current = onSave;
  onCloseRef.current = onClose;
  textRecordRef.current = textRecord;

  // ---------- 协调器：打开分支、订阅状态、接收外部更新 ----------

  useEffect(() => {
    if (!coordinator) return;
    const task = taskRef.current;
    void coordinator.openTask(id, { revision: task.revision ?? 1, title: task.title, description: task.description ?? '' })
      .then((result) => { if (result.staleBranches.length) setStaleBranches(result.staleBranches); })
      .catch(() => {});
    const unsubscribe = coordinator.subscribe(id, (event) => {
      setTextRecord(event.record);
      setTextStatus(event.status);
      textDirtyRef.current = event.status !== 'clean';
    });
    return unsubscribe;
  }, [coordinator, id, query.data]);

  const currentText = useCallback((patch: Partial<Pick<TaskDraft, 'title' | 'description'>>) => {
    const record = textRecordRef.current;
    const base = record?.draft ?? { title: taskRef.current.title, description: taskRef.current.description ?? '' };
    return { title: patch.title ?? base.title, description: patch.description ?? base.description };
  }, []);

  const updateText = (patch: Partial<Pick<TaskDraft, 'title' | 'description'>>) => {
    setAcknowledgeConflict(false);
    coordinator?.onUserEdit(id, currentText(patch));
  };
  const onComposeStart = () => coordinator?.setComposing(id, true);
  const onComposeEnd = () => coordinator?.setComposing(id, false);

  // ---------- 非文字字段本地草稿 ----------

  useEffect(() => {
    if (query.data || seeded.current) return;
    seeded.current = true;
    const incoming = metaOf(fallback);
    setEditing({ base: incoming, draft: incoming, conflicts: [] });
  }, [query.data, fallback]);

  useEffect(() => {
    if (!query.data) return;
    const incoming = metaOf(query.data);
    setEditing((current) => {
      if (!current) return { base: incoming, draft: incoming, conflicts: [] };
      const next = { ...current.draft };
      const conflicts = [...current.conflicts];
      for (const field of metaFields) {
        if (sameField(current.base[field], current.draft[field])) Object.assign(next, { [field]: incoming[field] });
        else if (!sameField(current.base[field], incoming[field]) && !sameField(current.draft[field], incoming[field]) && !conflicts.includes(field)) conflicts.push(field);
      }
      return { base: incoming, draft: next, conflicts };
    });
    // 同一查询刷新也是协调器的外部更新通道。
    coordinator?.externalUpdate(id, { revision: query.data.revision ?? 1, title: query.data.title, description: query.data.description ?? '' });
  }, [query.data, coordinator, id]);

  const metaDirty = Boolean(editing && (metaFields.some((field) => !sameField(editing.base[field], editing.draft[field])) || editing.conflicts.length > 0));
  const dirty = metaDirty || textDirtyRef.current;
  dirtyRef.current = dirty;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

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
        const incoming = metaOf(result);
        setEditing((currentEdit) => currentEdit ? { ...currentEdit, base: incoming, conflicts: [] } : currentEdit);
      }
      return result;
    } finally {
      savingCount.current -= 1;
      if (!savingCount.current) {
        setSaving(false);
        const waiters = saveWaiters.current;
        saveWaiters.current = [];
        waiters.forEach((resolve) => resolve());
      }
      finishPending();
    }
  };
  const idle = () => {
    if (!savingCount.current) return Promise.resolve();
    return new Promise<void>((resolve) => { saveWaiters.current.push(resolve); });
  };
  const flushMeta = async () => {
    const current = editingRef.current;
    if (!current || readonly) return;
    if (current.conflicts.length && !acknowledgeConflict) return;
    const patch: Partial<TaskDraft> = {};
    for (const field of metaFields) if (!sameField(current.base[field], current.draft[field])) Object.assign(patch, { [field]: current.draft[field] });
    if (!Object.keys(patch).length) return;
    try { await runSave(patch); }
    catch { /* The shared mutation already reports the failure and the draft stays. */ }
  };

  const ensureSaved = async () => {
    await flushMeta();
    await idle();
    if (!coordinator) return true;
    return coordinator.ensureSaved(id);
  };
  const prepareLeave = async () => {
    await idle();
    if (!coordinator) return true;
    return coordinator.prepareLeave(id);
  };
  const requestTransition = (action: () => void) => {
    if (savingCount.current) { pending.current = action; return; }
    if (metaDirty) { setLeaveAction(() => action); return; }
    void prepareLeave().then((safe) => { if (safe) action(); else setLeaveAction(() => action); });
  };
  const transitionRef = useRef(requestTransition);
  const ensureRef = useRef(ensureSaved);
  transitionRef.current = requestTransition;
  ensureRef.current = ensureSaved;
  useImperativeHandle(ref, () => ({
    requestTransition: (action: () => void) => transitionRef.current(action),
    ensureSaved: () => ensureRef.current(),
    prepareLeave: () => prepareLeave(),
  }), []);
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

  const resetDraft = () => {
    const latest = metaOf(taskRef.current);
    setEditing({ base: latest, draft: latest, conflicts: [] });
    setAcknowledgeConflict(false);
    coordinator?.resolveConflictsKeepRemote(id);
  };

  const applyImmediate = async (patch: Partial<TaskDraft>, currentTask = taskRef.current) => {
    if (readonly) return false;
    setEditing((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current);
    try {
      const result = await runSave(patch, currentTask);
      if (!result) {
        setEditing((current) => {
          if (!current) return current;
          const reverted = { ...current.draft };
          for (const key of Object.keys(patch) as (keyof TaskDraft)[]) Object.assign(reverted, { [key]: current.base[key as keyof MetaDraft] });
          return { ...current, draft: reverted };
        });
        return false;
      }
      return true;
    } catch {
      setEditing((current) => {
        if (!current) return current;
        const reverted = { ...current.draft };
        for (const key of Object.keys(patch) as (keyof TaskDraft)[]) Object.assign(reverted, { [key]: current.base[key as keyof MetaDraft] });
        return { ...current, draft: reverted };
      });
      return false;
    }
  };

  const textDraft = textRecord?.draft ?? { title: taskRef.current.title, description: taskRef.current.description ?? '' };
  const textBase = textRecord?.base ?? { revision: taskRef.current.revision ?? 1, ...textDraft };
  const fullDraft: TaskDraft = { ...editing?.draft, ...textDraft } as TaskDraft;
  const fullBase: TaskDraft = { ...editing?.base, title: textBase.title, description: textBase.description } as TaskDraft;
  const textConflicts = textRecord?.conflicts ?? {};
  const value: EditContext = {
    draft: fullDraft, base: fullBase, readonly, tags, conflicts: [...(editing?.conflicts ?? []), ...Object.keys(textConflicts)], acknowledge: acknowledgeConflict, setAcknowledge: setAcknowledgeConflict,
    updateText, onComposeStart, onComposeEnd, onTitleKeyDown: (event) => {
      if (event.key !== 'Enter' || isCompositionKey(event.nativeEvent)) return;
      event.preventDefault();
      const title = event.currentTarget;
      openDescription.current();
      requestAnimationFrame(() => { if (document.activeElement?.getAttribute('aria-label') !== '详情') title.blur(); });
    },
    taskId: id,
    task: taskRef.current,
    openDescription,
    textStatus, textRecord,
    resolveKeepMine: () => coordinator?.resolveConflictsKeepMine(id),
    resolveKeepRemote: () => coordinator?.resolveConflictsKeepRemote(id),
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
    saveText: () => ensureSaved(),
    openLinkedTask: async (nextId: string) => {
      if (!nextId || nextId === id) return;
      const saved = await ensureSaved();
      if (!saved) return;
      onOpenTask?.(nextId);
    },
    toggleSubtask: onToggleTask ?? (async () => {}),
    createSubtask: onCreateTask ?? (async () => {}),
    openSubtask: onOpenTask ?? (() => {}),
    openTask: onOpenTask ?? (() => {}),
  };

  const blocked = Boolean(editing?.conflicts.length && !acknowledgeConflict) || !fullDraft.title.trim();
  const leaveDialog = leaveAction && <Dialog open onOpenChange={(open) => { if (!open) setLeaveAction(null); }}><DialogContent surface="glass"><DialogHeader><DialogTitle>保存未完成的编辑？</DialogTitle><DialogDescription>任务有未保存的更改。</DialogDescription></DialogHeader><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => setLeaveAction(null)}>继续编辑</Button><Button variant="outline" onClick={() => { const action = leaveAction; resetDraft(); setLeaveAction(null); action(); }}>舍弃更改</Button><Button disabled={saving || blocked} onClick={() => { void flushMeta().then(() => prepareLeave()).then((safe) => { if (!safe) return; const action = leaveAction; setLeaveAction(null); action?.(); }); }}>保存并继续</Button></div></DialogContent></Dialog>;

  return <EditContext.Provider value={value}>{children}
    {staleBranches.length > 1 && <StaleBranchDialog taskId={id} branches={staleBranches} onResolved={() => setStaleBranches([])} />}
    {leaveDialog}
    {saving && <p className="sr-only" role="status">正在保存…</p>}
  </EditContext.Provider>;
});

function StaleBranchDialog({ taskId, branches, onResolved }: { taskId: string; branches: TaskTextDraftV1[]; onResolved: () => void }) {
  const coordinator = useEditorRuntime()?.coordinator ?? null;
  const [busy, setBusy] = useState(false);
  const restore = async (branchId: string) => {
    if (!coordinator || busy) return;
    setBusy(true);
    try { await coordinator.restoreBranch(taskId, branchId); onResolved(); }
    finally { setBusy(false); }
  };
  return <Dialog open><DialogContent surface="glass"><DialogHeader><DialogTitle>发现多份未同步草稿</DialogTitle><DialogDescription>这个任务存在多份不同窗口留下的草稿，自动同步已暂停。选择要继续编辑的一份。</DialogDescription></DialogHeader><div className="max-h-72 space-y-2 overflow-y-auto">{branches.map((branch) => <button key={branch.branchId} type="button" disabled={busy} className="w-full rounded-xl border border-border p-3 text-left hover:bg-[var(--glass-hover)]" onClick={() => { void restore(branch.branchId); }}>
    <p className="truncate text-sm font-medium">{branch.draft.title || '（无标题）'}</p>
    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">{branch.draft.description.slice(0, 160)}</p>
    <p className="mt-1 text-xs text-muted-foreground">更新于 {new Date(branch.updatedAt).toLocaleString()}</p>
  </button>)}</div></DialogContent></Dialog>;
}

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
  }} onKeyDown={edit.onTitleKeyDown} onCompositionStart={edit.onComposeStart} onCompositionEnd={edit.onComposeEnd} className={cn('task-writing task-title', edit.draft.status === 'done' && 'text-muted-foreground line-through', className)} />;
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
  const record = edit.textRecord;
  const textConflicts = Object.entries(record?.conflicts ?? {}) as Array<[TextField, NonNullable<TaskTextDraftV1['conflicts'][TextField]>]>;
  return <div data-task-editor className={cn('flex flex-col', fill && 'min-h-full')}>
    {textConflicts.length > 0 && <div role="alert" className="mb-3 rounded-xl border border-warning-border bg-warning-bg p-3 text-sm text-warning">
      <p className="flex items-center gap-2"><AlertTriangle className="size-4 shrink-0" aria-hidden />正文或标题与后台更新冲突，本地与远端内容都已保留。</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={edit.resolveKeepMine}>使用我的内容</Button>
        <Button type="button" variant="ghost" size="sm" onClick={edit.resolveKeepRemote}>使用最新内容</Button>
      </div>
      <pre className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/5 p-2 text-xs dark:bg-white/5">{textConflicts.map(([field, conflict]) => `${fieldLabels[field] ?? field}\n本地：${conflict.local.slice(0, 200) || '（空）'}\n远端：${conflict.remote.slice(0, 200) || '（空）'}`).join('\n\n')}</pre>
    </div>}
    {record?.blockedReason === 'invalid-title' && <div role="alert" className="mb-3 rounded-xl border border-warning-border bg-warning-bg p-3 text-sm text-warning">标题不能为空，自动保存已暂停；补齐标题后继续。</div>}
    <TaskDescription key={edit.taskId} taskId={edit.taskId} value={edit.draft.description} readonly={edit.readonly} fill={fill} openDescription={edit.openDescription} onEdit={(description) => edit.updateText({ description })} onComposeStart={edit.onComposeStart} onComposeEnd={edit.onComposeEnd} onOpenLinkedTask={(taskId) => { void edit.openLinkedTask(taskId); }} />
    <SaveStatusRow status={edit.textStatus} taskId={edit.taskId} />
    <TaskMaterials taskId={edit.taskId} topicId={edit.task?.topicId ?? null} description={edit.draft.description} readonly={edit.readonly} saveText={edit.saveText} onOpenLinkedTask={edit.openLinkedTask} />
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
  return <Button type="button" variant="outline" size="sm" className="shrink-0 rounded-lg" aria-label="任务动态" onClick={() => { void edit.saveText().then((saved) => { if (saved) onOpen(); }); }}>动态</Button>;
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

function ParentTaskLink() {
  const edit = useEdit();
  const parentId = edit.task.parentId ?? null;
  const query = useTask(parentId ?? '');
  if (parentId === null) return null;

  const unavailable = <div data-testid="task-parent-row" className="task-parent-row">父任务不可用</div>;
  const loading = <div data-testid="task-parent-row" className="task-parent-row" role="status">正在加载父任务…</div>;
  const notFound = query.error instanceof ApiError && query.error.status === 404;
  const parent = query.data;
  const matched = Boolean(parent && parent.id === parentId);
  const navigable = parentId !== edit.taskId && !notFound && matched && !parent?.deletedAt;

  const openParent = () => {
    if (!parentId || parentId === edit.taskId || !navigable) return;
    edit.openTask(parentId);
  };

  if (parentId === edit.taskId || notFound) return unavailable;
  if (parent && parent.id === parentId) {
    if (parent.deletedAt) return unavailable;
    return <div data-testid="task-parent-row" className="task-parent-row"><button type="button" data-testid="task-parent-link" className="task-parent-link" title={parent.title} aria-label={`打开父任务：${parent.title}`} onClick={openParent}><span data-testid="task-parent-title" className="task-parent-title">{parent.title}</span><ChevronRight aria-hidden="true" width={14} height={14} strokeWidth={1.5} className="task-parent-chevron" /></button></div>;
  }
  if (parent && parent.id !== parentId) return unavailable;
  if (query.isFetching) return loading;
  if (query.isError) {
    return <div data-testid="task-parent-row" className="task-parent-row"><button type="button" className="task-parent-link" aria-label="重新加载父任务" onClick={() => { void query.refetch(); }}>加载失败，重试</button></div>;
  }
  return loading;
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
  const [host] = useState(() => { const node = document.createElement('div'); node.className = 'flex h-full min-h-0 flex-col'; return node; });
  const [modalSlot, setModalSlot] = useState<HTMLDivElement | null>(null);
  const presentationRef = useRef(presentation);
  const pendingFocus = useRef<EditorCaret | null>(null);
  presentationRef.current = presentation;
  rememberEditorCaret(pendingFocus);
  usePageContext('task', { taskId: edit.taskId, taskRevision: edit.task.revision ?? null, label: `任务 · ${edit.task.title}`, scope: edit.task.topicId ? { kind: 'topic', topicId: edit.task.topicId } : { kind: 'inbox' }, selectedTaskIds: [edit.taskId] });
  useLayoutEffect(() => {
    const slot = presentation === 'panel' ? panelSlot : presentation === 'modal' ? modalSlot : null;
    if (slot) { slot.appendChild(host); if (pendingFocus.current && placeCaret(pendingFocus.current)) pendingFocus.current = null; }
    return () => { host.remove(); };
  }, [host, presentation, panelSlot, modalSlot]);
  return <>
    {createPortal(<aside role={presentation === 'modal' ? undefined : 'dialog'} aria-modal={presentation === 'modal' ? undefined : false} aria-label={presentation === 'modal' ? undefined : '任务详情'} className="flex h-full min-h-0 flex-col">{children}</aside>, host)}
    {presentation === 'modal' && <Dialog open onOpenChange={(open) => { if (!open && presentationRef.current === 'modal') edit.requestClose(); }}><DialogContent showCloseButton={false} surface="glass" motion="none" className="flex h-[min(92dvh,840px)] max-h-[92dvh] max-w-[min(42rem,calc(100%-3rem))] flex-col overflow-hidden p-0" onOpenAutoFocus={(event) => { if (pendingFocus.current) event.preventDefault(); }} onCloseAutoFocus={(event) => { if (presentationRef.current !== 'modal') event.preventDefault(); }}><DialogTitle className="sr-only">任务详情</DialogTitle><DialogDescription className="sr-only">编辑任务详情、标签、旗标和日期。</DialogDescription><div ref={setModalSlot} className="h-full min-h-0" /></DialogContent></Dialog>}
  </>;
}

function TaskAssistantActions() {
  const edit = useEdit();
  return <div className="flex flex-wrap gap-2 pb-2">
    <Button size="sm" variant="ghost" onClick={() => askAssistant()}>AI 助手</Button>
    <Button size="sm" variant="ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => askAssistant({ kind: 'draft', title: edit.draft.title || '当前任务草稿', text: `${edit.draft.title}\n\n${edit.draft.description}`, taskId: edit.taskId, unsaved: true })}>带上当前草稿</Button>
  </div>;
}

export const TaskDetailPane = forwardRef<TaskDetailHandle, Omit<Props, 'children' | 'fallback'> & { fallback?: Task; presentation: 'panel' | 'modal' | 'retained'; panelSlot: HTMLElement | null }>(function TaskDetailPane({ presentation, panelSlot, fallback, ...props }, ref) {
  const [activity, setActivity] = useState(false);
  const placeholder: Task = fallback ?? { id: props.id, title: '', description: '', status: 'todo', priority: 'none', dueDate: null, estimatedMinutes: null, scheduledStart: null, scheduledEnd: null, resultSummary: '', topicId: null, parentId: null, tagIds: [], allowedTransitions: [] };
  return <TaskExpand ref={ref} {...props} fallback={placeholder}>
    <DetailFrame presentation={presentation} panelSlot={panelSlot}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="task-detail-header">
          <TaskAssistantActions />
          <ParentTaskLink />
          <div data-testid="task-detail-title-row" className="flex min-w-0 items-start gap-2"><TaskStatusCheckbox /><div className="min-w-0 flex-1"><TaskTitleField /></div><ActivityButton onOpen={() => setActivity(true)} /><CloseDetailButton /></div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5"><TaskExpandBody fill /></div>
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

export { saveStatusLabel };
