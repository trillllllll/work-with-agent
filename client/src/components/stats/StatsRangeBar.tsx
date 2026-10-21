import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { isValidRange, shortMonthDay, type StatsRangeMode } from '@/lib/stats-range.js';

export function StatsRangeBar({ mode, from, to, valid, onPreset, onCustom }: {
  mode: StatsRangeMode;
  from: string;
  to: string;
  valid: boolean;
  onPreset: (mode: '7d' | '30d') => void;
  onCustom: (from: string, to: string) => void;
}) {
  const { t } = useTranslation('stats');
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const draftValid = isValidRange(draftFrom, draftTo);
  const pill = (selected: boolean) => `shrink-0 rounded-full px-3 py-1 text-sm ${selected ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`;

  function commit(nextFrom: string, nextTo: string) {
    setDraftFrom(nextFrom);
    setDraftTo(nextTo);
    if (isValidRange(nextFrom, nextTo)) onCustom(nextFrom, nextTo);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    setDraftFrom(from);
    setDraftTo(to);
    if (mode !== 'custom' && isValidRange(from, to)) onCustom(from, to);
  }

  return (
    <div className="space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex gap-2" role="group" aria-label={t('range.label')}>
          <button type="button" data-testid="stats-range-7d" aria-pressed={mode === '7d'} className={pill(mode === '7d')} onClick={() => onPreset('7d')}>{t('range.d7')}</button>
          <button type="button" data-testid="stats-range-30d" aria-pressed={mode === '30d'} className={pill(mode === '30d')} onClick={() => onPreset('30d')}>{t('range.d30')}</button>
          <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>
              <button type="button" data-testid="stats-range-custom" aria-pressed={mode === 'custom'} className={pill(mode === 'custom')}>{t('range.custom')}</button>
            </PopoverTrigger>
            <PopoverContent className="w-72 space-y-3 p-3">
              <label className="block space-y-1 text-xs text-muted-foreground">
                {t('range.from')}
                <Input type="date" aria-label={t('range.from')} value={draftFrom} onChange={(event) => commit(event.target.value, draftTo)} />
              </label>
              <label className="block space-y-1 text-xs text-muted-foreground">
                {t('range.to')}
                <Input type="date" aria-label={t('range.to')} value={draftTo} onChange={(event) => commit(draftFrom, event.target.value)} />
              </label>
              {!draftValid && <p className="text-xs text-destructive">{t('range.invalid')}</p>}
            </PopoverContent>
          </Popover>
        </div>
        {valid && <span className="text-sm text-muted-foreground">{t('range.span', { from: shortMonthDay(from), to: shortMonthDay(to) })}</span>}
      </div>
      {!valid && <p className="text-xs text-destructive">{t('range.invalid')}</p>}
    </div>
  );
}
