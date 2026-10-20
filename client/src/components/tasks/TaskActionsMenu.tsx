import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { intlLocale, t as translate } from '../../i18n/index.js';
import { ArrowDown, ArrowUp, FolderInput, MoreHorizontal, Trash2 } from 'lucide-react';
import { api, availableTaskStatuses, statuses, type Tag, type Task, type TaskTopicHistory, type Topic } from '@/lib/api.js';
import { canHaveSubtasks, type TaskDraft } from '@/lib/todo.js';
import { useTask, useTasks } from '@/hooks/useTodo.js';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/components/ui/context-menu.js';
import { QuickCapture } from './QuickCapture.js';
import { HandoffPanel } from '@/components/workspace/HandoffPanel.js';
import { KnowledgePage } from '@/components/workspace/KnowledgePage.js';
import { reorderTaskGroup } from './task-order.js';
import { TaskActivityDialog } from './TaskActivityDialog.js';

type DialogKind = 'children' | 'result' | 'history' | 'activity' | 'knowledge' | 'handoff' | null;
export type TaskActionProps = {
  topics: Topic[];
  tags: Tag[];
  readonly?: boolean;
  busy?: boolean;
  textDirty?: boolean;
  onOpen: (id: string) => void;
  onToggle: (task: Task) => Promise<unknown>;
  onMove: (task: Task, topicId: string | null) => Promise<unknown>;
  onDelete: (task: Task) => void;
  onSave: (task: Task, patch: Partial<TaskDraft>) => Promise<Task | undefined>;
  onCreate: (input: { title: string; topicId: string | null; parentId: string | null }) => Promise<unknown>;
  onReorder?: (tasks: Task[], parentId: string | null) => Promise<unknown>;
};
type ItemProps = { children: ReactNode; disabled?: boolean; variant?: 'default' | 'destructive'; onSelect?: (event: Event) => void; 'aria-label'?: string };
type Parts = { Item: (props: ItemProps) => ReactNode; Separator: () => ReactNode; Sub: (props: { children: ReactNode }) => ReactNode; SubTrigger: (props: { children: ReactNode }) => ReactNode; SubContent: (props: { children: ReactNode }) => ReactNode };
type MenuContext = TaskActionProps & {
  task: Task;
  group: Task[];
  index: number;
  parents: Task[];
  hasChildren: boolean;
  setDialog: (kind: DialogKind) => void;
  setMenuOpen: (open: boolean) => void;
};
const MenuContext = createContext<MenuContext | null>(null);
function useMenu() {
  const value = useContext(MenuContext);
  if (!value) throw new Error(translate('tasks:taskActions.menuNotReady'));
  return value;
}
function stopDrag(event: { stopPropagation: () => void }) { event.stopPropagation(); }
// The menu is portaled, but React still bubbles the click to the task row and opens the detail dialog.
function containMenuEvent(event: { stopPropagation: () => void }) { event.stopPropagation(); }

const subTriggerClass = 'rounded-lg focus:bg-[var(--menu-highlight)] data-[state=open]:bg-[var(--menu-highlight)]';
function SubPanel({ children }: { children: ReactNode }) {
  return <div className="max-h-80 min-w-44 overflow-y-auto p-1" onClick={containMenuEvent} onPointerDown={containMenuEvent}>{children}</div>;
}
const dropdownParts: Parts = {
  Item: (props) => <DropdownMenuItem variant={props.variant} disabled={props.disabled} aria-label={props['aria-label']} onSelect={(event) => props.onSelect?.(event)}>{props.children}</DropdownMenuItem>,
  Separator: () => <DropdownMenuSeparator />,
  Sub: (props) => <DropdownMenuSub>{props.children}</DropdownMenuSub>,
  SubTrigger: (props) => <DropdownMenuSubTrigger className={subTriggerClass}>{props.children}</DropdownMenuSubTrigger>,
  SubContent: (props) => <DropdownMenuSubContent className="w-auto p-0"><SubPanel>{props.children}</SubPanel></DropdownMenuSubContent>,
};
const contextParts: Parts = {
  Item: (props) => <ContextMenuItem variant={props.variant} disabled={props.disabled} aria-label={props['aria-label']} onSelect={(event) => props.onSelect?.(event)}>{props.children}</ContextMenuItem>,
  Separator: () => <ContextMenuSeparator />,
  Sub: (props) => <ContextMenuSub>{props.children}</ContextMenuSub>,
  SubTrigger: (props) => <ContextMenuSubTrigger className={subTriggerClass}>{props.children}</ContextMenuSubTrigger>,
  SubContent: (props) => <ContextMenuSubContent className="w-auto p-0"><SubPanel>{props.children}</SubPanel></ContextMenuSubContent>,
};

function openDialog(setDialog: (kind: DialogKind) => void, kind: Exclude<DialogKind, null>) {
  window.setTimeout(() => setDialog(kind), 0);
}
function MenuItems({ parts }: { parts: Parts }) {
  const { t } = useTranslation('tasks');
  const { Item, Separator, Sub, SubTrigger, SubContent } = parts;
  const { task, topics, group, index, parents, hasChildren, readonly, busy, onMove, onDelete, onSave, onReorder, setDialog } = useMenu();
  const save = (patch: Partial<TaskDraft>) => { void onSave(task, patch); };
  const show = (kind: Exclude<DialogKind, null>) => openDialog(setDialog, kind);
  return <div className="min-w-44 p-1">
    {!readonly && <Sub><SubTrigger>{t('taskActions.status')}</SubTrigger><SubContent>{statuses.filter((item) => availableTaskStatuses(task).includes(item.value)).map((item) => <Item key={item.value} disabled={busy || task.status === item.value} onSelect={() => save({ status: item.value })}>{item.label}</Item>)}</SubContent></Sub>}
    {!readonly && canHaveSubtasks(task) && <Item disabled={busy} onSelect={() => show('children')}>{t('taskActions.addSubtask')}</Item>}
    {!readonly && <Sub><SubTrigger>{t('taskActions.makeSubtask')}</SubTrigger><SubContent>
      <Item disabled={busy || hasChildren || !task.parentId} onSelect={() => save({ parentId: null })}>{t('taskActions.noParent')}</Item>
      {parents.map((parent) => <Item key={parent.id} disabled={busy || hasChildren || task.parentId === parent.id} onSelect={() => save({ parentId: parent.id })}>{parent.title}</Item>)}
      {hasChildren && <Item disabled>{t('taskActions.hasChildren')}</Item>}
      {!hasChildren && !parents.length && <Item disabled>{t('taskActions.noParents')}</Item>}
    </SubContent></Sub>}
    {!readonly && <Sub><SubTrigger><FolderInput />{t('taskActions.moveTo')}</SubTrigger><SubContent>
      <Item disabled={busy || !task.topicId} onSelect={() => { void onMove(task, null); }}>{t('shared.inbox')}</Item>
      {topics.map((topic) => <Item key={topic.id} disabled={busy || task.topicId === topic.id} onSelect={() => { void onMove(task, topic.id); }}>{topic.name}</Item>)}
    </SubContent></Sub>}
    <Item onSelect={() => show('result')}>{t('taskActions.result')}</Item>
    <Item onSelect={() => show('history')}>{t('taskActions.history')}</Item>
    <Item onSelect={() => show('activity')}>{t('taskActions.activity')}</Item>
    <Item onSelect={() => show('knowledge')}>{t('taskActions.materials')}</Item>
    {!readonly && <Item disabled={busy} onSelect={() => show('handoff')}>{t('taskActions.handoff')}</Item>}
    {!readonly && onReorder && <><Separator /><Item disabled={busy || index === 0} aria-label={t('taskActions.moveUpAria', { title: task.title })} onSelect={() => { const next = reorderTaskGroup(group, task.id, group[index - 1]?.id ?? ''); if (next) void onReorder(next, task.parentId ?? null); }}><ArrowUp />{t('taskActions.moveUp')}</Item><Item disabled={busy || index === group.length - 1} aria-label={t('taskActions.moveDownAria', { title: task.title })} onSelect={() => { const next = reorderTaskGroup(group, task.id, group[index + 1]?.id ?? ''); if (next) void onReorder(next, task.parentId ?? null); }}><ArrowDown />{t('taskActions.moveDown')}</Item></>}
    {!readonly && <><Separator /><Item variant="destructive" aria-label={t('shared.deleteTask', { title: task.title })} onSelect={() => onDelete(task)}><Trash2 />{t('taskActions.trash')}</Item></>}
  </div>;
}

export function TaskMenuButton() {
  const { t } = useTranslation('tasks');
  const { task, busy, setMenuOpen } = useMenu();
  return <DropdownMenu modal={false} onOpenChange={setMenuOpen}>
    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" disabled={busy} aria-label={t('taskActions.actionsAria', { title: task.title })} onMouseDown={stopDrag} onTouchStart={stopDrag} onPointerDown={stopDrag}><MoreHorizontal /></Button></DropdownMenuTrigger>
    <DropdownMenuContent side="left" align="start" sideOffset={8} className="z-[80] w-auto p-0" onClick={containMenuEvent} onPointerDown={containMenuEvent}><MenuItems parts={dropdownParts} /></DropdownMenuContent>
  </DropdownMenu>;
}

export function TaskActions({ task, group = [], index = 0, children, ...actions }: TaskActionProps & { task: Task; group?: Task[]; index?: number; children: ReactNode }) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const menuOpen = dropdownOpen || contextOpen || dialog !== null;
  const allTasks = useTasks(actions.readonly ? { includeArchived: 'true' } : {}, menuOpen);
  const parents = (allTasks.data ?? []).filter((candidate) => candidate.id !== task.id && !candidate.parentId && candidate.topicId === task.topicId);
  const hasChildren = (allTasks.data ?? []).some((candidate) => candidate.parentId === task.id) || Boolean(task.children?.length);
  const value: MenuContext = { ...actions, task, group, index, parents, hasChildren, setDialog, setMenuOpen: setDropdownOpen };
  return <MenuContext.Provider value={value}>
    <ContextMenu modal={false} onOpenChange={setContextOpen}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="z-[80] w-auto p-0"><MenuItems parts={contextParts} /></ContextMenuContent>
    </ContextMenu>
    <TaskDialogs dialog={dialog} onOpenChange={setDialog} tasks={allTasks.data ?? []} />
  </MenuContext.Provider>;
}

function TaskDialogs({ dialog, onOpenChange, tasks }: { dialog: DialogKind; onOpenChange: (kind: DialogKind) => void; tasks: Task[] }) {
  const { t } = useTranslation('tasks');
  const menu = useMenu();
  const { task, topics, readonly, textDirty, onOpen, onToggle, onDelete, onSave, onCreate } = menu;
  const detail = useTask(dialog === 'children' || dialog === 'handoff' ? task.id : '');
  const history = useQuery<TaskTopicHistory[]>({ queryKey: ['task-topic-history', task.id], queryFn: () => api(`/api/tasks/${task.id}/topic-history`), enabled: dialog === 'history' });
  const [summary, setSummary] = useState(task.resultSummary ?? '');
  useEffect(() => { if (dialog === 'result') setSummary(task.resultSummary ?? ''); }, [dialog, task.id, task.resultSummary]);
  const close = (open: boolean) => { if (!open) onOpenChange(null); };
  const children = detail.data?.children ?? tasks.filter((item) => item.parentId === task.id);
  return <>
    <Dialog open={dialog === 'children'} onOpenChange={close}><DialogContent surface="glass" className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{t('taskActions.subtasksTitle')}</DialogTitle><DialogDescription>{t('taskActions.subtasksDescription')}</DialogDescription></DialogHeader><div className="space-y-3">{children.map((child) => <div key={child.id} className="flex items-center gap-2"><input type="checkbox" className="task-checkbox size-[18px] accent-primary" checked={child.status === 'done'} disabled={readonly} aria-label={t(child.status === 'done' ? 'shared.reopenTask' : 'shared.completeTask', { title: child.title })} onChange={() => { void onToggle(child); }} /><button type="button" className="min-w-0 flex-1 text-left text-sm" onClick={() => { onOpenChange(null); onOpen(child.id); }}>{child.title}</button><Button type="button" variant="ghost" size="sm" disabled={readonly} aria-label={t('shared.deleteTask', { title: child.title })} onClick={() => onDelete(child)}>{t('taskActions.trash')}</Button></div>)}{!children.length && <p className="text-sm text-muted-foreground">{t('taskActions.noSubtasks')}</p>}{!readonly && canHaveSubtasks(task) && <QuickCapture key={`${task.topicId}.${task.id}`} topicId={task.topicId ?? null} parentId={task.id} onCreate={onCreate} />}</div></DialogContent></Dialog>
    <Dialog open={dialog === 'result'} onOpenChange={close}><DialogContent surface="glass"><DialogHeader><DialogTitle>{t('taskActions.result')}</DialogTitle><DialogDescription>{t('taskActions.resultDescription')}</DialogDescription></DialogHeader>{readonly ? <p className="whitespace-pre-wrap text-sm">{task.resultSummary || t('taskActions.noResult')}</p> : <><Textarea aria-label={t('taskActions.result')} value={summary} onChange={(event) => setSummary(event.target.value)} /><Button disabled={summary === (task.resultSummary ?? '')} onClick={() => { void onSave(task, { resultSummary: summary }).then((result) => { if (result) onOpenChange(null); }); }}>{t('taskActions.saveResult')}</Button></>}</DialogContent></Dialog>
    <Dialog open={dialog === 'history'} onOpenChange={close}><DialogContent surface="glass"><DialogHeader><DialogTitle>{t('taskActions.history')}</DialogTitle><DialogDescription>{t('taskActions.historyDescription')}</DialogDescription></DialogHeader><div className="max-h-80 space-y-2 overflow-y-auto text-sm text-muted-foreground">{history.isLoading && <p>{t('shared.loading')}</p>}{(history.data ?? []).map((item) => <p key={item.id}>{t('taskActions.historyMove', { from: item.fromTopic?.name ?? t('shared.inbox'), to: item.toTopic?.name ?? t('shared.inbox'), time: new Date(item.changedAt).toLocaleString(intlLocale()) })}</p>)}{history.data && !history.data.length && <p>{t('taskActions.noHistory')}</p>}</div></DialogContent></Dialog>
    <TaskActivityDialog taskId={task.id} open={dialog === 'activity'} onOpenChange={close} />
    <Dialog open={dialog === 'knowledge'} onOpenChange={close}><DialogContent surface="glass" className="max-h-[88dvh] max-w-[min(56rem,calc(100%-3rem))] overflow-y-auto"><DialogHeader><DialogTitle>{t('taskActions.materials')}</DialogTitle><DialogDescription>{t('taskActions.materialsDescription')}</DialogDescription></DialogHeader><KnowledgePage key={`${task.id}:${task.topicId ?? ''}`} topics={topics} initialTopicId={task.topicId ?? ''} taskId={task.id} initialTab="materials" /></DialogContent></Dialog>
    <Dialog open={dialog === 'handoff'} onOpenChange={close}><DialogContent surface="glass" className="max-h-[88dvh] max-w-[min(42rem,calc(100%-3rem))] overflow-y-auto"><DialogHeader><DialogTitle>{t('taskActions.handoff')}</DialogTitle><DialogDescription>{t('taskActions.handoffDescription')}</DialogDescription></DialogHeader>{detail.data && <HandoffPanel task={detail.data} disabled={Boolean(textDirty)} />}</DialogContent></Dialog>
  </>;
}
