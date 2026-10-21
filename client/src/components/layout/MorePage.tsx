import { useTranslation } from 'react-i18next';
import { ChevronRight, MessageSquare } from 'lucide-react';
import type { View } from '@/lib/api.js';
import { navigationItems } from '@/lib/navigation-items.js';
import { usePendingProposalCount } from '@/lib/use-pending-proposal-count.js';
import { NavCount } from '@/components/layout/NavCount.js';
import { ThemeToggle } from '@/components/layout/ThemeToggle.js';
import { cn } from '@/lib/utils.js';

const groups: { id: 'views' | 'organize' | 'work' | 'system'; views: View[] }[] = [
  { id: 'views', views: ['inbox', 'today', 'plan', 'focus', 'stats', 'quadrant', 'topics'] },
  { id: 'organize', views: ['search', 'tags', 'archived'] },
  { id: 'work', views: ['connections', 'proposals', 'knowledge', 'library', 'skills', 'runs', 'worktrees', 'reviews'] },
  { id: 'system', views: ['settings', 'trash', 'changes'] },
];

type MorePageProps = {
  route: View;
  onNavigate: (view: View) => void;
};

export function MorePage({ route, onNavigate }: MorePageProps) {
  const { t } = useTranslation('settings');
  const pendingProposals = usePendingProposalCount().data?.pending;
  return (
    <div className="mx-auto w-full max-w-2xl p-4 pb-10 sm:p-6 lg:max-w-4xl">
      <header className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t('morePage.title')}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('morePage.subtitle')}</p>
        </div>
        <ThemeToggle />
      </header>
      <button
        type="button"
        onClick={() => onNavigate('chat')}
        className="glass-subtle mb-6 flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 text-left transition-colors hover:bg-[var(--glass-hover)]"
      >
        <span className="glass-control flex size-9 shrink-0 items-center justify-center rounded-xl">
          <MessageSquare aria-hidden="true" className="size-5" strokeWidth={1.75} />
        </span>
        <span className="flex-1 text-[15px] font-medium">{t('morePage.openChat')}</span>
        <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
      </button>
      <nav aria-label={t('morePage.nav')} className="grid gap-6 lg:grid-cols-2">
        {groups.map((group) => (
          <section key={group.id} aria-label={t(`morePage.groups.${group.id}`)}>
            <h2 className="mb-1.5 px-3 text-xs font-medium text-muted-foreground">{t(`morePage.groups.${group.id}`)}</h2>
            <div className="glass-subtle overflow-hidden rounded-2xl">
              {group.views.map((view, index) => {
                const item = navigationItems.find((entry) => entry.view === view)!;
                const Icon = item.icon;
                const active = route === view;
                return (
                  <button
                    key={view}
                    type="button"
                    onClick={() => onNavigate(view)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-12 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-[var(--glass-hover)]',
                      index > 0 && 'border-t border-[var(--glass-divider)]',
                      active && 'bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] font-semibold',
                    )}
                  >
                    <Icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
                    <span className="flex-1 text-[15px]">{item.label}</span>
                    {view === 'proposals' ? <NavCount count={pendingProposals} /> : null}
                    <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </nav>
    </div>
  );
}
