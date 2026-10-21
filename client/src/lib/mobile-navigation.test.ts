import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MOBILE_NAVIGATION as SERVER_DEFAULT,
  MAX_MOBILE_NAVIGATION_ITEMS as SERVER_MAX,
  MOBILE_NAVIGATION_VIEWS as SERVER_VIEWS,
  isValidVisibleViews,
} from '../../../server/src/domain/mobile-navigation.js';
import {
  DEFAULT_MOBILE_NAVIGATION,
  MAX_MOBILE_NAVIGATION_ITEMS,
  MOBILE_NAVIGATION_LABELS,
  MOBILE_NAVIGATION_VIEWS,
  isValidMobileNavigation,
} from './mobile-navigation.js';
import { chatItem, moreItem, navigationItems } from './navigation-items.js';

describe('手机底栏契约', () => {
  it('客户端与服务端的白名单、默认值和上限逐字一致', () => {
    expect([...MOBILE_NAVIGATION_VIEWS]).toEqual([...SERVER_VIEWS]);
    expect(DEFAULT_MOBILE_NAVIGATION).toEqual(SERVER_DEFAULT);
    expect(MAX_MOBILE_NAVIGATION_ITEMS).toBe(SERVER_MAX);
  });

  it('两边校验规则对同一批输入给出相同结论', () => {
    const samples: unknown[] = [
      [], ['inbox'], ['plan', 'focus', 'inbox'],
      ['inbox', 'inbox'], ['more'], ['board'], ['knowledge'], ['unknown'], [1],
      ['inbox', 'today', 'quadrant', 'topics', 'plan'], 'inbox', null,
    ];
    for (const sample of samples) {
      expect(isValidMobileNavigation(sample)).toBe(isValidVisibleViews(sample));
    }
  });

  it('20 个白名单 ID 都有名称、图标，且与公共菜单元数据对应', () => {
    expect(MOBILE_NAVIGATION_VIEWS).toHaveLength(20);
    for (const view of MOBILE_NAVIGATION_VIEWS) {
      expect(MOBILE_NAVIGATION_LABELS[view].length).toBeGreaterThan(0);
    }
    const metadata = new Map([...navigationItems, chatItem].map((item) => [item.view, item]));
    for (const view of MOBILE_NAVIGATION_VIEWS) {
      expect(metadata.get(view), view).toBeDefined();
    }
    expect(metadata.has('more')).toBe(false);
    expect(moreItem.view).toBe('more');
    expect(chatItem.label).toBe('聊天');
  });
});
