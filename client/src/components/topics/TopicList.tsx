import { Pencil, Plus, Settings } from 'lucide-react';
import type { Topic } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { Button } from '@/components/ui/button.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { ThemeToggle } from '@/components/layout/ThemeToggle.js';

type TopicListProps = {
  topics: Topic[];
  loading: boolean;
  selectedTopicId: string;
  onSelect: (id: string) => void;
  onEdit: (topic: Topic) => void;
  className?: string;
};

export function TopicList({ topics, loading, selectedTopicId, onSelect, onEdit, className }: TopicListProps) {
  if (loading) {
    return (
      <div className={cn('flex flex-col gap-1.5', className)}>
        {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-9 w-full" />)}
      </div>
    );
  }
  if (!topics.length) {
    return <p className="rounded-xl border border-dashed border-[var(--glass-border)] px-3 py-4 text-xs leading-relaxed text-muted-foreground">还没有清单，先创建一个。</p>;
  }
  return (
    <div className={cn('sidebar-topic-list flex flex-col gap-1', className)}>
      {topics.map((topic) => (
        <div
          key={topic.id}
          data-active={topic.id === selectedTopicId}
          className={cn('sidebar-topic-item group relative flex min-w-0 items-center rounded-xl border border-transparent', topic.id === selectedTopicId ? 'border-primary/20 bg-primary/[0.09] shadow-[inset_0_1px_0_rgb(255_255_255/0.35)] dark:bg-primary/[0.14]' : 'hover:border-[var(--glass-border)] hover:bg-[var(--glass-hover)]')}
        >
          <button type="button" onClick={() => onSelect(topic.id)} aria-current={topic.id === selectedTopicId ? 'page' : undefined} className={cn('relative flex min-h-11 min-w-0 flex-1 items-center gap-2.5 px-2.5 text-left text-[13px] transition-[color,transform] duration-200 lg:min-h-10', topic.id === selectedTopicId ? 'font-semibold text-primary' : 'text-foreground/75 hover:translate-x-0.5 hover:text-foreground')}>
            <span className={cn('size-1.5 shrink-0 rounded-full transition-[background-color,box-shadow,transform] duration-200', topic.id === selectedTopicId ? 'scale-110 bg-primary shadow-[0_0_0_3px_var(--accent)]' : 'bg-muted-foreground/40')} />
            <span className="truncate">{topic.name}</span>
            {topic.isExploration && <em className="glass-topic-badge ml-auto flex w-10 shrink-0 items-center justify-center whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] not-italic text-explore">探索</em>}
          </button>
          <button type="button" title="编辑清单" aria-label={`编辑清单：${topic.name}`} onClick={() => onEdit(topic)} className="mr-1 grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-100 transition-[background-color,color,opacity,transform] duration-200 hover:scale-105 hover:bg-[var(--glass-hover)] hover:text-foreground lg:opacity-0 lg:group-hover:opacity-100">
            <Pencil className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

type TopicListPageProps = {
  topics: Topic[];
  topicsLoading: boolean;
  selectedTopicId: string;
  onSelectTopic: (id: string) => void;
  onNewTopic: () => void;
  onEditTopic: (topic: Topic) => void;
  onOpenSettings: () => void;
};

export function TopicListPage({ topics, topicsLoading, selectedTopicId, onSelectTopic, onNewTopic, onEditTopic, onOpenSettings }: TopicListPageProps) {
  return (
    <div className="flex h-full flex-col bg-background/80">
      <header className="flex items-center justify-between gap-2 border-b glass-divider px-4 py-3.5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">清单</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">把相关任务放在一起</p>
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Button variant="ghost" size="icon" title="设置" aria-label="设置" onClick={onOpenSettings}><Settings /></Button>
        </div>
      </header>
      <div className="glass-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
        <Button className="mb-3 w-full" onClick={onNewTopic}><Plus />新建清单</Button>
        <TopicList topics={topics} loading={topicsLoading} selectedTopicId={selectedTopicId} onSelect={onSelectTopic} onEdit={onEditTopic} />
      </div>
    </div>
  );
}
