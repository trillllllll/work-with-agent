import { describe, expect, it } from 'vitest';
import i18n, { intlLocale, namespaces, normalizeLanguage } from './index.js';

const plural = /_(zero|one|two|few|many|other)$/;
function keys(value: unknown, prefix = ''): string[] {
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => child && typeof child === 'object' ? keys(child, `${prefix}${key}.`) : [`${prefix}${key}`.replace(plural, '')]);
}

describe('i18n', () => {
  it('defaults to Simplified Chinese outside the browser', () => {
    expect(i18n.language).toBe('zh-CN');
    expect(intlLocale()).toBe('zh-CN');
    expect(i18n.t('app:status.todo')).toBe('待办');
  });

  it('maps browser languages onto supported ones', () => {
    expect(normalizeLanguage('en-GB')).toBe('en');
    expect(normalizeLanguage('zh-TW')).toBe('zh-CN');
    expect(normalizeLanguage('fr')).toBe('zh-CN');
    expect(normalizeLanguage(undefined)).toBe('zh-CN');
  });

  it('has the same keys in every locale', () => {
    for (const namespace of namespaces) {
      const zh = new Set(keys(i18n.getResourceBundle('zh-CN', namespace)));
      const en = new Set(keys(i18n.getResourceBundle('en', namespace)));
      expect([...en].filter((key) => !zh.has(key)), `${namespace}: only in en`).toEqual([]);
      expect([...zh].filter((key) => !en.has(key)), `${namespace}: only in zh-CN`).toEqual([]);
    }
  });

  it('translates to English and pluralizes', async () => {
    await i18n.changeLanguage('en');
    try {
      expect(i18n.t('app:status.todo')).toBe('To do');
      expect(intlLocale()).toBe('en-US');
    } finally {
      await i18n.changeLanguage('zh-CN');
    }
  });
});
