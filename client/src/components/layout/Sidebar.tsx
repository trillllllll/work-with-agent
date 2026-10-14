import type { ReactNode } from 'react';
import { Inbox, Plus, type LucideIcon } from 'lucide-react';
import type { Topic, View } from '@/lib/api.js';
import { navigationItems } from '@/lib/navigation-items.js';
import { TopicList } from '@/components/topics/TopicList.js';
import { BrandMark } from '@/components/layout/BrandMark.js';
import { ThemeToggle } from '@/components/layout/ThemeToggle.js';

type SidebarProps = {
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

function SidebarLink({ active, label, icon: Icon, onClick }: { active: boolean; label: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} data-active={active || undefined} aria-current={active ? 'page' : undefined} className="sidebar-link">
      <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
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

export function Sidebar({ route, page, topics, topicsLoading, selectedTopicId, onNavigate, onSelectTopic, onEditTopic, onNewTopic }: SidebarProps) {
  const current = (view: View) => route === view;
  return (
    <aside className="app-sidebar">
      <div className="sidebar-header">
        <BrandMark />
        <ThemeToggle />
      </div>
      <div className="sidebar-scroll glass-scrollbar">
        <nav aria-label="主导航" className="sidebar-nav">
          {links(['today', 'plan', 'focus', 'search']).map((item) => <SidebarLink key={item.view} active={current(item.view)} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} />)}
        </nav>
        <SidebarSection label="清单" action={<button type="button" className="sidebar-add" aria-label="新建清单" onClick={onNewTopic}><Plus aria-hidden="true" className="size-3.5" strokeWidth={1.75} /></button>} />
        <nav aria-label="清单" className="sidebar-nav">
          <SidebarLink active={page === 'inbox'} label="收集箱" icon={Inbox} onClick={() => onNavigate('inbox')} />
          <TopicList variant="sidebar" topics={topics} loading={topicsLoading} selectedTopicId={page === 'board' ? selectedTopicId : ''} onSelect={onSelectTopic} onEdit={onEditTopic} />
        </nav>
        <nav aria-label="整理" className="sidebar-nav sidebar-nav-follow">
          {links(['tags', 'archived']).map((item) => <SidebarLink key={item.view} active={current(item.view)} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} />)}
        </nav>
        <SidebarSection label="工作" />
        <nav aria-label="工作" className="sidebar-nav">
          {links(['connections', 'proposals', 'library', 'runs', 'reviews']).map((item) => <SidebarLink key={item.view} active={current(item.view)} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} />)}
        </nav>
      </div>
      <div className="sidebar-footer">
        <nav aria-label="工具" className="sidebar-nav">
          {links(['trash', 'changes', 'settings']).map((item) => <SidebarLink key={item.view} active={current(item.view)} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} />)}
        </nav>
      </div>
    </aside>
  );
}
