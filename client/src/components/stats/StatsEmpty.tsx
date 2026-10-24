import { Surface } from '@/components/ui/surface.js';
import { Button } from '@/components/ui/button.js';
import { useTranslation } from 'react-i18next';
import { Inbox, Plug, Timer } from 'lucide-react';
import type { StatsNav } from './SectionShell.js';

const starters = [
  { icon: Inbox, label: 'empty.inbox', hash: '#/inbox' },
  { icon: Timer, label: 'empty.focus', hash: '#/focus' },
  { icon: Plug, label: 'empty.connections', hash: '#/connections' },
] as const;

const sections = ['tasks', 'focus', 'plan', 'ai'] as const;

export function StatsEmpty({ nav }: { nav: StatsNav }) {
  const { t } = useTranslation('stats');
  return (
    <div data-testid="stats-empty" className="space-y-4">
      <Surface as="div" tone="subtle" className="rounded-xl border p-6">
        <h2 className="text-lg font-semibold">{t('empty.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('empty.description')}</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {starters.map((item) => (
            <Button variant="card" size="bare" key={item.hash} type="button" className="flex items-center gap-2 rounded-xl p-3 text-left text-sm" onClick={() => nav.go(item.hash)}>
              <item.icon className="size-4" />
              {t(item.label)}
            </Button>
          ))}
        </div>
      </Surface>
      <div className="grid gap-3 sm:grid-cols-2">
        {sections.map((id) => (
          <Surface as="section" tone="subtle" key={id} data-testid={`stats-section-${id}`} className="rounded-xl border p-4">
            <h2 className="font-medium">{t(`${id}.title`)}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('section.noData')}</p>
          </Surface>
        ))}
      </div>
    </div>
  );
}
