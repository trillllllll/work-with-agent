import { Button } from '@/components/ui/button.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Plus } from 'lucide-react';
import type { Topic, View } from '@/lib/api.js';
import { navigationGroups, navigationItem } from '@/lib/navigation-items.js';
import { usePendingProposalCount } from '@/lib/use-pending-proposal-count.js';
import { TopicList } from '@/components/topics/TopicList.js';
import { BrandMark } from '@/components/layout/BrandMark.js';
import { NavCount } from '@/components/layout/NavCount.js';
import { ThemeToggle } from '@/components/layout/ThemeToggle.js';
import { SidebarScroll } from '@/components/layout/SidebarScroll.js';

type SidebarProps = {
  compact?: boolean; route: View; page: View; topics: Topic[]; topicsLoading: boolean;
  selectedTopicId: string; onNavigate: (view: View) => void; onOpenAssistant: () => void; assistantOpen: boolean;
  onSelectTopic: (id: string) => void; onEditTopic: (topic: Topic) => void; onNewTopic: () => void;
};

export function Sidebar({ compact, route, page, topics, topicsLoading, selectedTopicId, onNavigate, onOpenAssistant, assistantOpen, onSelectTopic, onEditTopic, onNewTopic }: SidebarProps) {
  const { t } = useTranslation(['settings', 'app']);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const pending = usePendingProposalCount().data?.pending;
  const link = (view: View) => {
    const { label, icon: Icon } = navigationItem(view);
    const isChat = view === 'chat';
    return <Button variant="row" size="bare" key={view} type="button" title={label} aria-label={isChat && route !== 'chat' ? t('app:shell.openAssistant') : label} aria-current={route === view ? 'page' : undefined} aria-expanded={isChat ? assistantOpen : undefined} aria-controls={isChat && route !== 'chat' ? 'work-rail-panel-assistant' : undefined} data-active={route === view || (isChat && assistantOpen && route !== 'chat') || undefined} className="sidebar-link" onClick={() => isChat ? onOpenAssistant() : onNavigate(view)}>
      <Icon aria-hidden className="size-4" strokeWidth={1.75} />
      {!compact && <><span className="min-w-0 flex-1 truncate">{label}</span>{view === 'proposals' && <NavCount count={pending} />}</>}
      {compact && view === 'proposals' && Boolean(pending) && <span className="dovun-rail-badge" />}
    </Button>;
  };
  const sectionTitle = (id: string) => <div className="sidebar-section">{id === 'lists' ? <Button variant="plain" size="bare" onClick={() => onNavigate('topics')}>{t('app:groups.lists')}</Button> : <span>{t(`app:groups.${id}`)}</span>}
    {id === 'lists' && <Button variant="row" size="bare" type="button" className="sidebar-add" aria-label={t('sidebar.newList')} onClick={onNewTopic}><Plus className="size-3.5" aria-hidden /></Button>}
  </div>;
  const groupItems = (id: string, views: readonly View[]) => id === 'lists' ? <>{link('inbox')}<TopicList variant="sidebar" topics={topics} loading={topicsLoading} selectedTopicId={page === 'board' ? selectedTopicId : ''} onSelect={onSelectTopic} onEdit={onEditTopic} />{link('tags')}{link('archived')}</> : views.map(link);

  return <aside className={`app-sidebar${compact ? ' assistant-compact-nav' : ''}`} style={{ gridColumn: 1, gridRow: 1 }}>
    <div className="sidebar-header"><BrandMark compact={compact} />{!compact && <ThemeToggle />}</div>
    <SidebarScroll>
      <nav aria-label={t('sidebar.mainNav')} className="sidebar-nav">
        {link('search')}
        {navigationGroups.filter(group => group.id !== 'system').map(group => {
          const views = group.views.filter(view => view !== 'chat');
          if (compact) return <div key={group.id} className="dovun-compact-group">{views.map(link)}</div>;
          if (group.id === 'daily' || group.id === 'lists') return <section key={group.id} className="dovun-nav-group" aria-label={t(`app:groups.${group.id}`)}>
            {sectionTitle(group.id)}
            {groupItems(group.id, views)}
          </section>;
          const open = expanded[group.id] ?? group.views.some(view => view === route);
          return <Disclosure key={group.id} className="dovun-nav-group dovun-nav-disclosure" open={open}>
            <DisclosureTrigger className="sidebar-section" onClick={event => { event.preventDefault(); setExpanded(current => ({ ...current, [group.id]: !open })); }}>
              <span>{t(`app:groups.${group.id}`)}</span><ChevronRight className="size-3.5" aria-hidden />
            </DisclosureTrigger>
            <div className="dovun-nav-disclosure-items">{groupItems(group.id, views)}</div>
          </Disclosure>;
        })}
      </nav>
    </SidebarScroll>
    <footer className="sidebar-footer"><nav aria-label={t('sidebar.aiAssistant')} className="sidebar-nav">{link('chat')}</nav><nav aria-label={t('sidebar.tools')} className="sidebar-nav sidebar-nav-follow">{['changes', 'trash', 'settings'].map(view => link(view as View))}</nav>{compact && <ThemeToggle />}</footer>
  </aside>;
}
