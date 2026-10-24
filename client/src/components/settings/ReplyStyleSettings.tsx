import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Label } from '@/components/ui/label.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { SettingsLoadError } from './ModelSettings.js';

type ReplyStyle = { replyStyle: string; defaultReplyStyle: string };
const queryKey = ['reply-style-settings'];

export function ReplyStyleSettings() {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const query = useQuery({ queryKey, queryFn: () => api<ReplyStyle>('/api/settings/reply-style') });
  const [value, setValue] = useState('');
  const filled = useRef(false);
  useEffect(() => {
    if (query.data && !filled.current) { filled.current = true; setValue(query.data.replyStyle); }
  }, [query.data]);
  const save = useMutation({
    mutationFn: () => api<ReplyStyle>('/api/settings/reply-style', { method: 'PATCH', body: JSON.stringify({ replyStyle: value }) }),
    onSuccess: (data) => { client.setQueryData(queryKey, data); setValue(data.replyStyle); toast.success(t('replyStyle.saved')); },
    onError: (error) => toast.error(error.message),
  });

  return <section aria-labelledby="reply-style-title">
    <h3 id="reply-style-title" className="text-lg font-semibold">{t('replyStyle.title')}</h3>
    <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('replyStyle.description')}</p>
    {query.isLoading ? <Skeleton className="mt-4 h-24 w-full" /> : query.isError ?
      <SettingsLoadError error={query.error} onRetry={() => void query.refetch()} /> :
      <form className="mt-4 space-y-2" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <Label htmlFor="reply-style">{t('replyStyle.label')}</Label>
        <Textarea id="reply-style" aria-describedby="reply-style-hint" rows={3} maxLength={1000} value={value} disabled={save.isPending} onChange={(event) => setValue(event.target.value)} />
        <p id="reply-style-hint" className="text-xs text-muted-foreground">{t('replyStyle.hint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!query.data || save.isPending}>{save.isPending ? t('replyStyle.saving') : t('replyStyle.save')}</Button>
          <Button type="button" variant="outline" disabled={!query.data || save.isPending} onClick={() => setValue(query.data!.defaultReplyStyle)}>{t('replyStyle.restoreDefault')}</Button>
        </div>
      </form>}
  </section>;
}
