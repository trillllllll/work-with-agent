import { Button } from '@/components/ui/button.js';
import { Surface } from '@/components/ui/surface.js';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, History, Trash2 } from 'lucide-react';
import type { View } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { DEFAULT_SETTINGS_CATEGORY, SETTINGS_GROUPS, categoriesInGroup, settingsCategoryDef, type SettingsCategory } from './settings-categories.js';
import { SETTINGS_CATEGORY_ICONS, SETTINGS_SECTION_COMPONENTS, useSettingsCategoryHints } from './settings-registry.js';

type SettingsViewProps = {
  /** Category named by the address; null means `#/settings`. */
  category: SettingsCategory | null;
  /** Below 1024px settings becomes a category list with full-screen detail pages. */
  mobile: boolean;
  onCategoryChange: (category: SettingsCategory | null) => void;
  onNavigate: (view: View) => void;
};

/** Remembers which list row opened a detail page so going back can return focus to it. */
let lastListItem: string | null = null;

export function SettingsView({ category, mobile, onCategoryChange, onNavigate }: SettingsViewProps) {
  if (mobile) return category ? <CategoryContent category={category} mobile onNavigate={onNavigate} /> : <CategoryList onCategoryChange={onCategoryChange} onNavigate={onNavigate} />;
  return <DesktopSettings category={category ?? DEFAULT_SETTINGS_CATEGORY} onCategoryChange={onCategoryChange} onNavigate={onNavigate} />;
}

function DesktopSettings({ category, onCategoryChange, onNavigate }: { category: SettingsCategory; onCategoryChange: (category: SettingsCategory) => void; onNavigate: (view: View) => void }) {
  const { t } = useTranslation('settings');
  const hints = useSettingsCategoryHints();
  return (
    <div className="flex h-full min-h-0">
      <nav aria-label={t('layout.nav.label')} className="glass-scrollbar w-[232px] shrink-0 overflow-y-auto border-r border-[var(--glass-divider)] px-3 py-4">
        {SETTINGS_GROUPS.map((group) => (
          <div key={group} className="mb-3 last:mb-0">
            <h2 className="px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t(`layout.groups.${group}`)}</h2>
            <ul className="space-y-0.5">
              {categoriesInGroup(group).map(({ id }) => {
                const Icon = SETTINGS_CATEGORY_ICONS[id];
                const active = id === category;
                return (
                  <li key={id}>
                    <Button variant="row" size="bare"
                      type="button"
                      aria-current={active ? 'page' : undefined}
                      aria-describedby={`settings-nav-hint-${id}`}
                      onClick={() => { if (!active) onCategoryChange(id); }}
                      className={cn(
                        'group flex w-full items-start gap-2.5 rounded-xl px-3 py-2 text-left transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none',
                      )}
                    >
                      <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', active ? 'text-brand-link' : 'text-muted-foreground group-hover:text-foreground')} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium">{t(`layout.categories.${id}.title`)}</span>
                        <span id={`settings-nav-hint-${id}`} className="mt-0.5 block truncate text-[11px] text-muted-foreground">{hints[id]}</span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <CategoryContent key={category} category={category} onNavigate={onNavigate} />
    </div>
  );
}

function CategoryContent({ category, mobile = false, onNavigate }: { category: SettingsCategory; mobile?: boolean; onNavigate: (view: View) => void }) {
  const { t } = useTranslation('settings');
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { scroller.current?.scrollTo?.({ top: 0 }); }, [category]);
  const titleId = `settings-category-title-${category}`;
  return (
    <div
      ref={scroller}
      role="region"
      aria-labelledby={titleId}
      data-testid="settings-category"
      data-category={category}
      className={cn('glass-scrollbar min-h-0 min-w-0 flex-1', mobile ? '' : 'overflow-y-auto overscroll-contain')}
    >
      <div className={cn('max-w-2xl', mobile ? 'px-4 pb-28 pt-4 sm:px-6' : 'p-6 pb-10 sm:p-8')}>
        <h2 id={titleId} className={cn(mobile ? 'sr-only' : 'text-2xl font-semibold tracking-tight')}>{t(`layout.categories.${category}.title`)}</h2>
        <p className={cn('text-[13px] leading-relaxed text-muted-foreground', !mobile && 'mt-1.5')}>{t(`layout.categories.${category}.lead`)}</p>
        {settingsCategoryDef(category).sections.map((id) => {
          const Section = SETTINGS_SECTION_COMPONENTS[id];
          return <div key={id} className="settings-block" data-settings-section={id}><Section onNavigate={onNavigate} /></div>;
        })}
      </div>
    </div>
  );
}

function CategoryList({ onCategoryChange, onNavigate }: { onCategoryChange: (category: SettingsCategory) => void; onNavigate: (view: View) => void }) {
  const { t } = useTranslation(['settings', 'workspace']);
  const hints = useSettingsCategoryHints();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!lastListItem) return;
    const target = list.current?.querySelector<HTMLElement>(`[data-settings-item="${lastListItem}"]`);
    lastListItem = null;
    target?.focus();
  }, []);
  const groups: Array<{ id: string; title: string; items: Array<{ id: string; title: string; hint: string; icon: typeof Trash2; open: () => void }> }> = [
    ...SETTINGS_GROUPS.map((group) => ({
      id: group,
      title: t(`layout.groups.${group}`),
      items: categoriesInGroup(group).map(({ id }) => ({ id, title: t(`layout.categories.${id}.title`), hint: hints[id], icon: SETTINGS_CATEGORY_ICONS[id], open: () => onCategoryChange(id) })),
    })),
    {
      id: 'dataAdmin',
      title: t('layout.groups.dataAdmin'),
      items: [
        { id: 'trash', title: t('workspace:modal.trash'), hint: t('workspace:modal.trashTab'), icon: Trash2, open: () => onNavigate('trash') },
        { id: 'changes', title: t('workspace:modal.changes'), hint: t('workspace:modal.changesTab'), icon: History, open: () => onNavigate('changes') },
      ],
    },
  ];
  return (
    <div ref={list} className="space-y-6 px-4 pb-28 pt-4 sm:px-6" data-testid="settings-category-list">
      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`settings-group-${group.id}`}>
          <h2 id={`settings-group-${group.id}`} className="mb-1.5 px-3 text-xs font-medium text-muted-foreground">{group.title}</h2>
          <Surface as="div" tone="subtle" className="overflow-hidden rounded-2xl">
            {group.items.map((item, index) => {
              const Icon = item.icon;
              return (
                <Button variant="row" size="bare"
                  key={item.id}
                  type="button"
                  data-settings-item={item.id}
                  aria-label={item.title}
                  aria-describedby={`settings-item-hint-${item.id}`}
                  onClick={() => { lastListItem = item.id; item.open(); }}
                  className={cn('flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--glass-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60', index > 0 && 'border-t border-[var(--glass-divider)]')}
                >
                  <Icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px]">{item.title}</span>
                    <span id={`settings-item-hint-${item.id}`} className="mt-0.5 block truncate text-xs text-muted-foreground">{item.hint}</span>
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                </Button>
              );
            })}
          </Surface>
        </section>
      ))}
    </div>
  );
}
