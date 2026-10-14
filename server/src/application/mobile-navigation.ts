import { prisma } from '../infrastructure/prisma.js';
import {
  DEFAULT_MOBILE_NAVIGATION,
  isValidVisibleViews,
  type MobileNavigationView,
  type MobileNavigationSettings,
} from '../domain/mobile-navigation.js';

/** GET 永不落库：没有行或存量字符串损坏时，只返回默认配置。 */
function defaults(): MobileNavigationSettings {
  return { visibleViews: [...DEFAULT_MOBILE_NAVIGATION.visibleViews] };
}

export async function readMobileNavigation(): Promise<MobileNavigationSettings> {
  const row = await prisma.appSetting.findUnique({ where: { id: 'default' } });
  if (!row) return defaults();
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.mobileNavigationJson);
  } catch {
    return defaults();
  }
  if (!isValidVisibleViews(parsed)) return defaults();
  return { visibleViews: [...parsed] };
}

export async function writeMobileNavigation(views: MobileNavigationView[]): Promise<MobileNavigationSettings> {
  const timestamp = new Date().toISOString();
  await prisma.appSetting.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      mobileNavigationJson: JSON.stringify(views),
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    update: {
      mobileNavigationJson: JSON.stringify(views),
      updatedAt: timestamp,
    },
  });
  return { visibleViews: [...views] };
}
