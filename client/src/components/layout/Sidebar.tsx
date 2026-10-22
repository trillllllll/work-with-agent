import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Ellipsis, Inbox, Plus, type LucideIcon } from 'lucide-react';
import type { Topic, View } from '@/lib/api.js';
import { chatItem, navigationItems } from '@/lib/navigation-items.js';
import { usePendingProposalCount } from '@/lib/use-pending-proposal-count.js';
import { TopicList } from '@/components/topics/TopicList.js';
import { BrandMark } from '@/components/layout/BrandMark.js';
import { NavCount } from '@/components/layout/NavCount.js';
import { ThemeToggle } from '@/components/layout/ThemeToggle.js';
import { SidebarScroll } from '@/components/layout/SidebarScroll.js';

type SidebarProps = {
  compact?: boolean;
  route: View;
  page: View;
  topics: Topic[];
  topicsLoading: boolean;
  selectedTopicId: string;
  onNavigate: (view: View) => void;
  onSelectTopic: (id: string) => void;
  onEditTopic: (topic: Topic) => void;
  onNewTopic: () => void;
};

function links(views: View[]) {
  return navigationItems.filter((item) => views.includes(item.view));
}

function SidebarLink({ active, label, icon: Icon, onClick, count }: { active: boolean; label: string; icon: LucideIcon; onClick: () => void; count?: number }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} data-active={active || undefined} aria-current={active ? 'page' : undefined} className="sidebar-link">
      <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <NavCount count={count} />
    </button>
  );
}

function SidebarSection({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div className="sidebar-section">
      <span>{label}</span>
      {action}
    </div>
  );
}

export function Sidebar({ compact, route, page, topics, topicsLoading, selectedTopicId, onNavigate, onSelectTopic, onEditTopic, onNewTopic }: SidebarProps) {
  const { t } = useTranslation('settings');
  const pendingProposals = usePendingProposalCount().data?.pending;
  const current = (view: View) => route === view;
  const planning = page === 'plan';
  const assistant = { ...chatItem, label: t('sidebar.aiAssistant') };
  if (compact) return <aside className="app-sidebar assistant-compact-nav" style={{ gridColumn: 1, gridRow: '1 / 3' }}>
    <div className="flex justify-center py-3"><ThemeToggle /></div>
    <SidebarScroll>
      <nav aria-label={t('sidebar.mainNav')} className="flex flex-col items-center gap-1">{[...navigationItems, assistant].map(({ view, label, icon: Icon }) => <button key={view} type="button" title={label} aria-label={label} aria-current={route === view ? 'page' : undefined} className="grid size-10 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => onNavigate(view)}><Icon className="size-4" /></button>)}</nav>
    </SidebarScroll>
  </aside>;
  return (
    <aside className={`app-sidebar${planning ? ' planning-sidebar' : ''}`} style={{ gridColumn: 1, gridRow: "1 / 3" }}>
      <div className="sidebar-header">
        <BrandMark />
        <ThemeToggle />
      </div>
      <SidebarScroll>
        <nav aria-label={t('sidebar.mainNav')} className="sidebar-nav">
          {[...links(['today', 'plan', 'focus', 'stats', 'search']), assistant].map((item) => <SidebarLink key={item.view} active={current(item.view)} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} />)}
        </nav>
        <SidebarSection label={t('sidebar.lists')} action={<button type="button" className="sidebar-add" aria-label={t('sidebar.newList')} onClick={onNewTopic}><Plus aria-hidden="true" className="size-3.5" strokeWidth={1.75} /></button>} />
        <nav aria-label={t('sidebar.lists')} className="sidebar-nav">
          <SidebarLink active={page === 'inbox'} label={t('sidebar.inbox')} icon={Inbox} onClick={() => onNavigate('inbox')} />
          <TopicList variant="sidebar" topics={topics} loading={topicsLoading} selectedTopicId={page === 'board' ? selectedTopicId : ''} onSelect={onSelectTopic} onEdit={onEditTopic} />
        </nav>
        {!planning && <nav aria-label={t('sidebar.organize')} className="sidebar-nav sidebar-nav-follow">
          {links(['tags', 'archived']).map((item) => <SidebarLink key={item.view} active={current(item.view)} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} />)}
        </nav>}
        {planning ? <details className="mt-5"><summary className="sidebar-link text-muted-foreground"><span className="flex-1">{t('sidebar.work')}</span><ChevronDown className="size-3.5" /></summary><nav aria-label={t('sidebar.work')} className="sidebar-nav">{links(['connections', 'proposals', 'knowledge', 'library', 'skills', 'runs', 'worktrees', 'reviews']).map((item) => <SidebarLink key={item.view} active={current(item.view)} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} count={item.view === 'proposals' ? pendingProposals : undefined} />)}</nav></details> : <><SidebarSection label={t('sidebar.work')} />
        <nav aria-label={t('sidebar.work')} className="sidebar-nav">
          {links(['connections', 'proposals', 'knowledge', 'library', 'skills', 'runs', 'worktrees', 'reviews']).map((item) => <SidebarLink key={item.view} active={current(item.view)} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} count={item.view === 'proposals' ? pendingProposals : undefined} />)}
        </nav></>}
      </SidebarScroll>
      <div className="sidebar-footer">
        <nav aria-label={t('sidebar.tools')} className="sidebar-nav">
          {planning && <details><summary className="sidebar-link"><Ellipsis className="size-4" /><span className="flex-1">{t('sidebar.more')}</span><ChevronDown className="size-3.5" /></summary>{links(['tags', 'archived', 'trash', 'changes']).map((item) => <SidebarLink key={item.view} active={current(item.view)} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} />)}</details>}
          {links(planning ? ['settings'] : ['trash', 'changes', 'settings']).map((item) => <SidebarLink key={item.view} active={current(item.view)} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} />)}
        </nav>
      </div>
    </aside>
  );
}
