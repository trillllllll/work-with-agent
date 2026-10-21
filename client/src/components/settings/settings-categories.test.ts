import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_CATEGORIES, SETTINGS_CATEGORY_DEFS, SETTINGS_SECTIONS, parseSettingsCategory, settingsHash } from './settings-categories.js';

const locale = (language: string) => JSON.parse(readFileSync(join(__dirname, '../../i18n/locales', language, 'settings.json'), 'utf8'));

describe('settings categories', () => {
  it('has unique ids and at least one section per category', () => {
    expect(new Set(SETTINGS_CATEGORY_DEFS.map((item) => item.id)).size).toBe(SETTINGS_CATEGORY_DEFS.length);
    expect(SETTINGS_CATEGORY_DEFS.map((item) => item.id)).toEqual([...SETTINGS_CATEGORIES]);
    for (const item of SETTINGS_CATEGORY_DEFS) expect(item.sections.length).toBeGreaterThan(0);
  });

  it('places every section exactly once', () => {
    const placed = SETTINGS_CATEGORY_DEFS.flatMap((item) => item.sections);
    expect(placed.sort()).toEqual([...SETTINGS_SECTIONS].sort());
  });

  it('round-trips categories through the hash', () => {
    for (const category of SETTINGS_CATEGORIES) {
      const hash = settingsHash(category);
      expect(hash).toBe(`/settings/${category}`);
      expect(parseSettingsCategory(hash.split('/')[2])).toBe(category);
    }
    expect(settingsHash(null)).toBe('/settings');
    expect(parseSettingsCategory(undefined)).toBeNull();
    expect(parseSettingsCategory('nope')).toBeNull();
  });

  it('keeps the local category and lists projects first in the workspace group', () => {
    expect(SETTINGS_CATEGORY_DEFS.find((item) => item.id === 'local')?.sections).toEqual(['computers', 'worktrees', 'notifications']);
    expect(SETTINGS_CATEGORY_DEFS.find((item) => item.id === 'projects')?.sections).toEqual(['projects']);
    expect(SETTINGS_CATEGORY_DEFS.filter((item) => item.group === 'workspace').map((item) => item.id)[0]).toBe('projects');
    expect(SETTINGS_SECTIONS).not.toContain('cli');
    expect(SETTINGS_SECTIONS).not.toContain('orchestration');
  });

  it('has a title and lead in both languages for every category', () => {
    for (const language of ['zh-CN', 'en']) {
      const messages = locale(language);
      for (const category of SETTINGS_CATEGORIES) {
        expect(messages.layout.categories[category].title, `${language} ${category}`).toBeTruthy();
        expect(messages.layout.categories[category].lead, `${language} ${category}`).toBeTruthy();
      }
    }
  });
});
