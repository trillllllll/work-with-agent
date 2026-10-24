import { Surface } from '@/components/ui/surface.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CliCommandSetting, type Settings } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { SettingsLoadError, useSettingsQuery } from './ModelSettings.js';

export const cliNames = { codex: 'Codex', claude: 'Claude Code' } as const;

export function CliCommands({ embedded = false }: { embedded?: boolean }) {
  const settingsQuery = useSettingsQuery();
  const { t } = useTranslation('settings');
  const labelled = embedded ? { 'aria-label': t('cli.title') } : { 'aria-labelledby': 'settings-cli-title' };
  if (settingsQuery.isLoading) return <section {...labelled} aria-busy="true">{!embedded && <h3 id="settings-cli-title" className="text-lg font-semibold">{t('cli.title')}</h3>}<Skeleton className="mt-4 h-24 w-full" /></section>;
  if (settingsQuery.isError) return <section {...labelled}>{!embedded && <h3 id="settings-cli-title" className="text-lg font-semibold">{t('cli.title')}</h3>}<SettingsLoadError error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} /></section>;
  return <CliCommandForms settings={settingsQuery.data} embedded={embedded} />;
}

function CliCommandForms({ settings, embedded = false }: { settings?: Settings; embedded?: boolean }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState({ codex: '', claude: '' });
  const [notice, setNotice] = useState('');
  const discover = useMutation({
    mutationFn: () => api<Settings>('/api/settings/cli/discover', { method: 'POST', body: '{}' }),
    onSuccess: (data) => {
      queryClient.setQueryData(['settings'], data);
      const pending = (['codex', 'claude'] as const).filter((provider) => data.discovered?.[provider] && data.cli?.[provider]?.source === 'manual' && data.discovered[provider].command && data.discovered[provider].command !== data.cli?.[provider]?.manualCommand);
      const missing = (['codex', 'claude'] as const).filter((provider) => data.discovered?.[provider]?.message);
      const found = pending.map((provider) => `${cliNames[provider]} ${data.discovered?.[provider]?.command}`).join(t('cli.listSeparator'));
      setNotice([pending.length ? t('cli.keptManual', { found }) : t('cli.discoverUpdated'), missing.map((provider) => data.discovered?.[provider]?.message).filter(Boolean).join(t('cli.messageSeparator'))].filter(Boolean).join(' '));
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const saveManual = useMutation({
    mutationFn: (input: { provider: 'codex' | 'claude'; command: string }) => api<CliCommandSetting>('/api/settings/cli', { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['settings'] }); setNotice(t('cli.saved')); },
    onError: (error: Error) => setNotice(error.message),
  });
  const restore = useMutation({
    mutationFn: (provider: 'codex' | 'claude') => api<CliCommandSetting>(`/api/settings/cli/${provider}`, { method: 'DELETE' }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['settings'] }); setNotice(t('cli.restored')); },
    onError: (error: Error) => setNotice(error.message),
  });
  return (
    <section aria-label={embedded ? t('cli.title') : undefined} aria-labelledby={embedded ? undefined : 'settings-cli-title'}>
      {!embedded && <>
        <h3 id="settings-cli-title" className="text-lg font-semibold">{t('cli.title')}</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('cli.description')}</p>
      </>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={discover.isPending} onClick={() => discover.mutate()}>{discover.isPending ? t('cli.checking') : t('cli.autoCheck')}</Button>
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      </div>
      {(['codex', 'claude'] as const).map((provider) => {
        const item = settings?.cli?.[provider];
        const source = item?.source === 'manual' ? t('cli.sourceManual') : item?.source === 'auto' ? t('cli.sourceAuto') : t('cli.sourceNone');
        return (
          <Surface as="form" tone="subtle" key={provider} className="mt-4 space-y-3 rounded-xl p-4" onSubmit={(event) => { event.preventDefault(); saveManual.mutate({ provider, command: drafts[provider] || item?.command || '' }); }}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="font-medium">{cliNames[provider]}</h4>
              <span className="text-xs text-muted-foreground">{source}{item?.version ? ` · ${item.version}` : ''}</span>
            </div>
            <p className="break-all text-xs text-muted-foreground">{item?.command || t('cli.noCommand')}</p>
            <Label htmlFor={`cli-${provider}`}>{t('cli.commandPath')}</Label>
            <Input id={`cli-${provider}`} value={drafts[provider]} onChange={(event) => setDrafts((current) => ({ ...current, [provider]: event.target.value }))} placeholder={item?.command || (provider === 'codex' ? t('cli.codexPlaceholder') : t('cli.claudePlaceholder'))} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={saveManual.isPending}>{t('cli.saveManual')}</Button>
              {item?.source === 'manual' && <Button type="button" size="sm" variant="outline" disabled={restore.isPending} onClick={() => restore.mutate(provider)}>{t('cli.restoreAuto')}</Button>}
            </div>
          </Surface>
        );
      })}
    </section>
  );
}
