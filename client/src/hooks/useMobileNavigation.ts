import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import type { MobileNavigationSettings } from '@/lib/mobile-navigation.js';

export const mobileNavigationKey = ['mobile-navigation'] as const;

/** App 与设置共用同一查询缓存；刷新沿用工作区现有的定时与聚焦失效机制。 */
export function useMobileNavigation() {
  return useQuery<MobileNavigationSettings>({
    queryKey: mobileNavigationKey,
    queryFn: ({ signal }) => api<MobileNavigationSettings>('/api/settings/mobile-navigation', { signal }),
  });
}
