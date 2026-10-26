import { Archive, Bot, CalendarClock, CalendarDays, CalendarRange, ChartColumn, ClipboardCheck, FolderKanban, GitBranch, GraduationCap, Grid2X2, History, Inbox, Library, Menu, MessageSquare, NotebookText, Plug, Search, Settings, Sparkles, Tags, Timer, Trash2, type LucideIcon } from 'lucide-react';
import { t } from '../i18n/index.js';
import type { View } from './api.js';
import type { MobileNavigationView } from './mobile-navigation.js';

export type NavigationItem = { view: View; label: string; icon: LucideIcon };

function navItem(view: View, labelKey: string, icon: LucideIcon): NavigationItem {
  return { view, icon, get label() { return t(labelKey); } };
}

/** 全部独立菜单入口的元数据（不含“更多”；侧栏与更多页沿用原有分组，不因本模块变化）。 */
export const navigationItems: NavigationItem[] = [
  navItem('inbox', 'app:nav.inbox', Inbox),
  navItem('today', 'app:nav.today', CalendarDays),
  navItem('quadrant', 'app:nav.quadrant', Grid2X2),
  navItem('topics', 'app:nav.topics', FolderKanban),
  navItem('search', 'app:nav.search', Search),
  navItem('tags', 'app:nav.tags', Tags),
  navItem('archived', 'app:nav.archived', Archive),
  navItem('trash', 'app:nav.trash', Trash2),
  navItem('changes', 'app:nav.changes', History),
  navItem('settings', 'app:nav.settings', Settings),
  navItem('connections', 'app:nav.connections', Plug),
  navItem('proposals', 'app:nav.proposals', ClipboardCheck),
  navItem('knowledge', 'app:nav.knowledge', NotebookText),
  navItem('library', 'app:nav.library', Library),
  navItem('learning', 'app:nav.learning', GraduationCap),
  navItem('skills', 'app:nav.skills', Sparkles),
  navItem('runs', 'app:nav.runs', Bot),
  navItem('worktrees', 'app:nav.worktrees', GitBranch),
  navItem('reviews', 'app:nav.reviews', CalendarClock),
  navItem('plan', 'app:nav.plan', CalendarRange),
  navItem('focus', 'app:nav.focus', Timer),
  navItem('stats', 'app:nav.stats', ChartColumn),
];

/** 聊天与“更多”是固定入口，不进入可配置清单，也不自动加入桌面侧栏。 */
export const chatItem: NavigationItem = navItem('chat', 'app:nav.chat', MessageSquare);
export const moreItem: NavigationItem = navItem('more', 'app:nav.more', Menu);

const itemsByView = new Map<View, NavigationItem>([...navigationItems, chatItem].map((item) => [item.view, item]));

/** Ordered product navigation shared by the sidebar and the mobile More page. */
export const navigationGroups = [
  { id: 'daily', views: ['today', 'plan', 'focus', 'stats', 'quadrant'] },
  { id: 'lists', views: ['inbox', 'topics', 'tags', 'archived'] },
  { id: 'knowledge', views: ['library', 'knowledge', 'learning', 'reviews'] },
  { id: 'collaboration', views: ['chat', 'proposals', 'skills', 'connections', 'runs'] },
  { id: 'advanced', views: ['worktrees'] },
  { id: 'system', views: ['search', 'settings', 'changes', 'trash'] },
] as const satisfies readonly { id: string; views: readonly View[] }[];

export function navigationItem(view: View): NavigationItem {
  const item = itemsByView.get(view);
  if (!item) throw new Error(`Unknown navigation view: ${view}`);
  return item;
}

export function mobileNavigationItem(view: MobileNavigationView): NavigationItem {
  return itemsByView.get(view)!;
}
