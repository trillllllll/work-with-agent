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
    return <p className="px-2 py-3 text-xs text-muted-foreground">还没有主题，先创建一个。</p>;
  }
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      {topics.map((topic) => (
        <div
          key={topic.id}
          className={cn('group flex min-w-0 items-center rounded-xl border border-transparent transition-colors', topic.id === selectedTopicId ? 'border-primary/15 bg-primary/[0.08] shadow-[inset_0_1px_0_rgb(255_255_255/0.35)] dark:bg-primary/[0.14]' : 'hover:bg-[var(--glass-hover)]')}
        >
          <button type="button" onClick={() => onSelect(topic.id)} className={cn('flex min-h-11 min-w-0 flex-1 items-center gap-2.5 px-2.5 text-left text-[13px] transition-colors lg:min-h-9', topic.id === selectedTopicId ? 'font-semibold text-primary' : 'text-foreground/75 hover:text-foreground')}>
            <span className={cn('size-1.5 shrink-0 rounded-full', topic.id === selectedTopicId ? 'bg-primary' : 'bg-muted-foreground/40')} />
            <span className="truncate">{topic.name}</span>
            {topic.isExploration && <em className="ml-auto flex w-10 shrink-0 items-center justify-center whitespace-nowrap rounded-full border border-explore-border bg-explore-bg px-1.5 py-0.5 text-[10px] not-italic text-explore">探索</em>}
          </button>
          <button type="button" title="编辑主题" aria-label={`编辑主题：${topic.name}`} onClick={() => onEdit(topic)} className="mr-1 grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--glass-hover)] hover:text-foreground lg:opacity-0 lg:group-hover:opacity-100">
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
          <h1 className="text-lg font-semibold tracking-tight">主题</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">任务是逐渐收敛成结果的容器</p>
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Button variant="ghost" size="icon" title="设置" aria-label="设置" onClick={onOpenSettings}><Settings /></Button>
        </div>
      </header>
      <div className="glass-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
        <Button className="mb-3 w-full" onClick={onNewTopic}><Plus />新建主题</Button>
        <TopicList topics={topics} loading={topicsLoading} selectedTopicId={selectedTopicId} onSelect={onSelectTopic} onEdit={onEditTopic} />
      </div>
    </div>
  );
}
