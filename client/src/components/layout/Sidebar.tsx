import type { ReactNode } from 'react';
import { Archive, Bot, CalendarClock, CalendarDays, ClipboardCheck, FolderKanban, History, Inbox, Library, Plug, Plus, Search, Settings, Tags, Trash2, type LucideIcon } from 'lucide-react';
import type { Topic, View } from '@/lib/api.js';
import { TopicList } from '@/components/topics/TopicList.js';
import { BrandMark } from '@/components/layout/BrandMark.js';
import { ThemeToggle } from '@/components/layout/ThemeToggle.js';

export const navigation: { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'inbox', label: '收集箱', icon: Inbox },
  { view: 'today', label: '今天', icon: CalendarDays },
  { view: 'topics', label: '清单', icon: FolderKanban },
  { view: 'search', label: '搜索', icon: Search },
  { view: 'tags', label: '标签', icon: Tags },
  { view: 'archived', label: '已归档', icon: Archive },
  { view: 'trash', label: '回收站', icon: Trash2 },
  { view: 'changes', label: '变更历史', icon: History },
  { view: 'settings', label: '设置', icon: Settings },
  { view: 'connections', label: 'AI 连接', icon: Plug },
  { view: 'proposals', label: '待确认', icon: ClipboardCheck },
  { view: 'knowledge', label: '项目资料', icon: Library },
  { view: 'runs', label: 'AI 执行', icon: Bot },
  { view: 'reviews', label: '定期回顾', icon: CalendarClock },
];

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
  return navigation.filter((item) => views.includes(item.view));
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
          {links(['today', 'search']).map((item) => <SidebarLink key={item.view} active={current(item.view)} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} />)}
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
          {links(['connections', 'proposals', 'knowledge', 'runs', 'reviews']).map((item) => <SidebarLink key={item.view} active={current(item.view)} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} />)}
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
