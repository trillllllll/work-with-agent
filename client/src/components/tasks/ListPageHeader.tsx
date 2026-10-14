import type { ReactNode } from 'react';
import { ChevronRight, Grid2X2, Kanban, LayoutList, Library, MessageSquare, Pencil, Plus } from 'lucide-react';
import type { Topic, View } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';

type Layout = 'list' | 'board' | 'quadrant';

type Props = {
  page: View;
  title: string;
  scoped: boolean;
  archived: boolean;
  today: string;
  detail?: Topic;
  briefNotes: string;
  filterSummary: string;
  layout: Layout;
  onLayout: (layout: Layout) => void;
  onOpenChat: () => void;
  onOpenKnowledge: () => void;
  onEditTopic: () => void;
  onNewTask: () => void;
  filterBar?: ReactNode;
};

export function ListPageHeader({ page, title, scoped, archived, today, detail, briefNotes, filterSummary, layout, onLayout, onOpenChat, onOpenKnowledge, onEditTopic, onNewTask, filterBar }: Props) {
  return (
    <header className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {page === 'board' && detail?.goal && <p className="line-clamp-1 text-sm text-muted-foreground">{detail.goal}</p>}
          {page === 'board' && detail && <button type="button" className="topic-jump" onClick={onOpenKnowledge}><Library aria-hidden />工作上下文<ChevronRight aria-hidden /></button>}
          {page === 'board' && briefNotes && <p className="line-clamp-2 text-sm whitespace-pre-wrap text-muted-foreground">{briefNotes}</p>}
          {filterSummary && <p className="text-xs text-muted-foreground">{filterSummary}</p>}
          {page === 'inbox' && <p className="max-w-xl text-xs text-muted-foreground">这是一个分类，这里只显示放在收集箱里的任务。</p>}
          {page === 'today' && <p className="text-xs text-muted-foreground">{today} · 未完成的到期任务</p>}
          {archived && <p className="text-sm text-muted-foreground">此清单已归档，内容只读。</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {page === 'board' && detail && filterBar}
          <Button variant="ghost" size="icon" aria-label="打开聊天" onClick={onOpenChat}><MessageSquare /></Button>
          {page === 'board' && detail && !archived && <Button variant="ghost" size="icon" aria-label={`编辑清单：${detail.name}`} onClick={onEditTopic}><Pencil /></Button>}
          {scoped && <div className={cn('flex rounded-xl', page === 'board' ? 'gap-0.5' : 'glass-control p-1')}>{page === 'board' ? <><Button variant={layout === 'list' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="列表" onClick={() => onLayout('list')}><LayoutList /></Button><Button variant={layout === 'board' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="看板" onClick={() => onLayout('board')}><Kanban /></Button><Button variant={layout === 'quadrant' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="四象限" onClick={() => onLayout('quadrant')}><Grid2X2 /></Button></> : page !== 'quadrant' && <><Button variant={layout === 'list' ? 'secondary' : 'ghost'} size="sm" onClick={() => onLayout('list')}>列表</Button><Button variant={layout === 'board' ? 'secondary' : 'ghost'} size="sm" onClick={() => onLayout('board')}>看板</Button></>}</div>}
          {scoped && !archived && page !== 'board' && page !== 'quadrant' && <Button onClick={onNewTask}><Plus />新建任务</Button>}
        </div>
      </div>
    </header>
  );
}
