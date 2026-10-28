import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { NativeSelect } from '@/components/ui/native-select.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { inDesktopShell } from '@/lib/desktop-shell.js';
import { currentPushSubscription, pushSupport, sendTestPush, subscribeToPush, unsubscribeFromPush, type PushSupport } from '@/lib/push.js';
import { SettingsLoadError } from './ModelSettings.js';

export type ReminderSettingsPayload = { leadMinutes: number; allDayTime: string; timeZone: string; defaultLeadMinutes: number };
const LEAD_CHOICES = [0, 5, 10, 30, 60, 1440, 43200];
const queryKey = ['reminder-settings'];

function leadLabel(value: number, t: (key: string, options?: Record<string, unknown>) => string) {
  if (value === 0) return t('reminders.leadAtTime');
  if (value % 1440 === 0) return t('reminders.leadDays', { count: value / 1440 });
  return t('reminders.leadMinutes', { count: value });
}

export function RemindersSettings() {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const query = useQuery({ queryKey, queryFn: () => api<ReminderSettingsPayload>('/api/settings/reminders') });
  const [lead, setLead] = useState('');
  const [allDayTime, setAllDayTime] = useState('');
  const [timeZone, setTimeZone] = useState('');
  const [saving, setSaving] = useState(false);
  const loaded = useRef(false);
  useEffect(() => {
    if (query.data && !loaded.current) {
      loaded.current = true;
      setLead(String(query.data.leadMinutes));
      setAllDayTime(query.data.allDayTime);
      setTimeZone(query.data.timeZone);
    }
  }, [query.data]);
  const dirty = query.data ? Number(lead) !== query.data.leadMinutes || allDayTime !== query.data.allDayTime || timeZone.trim() !== query.data.timeZone : false;
  const valid = (lead === '' || (!Number.isNaN(Number(lead)) && Number(lead) >= 0 && Number(lead) <= 43200 && Number.isInteger(Number(lead)))) && /^\d{2}:\d{2}$/.test(allDayTime) && timeZone.trim().length > 0;
  const save = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      const data = await api<ReminderSettingsPayload>('/api/settings/reminders', { method: 'PATCH', body: JSON.stringify({
        leadMinutes: Number(lead), allDayTime, timeZone: timeZone.trim(),
      }) });
      client.setQueryData(queryKey, data);
      toast.success(t('reminders.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return <section aria-labelledby="reminders-title">
    <h3 id="reminders-title" className="text-lg font-semibold">{t('reminders.title')}</h3>
    <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('reminders.description')}</p>
    {query.isLoading ? <Skeleton className="mt-4 h-40 w-full" /> : query.isError ?
      <SettingsLoadError error={query.error} onRetry={() => void query.refetch()} /> :
      <div className="mt-4 max-w-md space-y-4">
        <div>
          <Label htmlFor="reminder-lead">{t('reminders.lead')}</Label>
          <div className="mt-1 flex gap-2">
            <NativeSelect id="reminder-lead" className="h-9 flex-1 rounded-md px-2" value={LEAD_CHOICES.includes(Number(lead)) ? lead : 'custom'} disabled={saving}
              onChange={(event) => { if (event.target.value !== 'custom') setLead(event.target.value); }}>
              {LEAD_CHOICES.map((value) => <option key={value} value={String(value)}>{leadLabel(value, t)}</option>)}
              <option value="custom">{t('reminders.leadCustom')}</option>
            </NativeSelect>
            {!LEAD_CHOICES.includes(Number(lead)) && <Input aria-label={t('reminders.leadMinutes', { count: 1 })} inputMode="numeric" className="h-9 w-24" value={lead} disabled={saving} onChange={(event) => setLead(event.target.value.replace(/[^\d]/g, ''))} />}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('reminders.leadHint', { count: query.data?.defaultLeadMinutes ?? 10 })}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="reminder-allday">{t('reminders.allDayTime')}</Label>
            <Input id="reminder-allday" type="time" className="mt-1 h-9" value={allDayTime} disabled={saving} onChange={(event) => setAllDayTime(event.target.value)} />
          </div>
          <div>
            <Label htmlFor="reminder-zone">{t('reminders.timeZone')}</Label>
            <Input id="reminder-zone" className="mt-1 h-9" placeholder="Asia/Shanghai" value={timeZone} disabled={saving} onChange={(event) => setTimeZone(event.target.value)} />
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="button" disabled={saving || !dirty || !valid} onClick={() => void save()}>{saving ? t('reminders.saving') : t('reminders.save')}</Button>
          <Button type="button" variant="outline" disabled={saving || !dirty} onClick={() => { setLead(String(query.data!.leadMinutes)); setAllDayTime(query.data!.allDayTime); setTimeZone(query.data!.timeZone); }}>{t('reminders.cancel')}</Button>
        </div>
      </div>}
    <PushCard />
  </section>;
}

type PushState = { support: PushSupport; subscribed: boolean; busy: boolean };

function PushCard() {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<PushState>({ support: pushSupport(), subscribed: false, busy: true });
  const refresh = useCallback(async () => {
    const subscription = await currentPushSubscription();
    setState({ support: pushSupport(), subscribed: Boolean(subscription), busy: false });
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const subscribe = async () => {
    setState((current) => ({ ...current, busy: true }));
    try {
      const result = await subscribeToPush();
      if (result.ok) toast.success(t('reminders.push.subscribed', { count: result.count }));
      else toast.error(t(`reminders.push.denied.${result.reason === 'denied' ? 'denied' : result.reason === 'unavailable' ? 'unavailable' : result.reason === 'no-worker' ? 'noWorker' : 'generic'}`));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { void refresh(); }
  };
  const stop = async () => {
    setState((current) => ({ ...current, busy: true }));
    try {
      const result = await unsubscribeFromPush();
      toast.success(t('reminders.push.unsubscribed', { count: 'count' in result ? result.count : 0 }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { void refresh(); }
  };
  const test = async () => {
    setState((current) => ({ ...current, busy: true }));
    try {
      const result = await sendTestPush();
      if (result.noSubscriptions) toast.info(t('reminders.push.noSubscriptions'));
      else toast.success(t('reminders.push.sent', { count: result.sent }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { void refresh(); }
  };
  const hint = state.support === 'desktop' ? t('reminders.push.hintDesktop')
    : state.support === 'ios-browser' ? t('reminders.push.hintIos')
      : state.support === 'unsupported' ? t('reminders.push.hintUnsupported')
        : state.support === 'insecure' ? t('reminders.push.hintInsecure')
          : state.support === 'denied' ? t('reminders.push.hintDenied')
            : '';
  return <div className="mt-8 max-w-md rounded-xl border bg-card/40 p-4" data-testid="push-card">
    <p className="text-sm font-medium">{t('reminders.push.title')}</p>
    {inDesktopShell() ? <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('reminders.push.desktop')}</p> : <>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('reminders.push.description')}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {state.subscribed
          ? <>
            <Button type="button" variant="outline" size="sm" disabled={state.busy || state.support === 'unsupported' || state.support === 'ios-browser' || state.support === 'insecure'} onClick={() => void stop()}>{t('reminders.push.stop')}</Button>
            <Button type="button" variant="ghost" size="sm" disabled={state.busy || state.support === 'unsupported'} onClick={() => void test()}>{t('reminders.push.test')}</Button>
          </>
          : <Button type="button" size="sm" disabled={state.busy || state.support === 'denied' || state.support === 'unsupported' || state.support === 'ios-browser' || state.support === 'insecure'} onClick={() => void subscribe()}>{t('reminders.push.subscribe')}</Button>}
      </div>
    </>}
  </div>;
}
