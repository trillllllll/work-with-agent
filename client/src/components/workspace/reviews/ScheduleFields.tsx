import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { weekdayOrder } from '@/lib/review-format.js';
import { cn } from '@/lib/utils.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';

export type ReviewSchedule = {
  frequency: 'daily' | 'weekly';
  weekDay: number;
  timeOfDay: string;
  timeZone: string;
};

type IntlWithZones = typeof Intl & { supportedValuesOf?: (key: string) => string[] };

export function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

function supportedTimeZones() {
  const intl = Intl as IntlWithZones;
  if (typeof intl.supportedValuesOf !== 'function') return null;
  try {
    const zones = intl.supportedValuesOf('timeZone');
    return zones.length > 0 ? zones : null;
  } catch { return null; }
}

/** `type=time` may include seconds. The API accepts HH:MM only. */
export function normalizeTime(value: string) {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  return match ? `${match[1]}:${match[2]}` : value;
}

type ScheduleFieldsProps = {
  value: ReviewSchedule;
  onChange: (patch: Partial<ReviewSchedule>) => void;
};

export function ScheduleFields({ value, onChange }: ScheduleFieldsProps) {
  const { t } = useTranslation('workspace');
  const zones = useMemo(() => supportedTimeZones(), []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = (zones ?? []).filter((zone) => zone.toLowerCase().includes(needle)).slice(0, 200);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-lg border p-1" role="group" aria-label={t('reviews.scheduleAria')}>
          <Button type="button" size="sm" variant={value.frequency === 'daily' ? 'secondary' : 'ghost'} aria-pressed={value.frequency === 'daily'} onClick={() => onChange({ frequency: 'daily' })}>{t('reviews.daily')}</Button>
          <Button type="button" size="sm" variant={value.frequency === 'weekly' ? 'secondary' : 'ghost'} aria-pressed={value.frequency === 'weekly'} onClick={() => onChange({ frequency: 'weekly' })}>{t('reviews.weekly')}</Button>
        </div>
        <Input aria-label={t('reviews.timeAria')} className="w-32" type="time" required value={value.timeOfDay} onChange={(event) => onChange({ timeOfDay: event.target.value })} />
      </div>
      {value.frequency === 'weekly' && (
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('reviews.weekdayAria')}>
          {weekdayOrder.map((day) => (
            <Button key={day} type="button" size="sm" variant={value.weekDay === day ? 'default' : 'outline'} className="w-9 px-0" aria-pressed={value.weekDay === day} aria-label={t(`reviews.weekday.${day}`)} onClick={() => onChange({ weekDay: day })}>
              {t(`reviews.weekdayShort.${day}`)}
            </Button>
          ))}
        </div>
      )}
      {zones ? (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>{t('reviews.zoneLocal', { zone: value.timeZone })}</span>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="link" size="sm" className="h-auto px-1">{t('reviews.zoneChange')}</Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-2" align="start">
              <Input autoFocus aria-label={t('reviews.zoneSearch')} placeholder={t('reviews.zoneSearch')} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} />
              <ul className="mt-2 max-h-60 overflow-y-auto">
                {matches.length === 0 && <li className="px-2 py-1 text-xs text-muted-foreground">{t('reviews.zoneEmpty')}</li>}
                {matches.map((zone) => (
                  <li key={zone}>
                    <Button variant="row" size="bare" type="button" className={cn('w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted', zone === value.timeZone && 'bg-muted')} onClick={() => { onChange({ timeZone: zone }); setQuery(''); setOpen(false); }}>{zone}</Button>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        </div>
      ) : (
        <Input aria-label={t('reviews.zoneAria')} required value={value.timeZone} onChange={(event) => onChange({ timeZone: event.target.value })} />
      )}
    </div>
  );
}
