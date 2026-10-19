import { t } from '../i18n/index.js';
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

function labels<K extends string>(keys: Record<K, string>): Record<K, string> {
  const result = {} as Record<K, string>;
  for (const id of Object.keys(keys) as K[]) {
    const key = keys[id];
    Object.defineProperty(result, id, { enumerable: true, get: () => t(key) });
  }
  return result;
}

export const MOBILE_NAVIGATION_LABELS: Record<MobileNavigationView, string> = labels({
  inbox: 'app:nav.inbox',
  today: 'app:nav.today',
  quadrant: 'app:nav.quadrant',
  topics: 'app:nav.topics',
  search: 'app:nav.search',
  tags: 'app:nav.tags',
  archived: 'app:nav.archived',
  trash: 'app:nav.trash',
  changes: 'app:nav.changes',
  settings: 'app:nav.settings',
  connections: 'app:nav.connections',
  proposals: 'app:nav.proposals',
  library: 'app:nav.library',
  runs: 'app:nav.runs',
  reviews: 'app:nav.reviews',
  plan: 'app:nav.plan',
  focus: 'app:nav.focus',
  chat: 'app:nav.chat',
});

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
