import { Plus, Settings, Trash2, History } from 'lucide-react';
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
};

export function Sidebar({ topics, topicsLoading, selectedTopicId, onSelectTopic, onNewTopic, onEditTopic, settingsActive, onToggleSettings, trashActive, onOpenTrash, changesActive, onOpenChanges }: SidebarProps) {
  return (
    <aside className="glass-surface flex h-full min-h-0 flex-col border-y-0 border-l-0 rounded-none px-3 pt-5 pb-4">
      <div className="mb-7 flex items-center gap-2.5 px-2">
        <span className="grid size-8 place-items-center rounded-lg bg-foreground text-sm font-extrabold text-background">A</span>
        <div>
          <strong className="block text-sm tracking-wide">Agent 工作室</strong>
          <small className="mt-0.5 block text-[11px] text-muted-foreground">工作推进台</small>
        </div>
      </div>
      <div className="mb-2 flex items-center justify-between px-2">
        <span className="text-[11px] font-bold tracking-[0.12em] text-muted-foreground uppercase">主题</span>
        <Button variant="ghost" size="icon-xs" title="新建主题" aria-label="新建主题" onClick={onNewTopic}><Plus /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TopicList topics={topics} loading={topicsLoading} selectedTopicId={selectedTopicId} onSelect={onSelectTopic} onEdit={onEditTopic} />
      </div>
      <div className="glass-divider mt-auto border-t pt-3">
        <button type="button" onClick={onOpenTrash} className={cn('mb-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-xs transition-colors', trashActive ? 'bg-accent font-bold text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}><Trash2 className="size-3.5" />回收站</button>
        <button type="button" onClick={onOpenChanges} className={cn('mb-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-xs transition-colors', changesActive ? 'bg-accent font-bold text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}><History className="size-3.5" />变更历史</button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleSettings}
            className={cn('flex h-9 flex-1 items-center gap-2 rounded-md px-2 text-xs transition-colors', settingsActive ? 'bg-accent font-bold text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}
          >
            <Settings className="size-3.5" />设置
          </button>
          <ThemeToggle />
        </div>
        <small className="mt-2 block px-2 text-[11px] text-muted-foreground">本地工作区</small>
      </div>
    </aside>
  );
}
