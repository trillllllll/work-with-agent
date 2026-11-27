import { Fragment } from 'react';
import { Button } from '@/components/ui/button.js';
import { DisclosureTrigger } from '@/components/ui/disclosure.js';
import { Surface } from '@/components/ui/surface.js';
import { useTranslation } from 'react-i18next';
import { ChevronRight, MessageSquare } from 'lucide-react';
import type { View } from '@/lib/api.js';
import { harnessItem, navigationGroups, navigationItem } from '@/lib/navigation-items.js';
import type { HarnessSessionTarget } from '@/lib/harness-navigation.js';
import { HarnessRecentCard } from '@/components/workspace/HarnessRecentCard.js';
import { usePendingProposalCount } from '@/lib/use-pending-proposal-count.js';
import { NavCount } from '@/components/layout/NavCount.js';
import { ThemeToggle } from '@/components/layout/ThemeToggle.js';
import { cn } from '@/lib/utils.js';


type MorePageProps = {
  route: View;
  onNavigate: (view: View) => void;
  onOpenHarness: (target?: HarnessSessionTarget) => void;
};

export function MorePage({ route, onNavigate, onOpenHarness }: MorePageProps) {
  const { t } = useTranslation('settings');
  const pendingProposals = usePendingProposalCount().data?.pending;
  const HarnessIcon = harnessItem.icon;
  return (
    <div className="workspace-page mx-auto w-full max-w-2xl p-4 pb-10 sm:p-6 lg:max-w-4xl">
      <header className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t('morePage.title')}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('morePage.subtitle')}</p>
        </div>
        <ThemeToggle />
      </header>
      <Button variant="card" size="bare"
        type="button"
        onClick={() => onNavigate('chat')}
        className="mb-6 flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 text-left transition-colors hover:bg-[var(--glass-hover)]"
      >
        <span className="glass-control flex size-9 shrink-0 items-center justify-center rounded-xl">
          <MessageSquare aria-hidden="true" className="size-5" strokeWidth={1.75} />
        </span>
        <span className="flex-1 text-[15px] font-medium">{t('morePage.openChat')}</span>
        <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
      </Button>
      <section aria-label={harnessItem.label} className="mb-6 grid gap-2">
        <Button variant="card" size="bare" type="button" data-testid="more-harness-sessions" onClick={() => onOpenHarness()}
          className="flex min-h-16 w-full items-center gap-3 rounded-2xl border-[var(--ring)] bg-[var(--glass-hover)] px-4 py-3 text-left transition-colors hover:bg-[var(--glass-hover)]">
          <span className="glass-control flex size-9 shrink-0 items-center justify-center rounded-xl text-brand-link"><HarnessIcon aria-hidden className="size-5" strokeWidth={1.75} /></span>
          <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold">{harnessItem.label}</span><span className="block text-xs text-muted-foreground">{t('workspace:harness.entryDescription')}</span></span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </Button>
        <HarnessRecentCard onOpen={onOpenHarness} onOpenList={() => onOpenHarness()} />
      </section>
      <nav aria-label={t('morePage.nav')} className="grid gap-6 lg:grid-cols-2">
        {navigationGroups.map((group) => {
          const Panel = group.id === 'advanced' ? 'details' : 'div';
          return (
          <section key={group.id} aria-label={t(`app:groups.${group.id}`)}>
            <Panel {...(group.id === 'advanced' ? { open: group.views.some(view => view === route) } : {})}>
            {group.id === 'advanced' ? <DisclosureTrigger className="mb-1.5 cursor-pointer px-3 text-xs font-medium text-muted-foreground">{t(`app:groups.${group.id}`)}</DisclosureTrigger> : <h2 className="mb-1.5 px-3 text-xs font-medium text-muted-foreground">{t(`app:groups.${group.id}`)}</h2>}
            <Surface as="div" tone="sheet" className="overflow-hidden rounded-2xl">
              {group.views.map((view, index) => {
                const item = navigationItem(view);
                const Icon = item.icon;
                const active = route === view;
                return (
                  <Fragment key={view}>
                    {view === 'runs' && <Button variant="row" size="bare" type="button" onClick={() => onOpenHarness()}
                      className="flex min-h-12 w-full items-center gap-3 border-t border-[var(--glass-divider)] px-4 text-left transition-colors hover:bg-[var(--glass-hover)]">
                      <HarnessIcon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
                      <span className="flex-1 text-[15px]">{harnessItem.label}</span>
                      <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
                    </Button>}
                    <Button variant="row" size="bare"
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
                    </Button>
                  </Fragment>
                );
              })}
            </Surface>
            </Panel>
          </section>
        ); })}
      </nav>
    </div>
  );
}
