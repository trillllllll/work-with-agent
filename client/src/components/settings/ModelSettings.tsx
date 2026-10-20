import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type Settings } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';

/** Shared by every block that reads `/api/settings`; the same query key keeps one request. */
export function useSettingsQuery() {
  return useQuery<Settings>({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
}

/** Error row for blocks that depend on `/api/settings`. Other blocks keep working when it fails. */
export function SettingsLoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation('settings');
  return (
    <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <span>{error instanceof Error ? error.message : t('modelSettings.loadFailed')}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>{t('actions.retry')}</Button>
    </div>
  );
}

export function ModelSettings() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearKeyConfirmation, setClearKeyConfirmation] = useState(false);
  const settingsQuery = useSettingsQuery();
  useEffect(() => {
    if (!settingsQuery.data) return;
    setBaseUrl(settingsQuery.data.baseUrl);
    setModel(settingsQuery.data.model);
  }, [settingsQuery.data]);
  const save = useMutation<Settings, Error, void>({
    mutationFn: () => api('/api/settings', { method: 'PATCH', body: JSON.stringify({ baseUrl, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }) }),
    onSuccess: (data) => { queryClient.setQueryData(['settings'], data); setApiKey(''); toast.success(t('modelSettings.saved')); },
    onError: (error) => { toast.error(error.message); },
  });
  const clearKey = useMutation<Settings, Error, void>({
    mutationFn: () => api('/api/settings/api-key', { method: 'DELETE' }),
    onSuccess: (data) => { queryClient.setQueryData(['settings'], data); setClearKeyConfirmation(false); setApiKey(''); toast.success(t('modelSettings.cleared')); },
    onError: (error) => { setClearKeyConfirmation(false); toast.error(error.message); },
  });

  return (
    <section aria-labelledby="settings-model-title">
      <h3 id="settings-model-title" className="text-lg font-semibold">{t('modelSettings.title')}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('modelSettings.description')}</p>
      {settingsQuery.isLoading ? (
        <div className="mt-4" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="mt-4 h-10 w-full" />
          <Skeleton className="mt-4 h-10 w-full" />
        </div>
      ) : settingsQuery.isError ? (
        <SettingsLoadError error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />
      ) : (
        <form className="mt-4" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
          <div className="mb-4">
            <Label htmlFor="settings-base-url">{t('modelSettings.baseUrl')}</Label>
            <Input id="settings-base-url" required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
          </div>
          <div className="mb-4">
            <Label htmlFor="settings-model">{t('modelSettings.model')}</Label>
            <Input id="settings-model" required value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" />
          </div>
          <div className="mb-4">
            <Label htmlFor="settings-api-key">{t('modelSettings.apiKey')}</Label>
            <Input id="settings-api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settingsQuery.data?.apiKeyConfigured ? t('modelSettings.configuredPlaceholder', { masked: settingsQuery.data.apiKeyMasked ?? '' }) : t('modelSettings.enterKey')} autoComplete="new-password" />
          </div>
          <div className="glass-subtle mb-6 rounded-xl px-3.5 py-2.5 text-xs text-muted-foreground">
            {settingsQuery.data?.apiKeyConfigured ? <Trans ns="settings" i18nKey="modelSettings.currentKey" t={t} values={{ masked: settingsQuery.data.apiKeyMasked ?? '' }} components={{ code: <code className="font-mono text-foreground" /> }} /> : t('modelSettings.noApiKey')}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={save.isPending || clearKey.isPending}>{save.isPending ? t('modelSettings.testing') : t('modelSettings.testAndSave')}</Button>
            {settingsQuery.data?.apiKeyConfigured && (
              <Button type="button" variant="outline" className="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={save.isPending || clearKey.isPending} onClick={() => setClearKeyConfirmation(true)}>
                {clearKey.isPending ? t('modelSettings.clearing') : t('modelSettings.clearKey')}
              </Button>
            )}
          </div>
        </form>
      )}
      {clearKeyConfirmation && (
        <ConfirmDialog
          title={t('modelSettings.clearKeyTitle')}
          itemName={t('modelSettings.clearKeyItem')}
          description={t('modelSettings.clearKeyDescription')}
          busy={clearKey.isPending}
          onCancel={() => setClearKeyConfirmation(false)}
          onConfirm={() => clearKey.mutate()}
        />
      )}
    </section>
  );
}
