import { Radio } from '@/components/ui/checkbox.js';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, type ReviewRule, type Settings } from '@/lib/api.js';
import type { Connection } from '@/lib/connection-status.js';
import { settingsHash } from '@/components/settings/settings-categories.js';
import { useSettingsQuery } from '@/components/settings/ModelSettings.js';
import { cn } from '@/lib/utils.js';

const providers = ['none', 'builtin', 'external', 'codex', 'claude'] as const;
type Provider = ReviewRule['provider'];

const titleKey: Record<Provider, string> = {
  none: 'reviews.providerNone',
  builtin: 'reviews.providerBuiltin',
  external: 'reviews.providerExternal',
  codex: 'reviews.providerCodex',
  claude: 'reviews.providerClaude',
};
const detailKey: Record<Provider, string> = {
  none: 'reviews.providerNoneDetail',
  builtin: 'reviews.providerBuiltinDetail',
  external: 'reviews.providerExternalDetail',
  codex: 'reviews.providerCodexDetail',
  claude: 'reviews.providerClaudeDetail',
};
const needKey: Record<Provider, string> = {
  none: 'reviews.providerNoneNeed',
  builtin: 'reviews.providerBuiltinNeed',
  external: 'reviews.providerExternalNeed',
  codex: 'reviews.providerCodexNeed',
  claude: 'reviews.providerClaudeNeed',
};

/** Known-unconfigured only. A failed or in-flight settings query is not treated as missing. */
export function useBuiltinModelState() {
  const settings = useSettingsQuery();
  const data = settings.data;
  const configured = Boolean(data && data.model.trim() && data.baseUrl.trim() && data.apiKeyConfigured);
  return { settings, missing: settings.isSuccess && !configured };
}

function cliCommand(settings: Settings | undefined, provider: 'codex' | 'claude') {
  return settings?.cli?.[provider]?.command?.trim() ?? '';
}

type ProviderCardsProps = {
  value: Provider;
  onChange: (provider: Provider) => void;
};

export function ProviderCards({ value, onChange }: ProviderCardsProps) {
  const { t } = useTranslation('workspace');
  const { settings, missing } = useBuiltinModelState();
  const connections = useQuery({ queryKey: ['connections'], queryFn: () => api<Connection[]>('/api/v1/connections') });
  const activeConnection = (connections.data ?? []).some((connection) => connection.status !== 'revoked');
  const warning = (provider: Provider) => {
    if (provider === 'builtin' && missing) {
      return (
        <span className="text-warning">
          {t('reviews.modelMissing')}{' '}
          <a className="font-medium underline underline-offset-4" href={`#${settingsHash('model')}`}>{t('reviews.modelMissingAction')}</a>
        </span>
      );
    }
    if (provider === 'external' && connections.isSuccess && !activeConnection) return <span className="text-warning">{t('reviews.connectionMissing')}</span>;
    if ((provider === 'codex' || provider === 'claude') && settings.isSuccess && !cliCommand(settings.data, provider)) return <span className="text-warning">{t('reviews.cliMissing')}</span>;
    return null;
  };
  return (
    <div role="radiogroup" aria-label={t('reviews.providerAria')} className="space-y-2">
      {providers.map((provider) => {
        const selected = value === provider;
        const note = warning(provider);
        return (
          <label key={provider} className={cn('block cursor-pointer rounded-xl border px-3 py-3', selected ? 'border-foreground' : 'border-border')}>
            <span className="flex items-start gap-3">
              <Radio  className="mt-1 size-4 shrink-0 accent-primary" name="review-provider" value={provider} aria-label={t(titleKey[provider])} checked={selected} onChange={() => onChange(provider)} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium">{t(titleKey[provider])}</span>
                  {provider === 'none' && <span className="text-xs text-muted-foreground">{t('reviews.providerRecommended')}</span>}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{t(detailKey[provider])}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{t(needKey[provider])}</span>
                {note && <span className="mt-1 block text-xs">{note}</span>}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
