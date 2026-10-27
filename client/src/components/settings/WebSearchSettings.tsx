import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
type WebSettings = { provider: 'deepseek'; configured: boolean; keyMasked: string | null; managedBy: 'environment' | 'application' | 'model' };
export function WebSearchSettings() {
  const { t } = useTranslation('settings');
  const client = useQueryClient(); const [key, setKey] = useState('');
  const settings = useQuery({ queryKey: ['web-search-settings'], queryFn: () => api<WebSettings>('/api/settings/web-search') });
  const save = useMutation({ mutationFn: (clear: boolean) => api<WebSettings>('/api/settings/web-search', clear ? { method: 'DELETE' } : { method: 'PATCH', body: JSON.stringify({ apiKey: key.trim() }) }),
    onSuccess: (data) => { client.setQueryData(['web-search-settings'], data); setKey(''); toast.success(data.configured ? t('webSearch.saved') : t('webSearch.cleared')); },
    onError: (error) => toast.error(error.message),
  });
  const environment = settings.data?.managedBy === 'environment';
  return <section aria-label={t('webSearch.region')}><h3 className="text-lg font-semibold">{t('webSearch.title')}</h3><p className="mt-1 text-sm text-muted-foreground">{t('webSearch.description')}</p>
    {settings.isError ? <p role="alert" className="mt-3 text-sm">{t('webSearch.loadFailed')}<Button variant="ghost" size="sm" onClick={() => void settings.refetch()}>{t('actions.retry')}</Button></p> : <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate(false); }}>
      <Label htmlFor="deepseek-web-key">{t('webSearch.apiKey')}</Label><Input id="deepseek-web-key" type="password" autoComplete="new-password" value={key} disabled={environment || save.isPending || settings.isLoading} onChange={(event) => setKey(event.target.value)} placeholder={settings.data?.configured ? t('webSearch.configuredPlaceholder', { masked: settings.data.keyMasked }) : t('webSearch.enterKey')} />
      <p className="text-xs text-muted-foreground">{environment ? t('webSearch.managedByEnvironment') : settings.data?.configured ? t('webSearch.currentKey', { masked: settings.data.keyMasked }) : t('webSearch.unavailable')}</p>
      {!environment && <div className="flex flex-wrap gap-2"><Button type="submit" disabled={!key.trim() || save.isPending}>{t('webSearch.save')}</Button>{settings.data?.configured && settings.data?.managedBy === 'application' && <Button type="button" variant="outline" disabled={save.isPending} onClick={() => save.mutate(true)}>{t('webSearch.clear')}</Button>}</div>}
    </form>}
  </section>;
}
