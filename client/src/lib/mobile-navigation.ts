import type { View } from './api.js';

export const MOBILE_NAVIGATION_VIEWS = [
  'inbox',
  'today',
  'quadrant',
  'topics',
  'search',
  'tags',
  'archived',
  'trash',
  'changes',
  'settings',
  'connections',
  'proposals',
  'library',
  'skills',
  'runs',
  'reviews',
  'plan',
  'focus',
  'chat',
] as const;

export type MobileNavigationView =
  (typeof MOBILE_NAVIGATION_VIEWS)[number];

export type MobileNavigationSettings = {
  visibleViews: MobileNavigationView[];
};

export const DEFAULT_MOBILE_NAVIGATION: MobileNavigationSettings = {
  visibleViews: ['inbox', 'today', 'quadrant', 'topics'],
};

export const MAX_MOBILE_NAVIGATION_ITEMS = 4;

export const MOBILE_NAVIGATION_LABELS: Record<MobileNavigationView, string> = {
  inbox: '收集箱',
  today: '今天',
  quadrant: '四象限',
  topics: '清单',
  search: '搜索',
  tags: '标签',
  archived: '已归档',
  trash: '回收站',
  changes: '变更历史',
  settings: '设置',
  connections: 'AI 连接',
  proposals: '待确认',
  library: '资料库',
  skills: '技能',
  runs: 'AI 执行',
  reviews: '定期回顾',
  plan: '规划',
  focus: '专注',
  chat: '聊天',
};

const whitelist = new Set<string>(MOBILE_NAVIGATION_VIEWS);

/** 与服务端同一套校验：顺序有意义，白名单、去重、数量缺一不可。 */
export function isValidMobileNavigation(value: unknown): value is MobileNavigationView[] {
  if (!Array.isArray(value) || value.length > MAX_MOBILE_NAVIGATION_ITEMS) return false;
  const seen = new Set<string>();
  for (const view of value) {
    if (typeof view !== 'string' || !whitelist.has(view) || seen.has(view)) return false;
    seen.add(view);
  }
  return true;
}

/** board/knowledge 不是独立入口：落到底栏时按可视情况映射，否则归入“更多”。 */
export function mobileSelectedView(route: View, visibleViews: MobileNavigationView[]): View {
  if (route === 'board') return visibleViews.includes('topics') ? 'topics' : 'more';
  if (route === 'knowledge') return visibleViews.includes('library') ? 'library' : 'more';
  return (visibleViews as string[]).includes(route) ? route : 'more';
}
