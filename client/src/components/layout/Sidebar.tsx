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
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
  return <aside className={`app-sidebar${compact ? ' assistant-compact-nav' : ''}`} style={{ gridColumn: 1, gridRow: 1 }}>
    <div className="sidebar-header"><BrandMark compact={compact} />{!compact && <ThemeToggle />}</div>
    <SidebarScroll>
      <nav aria-label={t('sidebar.mainNav')} className="sidebar-nav">
        {link('search')}
        {navigationGroups.filter(group => group.id !== 'system').map(group => {
          if (compact) return <div key={group.id} className="dovun-compact-group">{group.views.map(link)}</div>;
          if (group.id === 'advanced') return <Disclosure key={group.id} className="dovun-advanced" open={advancedOpen || route === 'worktrees'}>
            <DisclosureTrigger className="sidebar-link" onClick={event => { event.preventDefault(); setAdvancedOpen(value => !value); }}><ChevronRight className="size-3.5" aria-hidden /><span>{t('app:groups.advanced')}</span></DisclosureTrigger>
            {group.views.map(link)}
          </Disclosure>;
          return <section key={group.id} className="dovun-nav-group" aria-label={t(`app:groups.${group.id}`)}>
            <div className="sidebar-section">{group.id === 'lists' ? <Button variant="plain" size="bare" onClick={() => onNavigate('topics')}>{t('app:groups.lists')}</Button> : <span>{t(`app:groups.${group.id}`)}</span>}
              {group.id === 'lists' && <Button variant="row" size="bare" type="button" className="sidebar-add" aria-label={t('sidebar.newList')} onClick={onNewTopic}><Plus className="size-3.5" aria-hidden /></Button>}
            </div>
            {group.id === 'lists' ? <>{link('inbox')}<TopicList variant="sidebar" topics={topics} loading={topicsLoading} selectedTopicId={page === 'board' ? selectedTopicId : ''} onSelect={onSelectTopic} onEdit={onEditTopic} />{link('tags')}{link('archived')}</> : group.views.map(link)}
          </section>;
        })}
      </nav>
    </SidebarScroll>
    <footer className="sidebar-footer"><nav aria-label={t('sidebar.tools')} className="sidebar-nav">{['changes', 'trash', 'settings'].map(view => link(view as View))}</nav>{compact && <ThemeToggle />}</footer>
  </aside>;
}
