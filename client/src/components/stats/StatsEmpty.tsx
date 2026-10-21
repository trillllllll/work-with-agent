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
      <div className="glass-subtle rounded-xl border p-6">
        <h2 className="text-lg font-semibold">{t('empty.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('empty.description')}</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {starters.map((item) => (
            <button key={item.hash} type="button" className="glass-subtle flex items-center gap-2 rounded-xl border p-3 text-left text-sm" onClick={() => nav.go(item.hash)}>
              <item.icon className="size-4" />
              {t(item.label)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {sections.map((id) => (
          <section key={id} data-testid={`stats-section-${id}`} className="glass-subtle rounded-xl border p-4">
            <h2 className="font-medium">{t(`${id}.title`)}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('section.noData')}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
