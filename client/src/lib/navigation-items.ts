import { Archive, Bot, CalendarClock, CalendarDays, CalendarRange, ClipboardCheck, FolderKanban, Grid2X2, History, Inbox, Library, Menu, MessageSquare, NotebookText, Plug, Search, Settings, Tags, Timer, Trash2, type LucideIcon } from 'lucide-react';
import type { View } from './api.js';
import type { MobileNavigationView } from './mobile-navigation.js';

export type NavigationItem = { view: View; label: string; icon: LucideIcon };

/** 全部独立菜单入口的元数据（不含“更多”；侧栏与更多页沿用原有分组，不因本模块变化）。 */
export const navigationItems: NavigationItem[] = [
  { view: 'inbox', label: '收集箱', icon: Inbox },
  { view: 'today', label: '今天', icon: CalendarDays },
  { view: 'quadrant', label: '四象限', icon: Grid2X2 },
  { view: 'topics', label: '清单', icon: FolderKanban },
  { view: 'search', label: '搜索', icon: Search },
  { view: 'tags', label: '标签', icon: Tags },
  { view: 'archived', label: '已归档', icon: Archive },
  { view: 'trash', label: '回收站', icon: Trash2 },
  { view: 'changes', label: '变更历史', icon: History },
  { view: 'settings', label: '设置', icon: Settings },
  { view: 'connections', label: 'AI 连接', icon: Plug },
  { view: 'proposals', label: '待确认', icon: ClipboardCheck },
  { view: 'knowledge', label: '工作上下文', icon: NotebookText },
  { view: 'library', label: '资料库', icon: Library },
  { view: 'runs', label: 'AI 执行', icon: Bot },
  { view: 'reviews', label: '定期回顾', icon: CalendarClock },
  { view: 'plan', label: '规划', icon: CalendarRange },
  { view: 'focus', label: '专注', icon: Timer },
];

/** 聊天与“更多”是固定入口，不进入可配置清单，也不自动加入桌面侧栏。 */
export const chatItem: NavigationItem = { view: 'chat', label: '聊天', icon: MessageSquare };
export const moreItem: NavigationItem = { view: 'more', label: '更多', icon: Menu };

const itemsByView = new Map<View, NavigationItem>([...navigationItems, chatItem].map((item) => [item.view, item]));

export function mobileNavigationItem(view: MobileNavigationView): NavigationItem {
  return itemsByView.get(view)!;
}
