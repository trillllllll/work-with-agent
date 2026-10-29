import { Surface } from '@/components/ui/surface.js';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Grid2X2, Kanban, LayoutList, Library, MessageSquare, Pencil, Plus } from 'lucide-react';
import type { Topic, View } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { intlLocale } from '@/i18n/index.js';
import { cn } from '@/lib/utils.js';

const plusDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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
  const { t } = useTranslation('tasks');
  return (
    <header className={`dovun-page-header mb-5${page === 'today' ? ' dovun-today-header' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {page === 'today' && <p className="dovun-page-date">{new Intl.DateTimeFormat(intlLocale(), { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${today}T12:00:00`))}</p>}<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {page === 'board' && detail && Boolean(detail.goal || detail.goalDueDate) && <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span className="line-clamp-2 whitespace-pre-wrap">{detail.goal}</span>{detail.goalDueDate && <span className={cn('task-meta-pill shrink-0', detail.goalDueDate < today ? 'text-destructive' : detail.goalDueDate <= plusDays(today, 7) && 'text-warning')}>{t('listPageHeader.goalDue', { date: new Intl.DateTimeFormat(intlLocale(), { month: 'short', day: 'numeric' }).format(new Date(`${detail.goalDueDate}T12:00:00`)) })}{detail.goalDueDate < today ? ` · ${t('listPageHeader.goalOverdue')}` : ''}</span>}</p>}
          {page === 'board' && detail && <Button variant="plain" size="bare" type="button" className="topic-jump" onClick={onOpenKnowledge}><Library aria-hidden />{t('listPageHeader.workContext')}<ChevronRight aria-hidden /></Button>}
          {page === 'board' && briefNotes && <p className="line-clamp-2 text-sm whitespace-pre-wrap text-muted-foreground">{briefNotes}</p>}
          {filterSummary && <p className="text-xs text-muted-foreground">{filterSummary}</p>}
          {page === 'inbox' && <p className="max-w-xl text-xs text-muted-foreground">{t('listPageHeader.inboxHint')}</p>}

          {archived && <p className="text-sm text-muted-foreground">{t('listPageHeader.archivedReadonly')}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {page === 'board' && detail && filterBar}
          <Button variant="ghost" size="icon" className="max-lg:hidden" aria-label={t('listPageHeader.openChat')} onClick={onOpenChat}><MessageSquare /></Button>
          {page === 'board' && detail && !archived && <Button variant="ghost" size="icon" aria-label={t('listPageHeader.editList', { name: detail.name })} onClick={onEditTopic}><Pencil /></Button>}
          {scoped && <Surface as="div" tone="input" className={cn('flex rounded-xl', page === 'board' ? 'gap-0.5' : 'glass-control p-1')}>{page === 'board' ? <><Button variant={layout === 'list' ? 'secondary' : 'ghost'} size="icon-sm" aria-label={t('listPageHeader.listLayout')} onClick={() => onLayout('list')}><LayoutList /></Button><Button variant={layout === 'board' ? 'secondary' : 'ghost'} size="icon-sm" aria-label={t('listPageHeader.boardLayout')} onClick={() => onLayout('board')}><Kanban /></Button><Button variant={layout === 'quadrant' ? 'secondary' : 'ghost'} size="icon-sm" aria-label={t('listPageHeader.quadrantLayout')} onClick={() => onLayout('quadrant')}><Grid2X2 /></Button></> : page !== 'quadrant' && <><Button variant={layout === 'list' ? 'secondary' : 'ghost'} size="sm" onClick={() => onLayout('list')}>{t('listPageHeader.listLayout')}</Button><Button variant={layout === 'board' ? 'secondary' : 'ghost'} size="sm" onClick={() => onLayout('board')}>{t('listPageHeader.boardLayout')}</Button></>}</Surface>}
          {(scoped || page === 'today') && !archived && page !== 'board' && page !== 'quadrant' && <Button onClick={onNewTask}><Plus />{t('listPageHeader.newTask')}</Button>}
        </div>
      </div>
    </header>
  );
}
