import { Inbox, Plus, Settings, Trash2, History } from 'lucide-react';
import type { Topic } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';
import { TopicList } from '@/components/topics/TopicList.js';
import { ThemeToggle } from './ThemeToggle.js';

type SidebarProps = {
  topics: Topic[];
  topicsLoading: boolean;
  selectedTopicId: string;
  onSelectTopic: (id: string) => void;
  onNewTopic: () => void;
  onEditTopic: (topic: Topic) => void;
  settingsActive: boolean;
  onToggleSettings: () => void;
  trashActive: boolean;
  onOpenTrash: () => void;
  changesActive: boolean;
  onOpenChanges: () => void;
  inboxActive: boolean;
  onOpenInbox: () => void;
};

export function Sidebar({ topics, topicsLoading, selectedTopicId, onSelectTopic, onNewTopic, onEditTopic, settingsActive, onToggleSettings, trashActive, onOpenTrash, changesActive, onOpenChanges, inboxActive, onOpenInbox }: SidebarProps) {
  const navItemClass = 'sidebar-nav-item group relative flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-xs';
  const navItemState = (active: boolean) => cn(navItemClass, active ? 'font-semibold text-primary' : 'text-muted-foreground hover:text-foreground');

  return (
    <aside className="glass-surface relative flex h-full min-h-0 flex-col overflow-hidden rounded-none border-y-0 border-l-0 px-3 pt-5 pb-4">
      <div className="pointer-events-none absolute -right-16 -top-20 size-44 rounded-full bg-primary/10 blur-3xl" aria-hidden="true" />
      <div className="relative mb-7 flex items-center gap-3 px-2">
        <span className="sidebar-brand-mark grid size-9 place-items-center rounded-xl bg-foreground text-sm font-extrabold text-background shadow-sm">A</span>
        <div className="min-w-0">
          <strong className="block truncate text-sm tracking-wide">Agent 工作室</strong>
          <small className="mt-0.5 block text-[11px] text-muted-foreground">工作推进台</small>
        </div>
        <span className="ml-auto size-1.5 shrink-0 rounded-full bg-success shadow-[0_0_0_3px_var(--success-bg)]" title="工作区已连接" aria-label="工作区已连接" />
      </div>
      <div className="relative mb-2 flex items-center justify-between px-2">
        <span className="text-[10px] font-bold tracking-[0.16em] text-muted-foreground uppercase">主题空间</span>
        <Button variant="ghost" size="icon-xs" className="sidebar-icon-button" title="新建主题" aria-label="新建主题" onClick={onNewTopic}><Plus /></Button>
      </div>
      <div className="glass-scrollbar relative min-h-0 flex-1 overflow-y-auto px-0.5">
        <TopicList topics={topics} loading={topicsLoading} selectedTopicId={selectedTopicId} onSelect={onSelectTopic} onEdit={onEditTopic} />
      </div>
      <div className="glass-divider relative mt-auto border-t pt-3">
        <span className="mb-2 block px-2 text-[10px] font-bold tracking-[0.16em] text-muted-foreground uppercase">工作区</span>
        <button type="button" onClick={onOpenInbox} data-active={inboxActive} className={navItemState(inboxActive)}><Inbox className="size-4 transition-transform duration-200 group-hover:scale-105" />收集箱</button>
        <button type="button" onClick={onOpenTrash} data-active={trashActive} className={navItemState(trashActive)}><Trash2 className="size-4 transition-transform duration-200 group-hover:scale-105" />回收站</button>
        <button type="button" onClick={onOpenChanges} data-active={changesActive} className={navItemState(changesActive)}><History className="size-4 transition-transform duration-200 group-hover:scale-105" />变更历史</button>
        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleSettings}
            data-active={settingsActive}
            className={cn(navItemState(settingsActive), 'flex-1')}
          >
            <Settings className="size-4 transition-transform duration-200 group-hover:rotate-12" />设置
          </button>
          <ThemeToggle />
        </div>
        <small className="mt-3 block px-2 text-[11px] text-muted-foreground/75">本地工作区</small>
      </div>
    </aside>
  );
}
