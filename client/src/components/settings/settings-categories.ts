/**
 * Settings categories and their sections. This file is the single place where a branch adds a
 * settings block: append its section id to the right category here and map the id to a component
 * in `settings-registry.tsx`. Keep it free of React so the routing helpers stay unit-testable.
 */
export const SETTINGS_CATEGORIES = ['model', 'local', 'skills', 'projects', 'ui', 'data', 'about'] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const SETTINGS_SECTIONS = ['model', 'reply-style', 'image-search', 'web-search', 'html-blocks', 'computers', 'worktrees', 'notifications', 'skills', 'projects', 'language', 'mobile-navigation', 'backup', 'sync', 'server'] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

export type SettingsGroup = 'ai' | 'workspace';

export type SettingsCategoryDef = {
  id: SettingsCategory;
  group: SettingsGroup;
  /** Sections in display order. */
  sections: readonly SettingsSectionId[];
};

export const SETTINGS_CATEGORY_DEFS: readonly SettingsCategoryDef[] = [
  { id: 'model', group: 'ai', sections: ['model', 'reply-style', 'image-search', 'web-search', 'html-blocks'] },
  { id: 'local', group: 'ai', sections: ['computers', 'worktrees', 'notifications'] },
  { id: 'skills', group: 'ai', sections: ['skills'] },
  { id: 'projects', group: 'workspace', sections: ['projects'] },
  { id: 'ui', group: 'workspace', sections: ['language', 'mobile-navigation'] },
  { id: 'data', group: 'workspace', sections: ['backup', 'sync'] },
  { id: 'about', group: 'workspace', sections: ['server'] },
];

export const SETTINGS_GROUPS: readonly SettingsGroup[] = ['ai', 'workspace'];

/** The category shown when the address names none (desktop only; phones show the list). */
export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = 'model';

export function isSettingsCategory(value: unknown): value is SettingsCategory {
  return typeof value === 'string' && (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

/** Read the second hash segment. Unknown or missing values mean "no category". */
export function parseSettingsCategory(segment: string | undefined | null): SettingsCategory | null {
  return isSettingsCategory(segment) ? segment : null;
}

export function settingsHash(category: SettingsCategory | null): string {
  return category ? `/settings/${category}` : '/settings';
}

export function settingsCategoryDef(category: SettingsCategory): SettingsCategoryDef {
  return SETTINGS_CATEGORY_DEFS.find((item) => item.id === category)!;
}

export function categoriesInGroup(group: SettingsGroup): SettingsCategoryDef[] {
  return SETTINGS_CATEGORY_DEFS.filter((item) => item.group === group);
}
