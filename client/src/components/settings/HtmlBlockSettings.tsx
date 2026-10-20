import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Label } from '@/components/ui/label.js';
import { Textarea } from '@/components/ui/textarea.js';
import { htmlBlockSettingsKey, useHtmlBlockSettings, type HtmlBlockSettings as Settings } from '@/components/chat/HtmlBlock.js';

const lines = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean);

export function HtmlBlockSettings() {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const settings = useHtmlBlockSettings();
  const [cdn, setCdn] = useState('');
  // The switch flips at once and falls back to the saved value once the server answers.
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  // Fill the textarea once; later refreshes must not wipe an edit in progress.
  const filled = useRef(false);
  useEffect(() => { if (settings.data && !filled.current) { filled.current = true; setCdn(settings.data.cdn.join('\n')); } }, [settings.data]);
  const save = useMutation({
    mutationFn: (body: { enabled?: boolean; cdn?: string[] }) => api<Settings>('/api/settings/html-blocks', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (data, body) => { client.setQueryData(htmlBlockSettingsKey, data); setPendingEnabled(null); if (body.cdn) setCdn(data.cdn.join('\n')); toast.success(body.enabled === undefined ? t('htmlBlocks.cdnSaved') : data.enabled ? t('htmlBlocks.enabled') : t('htmlBlocks.disabled')); },
    onError: (error) => { setPendingEnabled(null); toast.error(error.message); },
  });
  const data = settings.data;
  return <section className="mt-8 border-t pt-8" aria-label={t('htmlBlocks.region')}><h2 className="text-lg font-semibold">{t('htmlBlocks.title')}</h2>
    <p className="mt-1 text-sm text-muted-foreground">{t('htmlBlocks.description')}</p>
    {settings.isError ? <p role="alert" className="mt-3 text-sm">{t('htmlBlocks.loadFailed')}<Button variant="ghost" size="sm" onClick={() => void settings.refetch()}>{t('actions.retry')}</Button></p> : <div className="mt-4 space-y-4">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={pendingEnabled ?? data?.enabled ?? false} disabled={!data} onChange={(event) => { setPendingEnabled(event.target.checked); save.mutate({ enabled: event.target.checked }); }} />{t('htmlBlocks.allow')}</label>
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); save.mutate({ cdn: lines(cdn) }); }}>
        <Label htmlFor="html-cdn-allowlist">{t('htmlBlocks.cdnLabel')}</Label>
        <Textarea id="html-cdn-allowlist" rows={4} spellCheck={false} className="font-mono text-xs" value={cdn} disabled={!data || save.isPending} onChange={(event) => setCdn(event.target.value)} />
        <p className="text-xs text-muted-foreground">{t('htmlBlocks.cdnHint')}</p>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={!data || save.isPending}>{t('htmlBlocks.saveCdn')}</Button><Button type="button" variant="outline" disabled={!data || save.isPending} onClick={() => { if (data) { setCdn(data.defaults.join('\n')); save.mutate({ cdn: data.defaults }); } }}>{t('htmlBlocks.restoreDefaults')}</Button></div>
      </form>
    </div>}
  </section>;
}
