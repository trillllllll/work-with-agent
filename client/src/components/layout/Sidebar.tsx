import { Button } from '@/components/ui/button.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Plus } from 'lucide-react';
import type { Topic, View } from '@/lib/api.js';
import { harnessItem, navigationGroups, navigationItem } from '@/lib/navigation-items.js';
import { usePendingProposalCount } from '@/lib/use-pending-proposal-count.js';
import { TopicList } from '@/components/topics/TopicList.js';
import { BrandMark } from '@/components/layout/BrandMark.js';
import { NavCount } from '@/components/layout/NavCount.js';
import { ThemeToggle } from '@/components/layout/ThemeToggle.js';
import { SidebarScroll } from '@/components/layout/SidebarScroll.js';

type SidebarProps = {
  compact?: boolean; route: View; page: View; topics: Topic[]; topicsLoading: boolean;
  selectedTopicId: string; onNavigate: (view: View) => void; onOpenHarness: () => void; harnessActive: boolean; onOpenAssistant: () => void; assistantOpen: boolean;
  onSelectTopic: (id: string) => void; onEditTopic: (topic: Topic) => void; onNewTopic: () => void;
};

export function Sidebar({ compact, route, page, topics, topicsLoading, selectedTopicId, onNavigate, onOpenHarness, harnessActive, onOpenAssistant, assistantOpen, onSelectTopic, onEditTopic, onNewTopic }: SidebarProps) {
  const { t } = useTranslation(['settings', 'app']);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const pending = usePendingProposalCount().data?.pending;
  const link = (view: View) => {
    const { label, icon: Icon } = navigationItem(view);
    const isChat = view === 'chat';
    const current = route === view && (view !== 'runs' || !harnessActive);
    return <Button variant="row" size="bare" key={view} type="button" title={label} aria-label={isChat && route !== 'chat' ? t('app:shell.openAssistant') : label} aria-current={current ? 'page' : undefined} aria-expanded={isChat ? assistantOpen : undefined} aria-controls={isChat && route !== 'chat' ? 'work-rail-panel-assistant' : undefined} data-active={current || (isChat && assistantOpen && route !== 'chat') || undefined} className="sidebar-link" onClick={() => isChat ? onOpenAssistant() : onNavigate(view)}>
      <Icon aria-hidden className="size-4" strokeWidth={1.75} />
      {!compact && <><span className="min-w-0 flex-1 truncate">{label}</span>{view === 'proposals' && <NavCount count={pending} />}</>}
      {compact && view === 'proposals' && Boolean(pending) && <span className="dovun-rail-badge" />}
    </Button>;
  };
  const HarnessIcon = harnessItem.icon;
  const harnessLink = <Button variant="row" size="bare" key="harness" type="button" title={harnessItem.label} aria-label={harnessItem.label} aria-current={harnessActive ? 'page' : undefined} data-active={harnessActive || undefined} className="sidebar-link" data-testid="sidebar-harness-sessions" onClick={() => onOpenHarness()}>
    <HarnessIcon aria-hidden className="size-4" strokeWidth={1.75} />
    {!compact && <span className="min-w-0 flex-1 truncate">{harnessItem.label}</span>}
  </Button>;
  const withHarness = (views: readonly View[]) => views.map(view => <Fragment key={view}>{view === 'runs' && harnessLink}{link(view)}</Fragment>);
  const sectionTitle = (id: string) => <div className="sidebar-section">{id === 'lists' ? <Button variant="plain" size="bare" onClick={() => onNavigate('topics')}>{t('app:groups.lists')}</Button> : <span>{t(`app:groups.${id}`)}</span>}
    {id === 'lists' && <Button variant="row" size="bare" type="button" className="sidebar-add" aria-label={t('sidebar.newList')} onClick={onNewTopic}><Plus className="size-3.5" aria-hidden /></Button>}
  </div>;
  const groupItems = (id: string, views: readonly View[]) => id === 'lists' ? <>{link('inbox')}<TopicList variant="sidebar" topics={topics} loading={topicsLoading} selectedTopicId={page === 'board' ? selectedTopicId : ''} onSelect={onSelectTopic} onEdit={onEditTopic} />{link('tags')}{link('archived')}</> : withHarness(views);

  return <aside className={`app-sidebar${compact ? ' assistant-compact-nav' : ''}`} style={{ gridColumn: 1, gridRow: 1 }}>
    <div className="sidebar-header"><BrandMark compact={compact} />{!compact && <ThemeToggle />}</div>
    <SidebarScroll>
      <nav aria-label={t('sidebar.mainNav')} className="sidebar-nav">
        {link('search')}
        {navigationGroups.filter(group => group.id !== 'system').map(group => {
          const views = group.views.filter(view => view !== 'chat');
          if (compact) return <div key={group.id} className="dovun-compact-group">{withHarness(views)}</div>;
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
