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
  'stats',
  'chat',
] as const;

export type MobileNavigationView =
  (typeof MOBILE_NAVIGATION_VIEWS)[number];

export type MobileNavigationSettings = {
  visibleViews: MobileNavigationView[];
};

export const DEFAULT_MOBILE_NAVIGATION: MobileNavigationSettings = {
  visibleViews: ['today', 'plan', 'topics', 'library'],
};

export const defaultMobileNavigationJson = JSON.stringify(DEFAULT_MOBILE_NAVIGATION.visibleViews);

export const MAX_MOBILE_NAVIGATION_ITEMS = 4;

const whitelist = new Set<string>(MOBILE_NAVIGATION_VIEWS);

/** 数组顺序有意义：只接受白名单内、去重且不超过上限的字符串。 */
export function isValidVisibleViews(value: unknown): value is MobileNavigationView[] {
  if (!Array.isArray(value) || value.length > MAX_MOBILE_NAVIGATION_ITEMS) return false;
  const seen = new Set<string>();
  for (const view of value) {
    if (typeof view !== 'string' || !whitelist.has(view) || seen.has(view)) return false;
    seen.add(view);
  }
  return true;
}
