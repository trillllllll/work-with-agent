import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
type ImageSettings = { provider: 'brave'; configured: boolean; keyMasked: string | null; managedBy: 'environment' | 'application' };
export function ImageSearchSettings() {
  const { t } = useTranslation('settings');
  const client = useQueryClient(); const [key, setKey] = useState('');
  const settings = useQuery({ queryKey: ['image-search-settings'], queryFn: () => api<ImageSettings>('/api/settings/image-search') });
  const save = useMutation({ mutationFn: (clear: boolean) => api<ImageSettings>('/api/settings/image-search', clear ? { method: 'DELETE' } : { method: 'PATCH', body: JSON.stringify({ apiKey: key.trim() }) }),
    onSuccess: (data) => { client.setQueryData(['image-search-settings'], data); setKey(''); toast.success(data.configured ? t('imageSearch.saved') : t('imageSearch.cleared')); },
    onError: (error) => toast.error(error.message),
  });
  const environment = settings.data?.managedBy === 'environment';
  return <section className="mt-8 border-t pt-8" aria-label={t('imageSearch.region')}><h2 className="text-lg font-semibold">{t('imageSearch.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('imageSearch.description')}</p>
    {settings.isError ? <p role="alert" className="mt-3 text-sm">{t('imageSearch.loadFailed')}<Button variant="ghost" size="sm" onClick={() => void settings.refetch()}>{t('actions.retry')}</Button></p> : <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate(false); }}>
      <Label htmlFor="brave-image-key">{t('imageSearch.apiKey')}</Label><Input id="brave-image-key" type="password" autoComplete="new-password" value={key} disabled={environment || save.isPending || settings.isLoading} onChange={(event) => setKey(event.target.value)} placeholder={settings.data?.configured ? t('imageSearch.configuredPlaceholder', { masked: settings.data.keyMasked }) : t('imageSearch.enterKey')} />
      <p className="text-xs text-muted-foreground">{environment ? t('imageSearch.managedByEnvironment') : settings.data?.configured ? t('imageSearch.currentKey', { masked: settings.data.keyMasked }) : t('imageSearch.unavailable')}</p>
      {!environment && <div className="flex flex-wrap gap-2"><Button type="submit" disabled={!key.trim() || save.isPending}>{t('imageSearch.save')}</Button>{settings.data?.configured && <Button type="button" variant="outline" disabled={save.isPending} onClick={() => save.mutate(true)}>{t('imageSearch.clear')}</Button>}</div>}
    </form>}
  </section>;
}
