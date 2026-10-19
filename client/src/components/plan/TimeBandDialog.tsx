import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import type { PlanTimeBand, PlanTimeBandsPayload, TimeBandColor } from '@/lib/api.js';
import { api } from '@/lib/api.js';
import { t } from '@/i18n/index.js';
import { formatMinuteLabel, parseEndMinute, parseStartMinute } from '@/lib/plan-time-bands.js';
import { cn } from '@/lib/utils.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { planTimeBandsKey, usePlanTimeBands } from './usePlanTimeBands.js';

const weekdays = [
  [1, 'mon'],
  [2, 'tue'],
  [3, 'wed'],
  [4, 'thu'],
  [5, 'fri'],
  [6, 'sat'],
  [7, 'sun'],
] as const;
const colors = ['blue', 'green', 'orange', 'purple', 'pink', 'gray'] as const;

type Draft = {
  id: string;
  name: string;
  startText: string;
  endText: string;
  weekdays: number[];
  color: TimeBandColor;
};
type FieldErrors = Partial<Record<'name' | 'start' | 'end' | 'weekdays', string>>;

function toDraft(band: PlanTimeBand): Draft {
  return {
    id: band.id,
    name: band.name,
    startText: formatMinuteLabel(band.startMinute),
    endText: formatMinuteLabel(band.endMinute),
    weekdays: [...band.weekdays],
    color: band.color,
  };
}
function createDraft(): Draft {
  return { id: crypto.randomUUID(), name: '', startText: '09:00', endText: '18:00', weekdays: [1, 2, 3, 4, 5], color: 'blue' };
}
function fieldErrors(draft: Draft): FieldErrors {
  const errors: FieldErrors = {};
  const name = draft.name.trim();
  if (name.length < 1 || name.length > 40) errors.name = t('plan:timeBand.error.name');
  if (!draft.weekdays.length) errors.weekdays = t('plan:timeBand.error.weekday');
  const start = parseStartMinute(draft.startText);
  const end = parseEndMinute(draft.endText);
  if (start === null) errors.start = t('plan:timeBand.error.format');
  if (end === null) errors.end = t('plan:timeBand.error.format');
  if (start !== null && end !== null && end <= start) errors.end = t('plan:timeBand.error.range');
  return errors;
}
function toBand(draft: Draft): PlanTimeBand | null {
  const errors = fieldErrors(draft);
  if (errors.name || errors.start || errors.end || errors.weekdays) return null;
  const startMinute = parseStartMinute(draft.startText);
  const endMinute = parseEndMinute(draft.endText);
  if (startMinute === null || endMinute === null) return null;
  return {
    id: draft.id,
    name: draft.name.trim(),
    startMinute,
    endMinute,
    weekdays: [...draft.weekdays].sort((left, right) => left - right),
    color: draft.color,
  };
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return <p id={id} className="text-destructive" style={{ fontSize: 12, lineHeight: '16px' }}>{message}</p>;
}

function EditorCard({ draft, errors, disabled, onChange, onBlur, onDelete }: {
  draft: Draft;
  errors: FieldErrors;
  disabled: boolean;
  onChange: (next: Draft) => void;
  onBlur: (next: Draft, field: keyof FieldErrors) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('plan');
  const nameId = `${draft.id}-name-error`;
  const startId = `${draft.id}-start-error`;
  const endId = `${draft.id}-end-error`;
  const weekdayId = `${draft.id}-weekday-error`;
  return <article data-testid="time-band-editor" data-band-id={draft.id} className="border border-[var(--glass-border)]" style={{ borderRadius: 12, padding: 12 }}>
    <div className="grid" style={{ gap: 12 }}>
      <label className="block" style={{ fontSize: 12, lineHeight: '16px' }}>
        {t('timeBand.name')}
        <Input aria-label={t('timeBand.name')} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? nameId : undefined} value={draft.name} disabled={disabled} autoComplete="off" className="mt-1" style={{ height: 40, fontSize: 14 }} onChange={(event) => onChange({ ...draft, name: event.target.value })} onBlur={(event) => onBlur({ ...draft, name: event.target.value }, 'name')} />
        <FieldError id={nameId} message={errors.name} />
      </label>
      <div className="grid grid-cols-2" style={{ gap: 12 }}>
        <label className="block min-w-0" style={{ fontSize: 12, lineHeight: '16px' }}>
          {t('timeBand.start')}
          <Input aria-label={t('timeBand.start')} aria-invalid={Boolean(errors.start)} aria-describedby={errors.start ? startId : undefined} value={draft.startText} disabled={disabled} autoComplete="off" inputMode="text" className="mt-1" style={{ height: 40, fontSize: 14 }} onChange={(event) => onChange({ ...draft, startText: event.target.value })} onBlur={(event) => onBlur({ ...draft, startText: event.target.value }, 'start')} />
          <FieldError id={startId} message={errors.start} />
        </label>
        <label className="block min-w-0" style={{ fontSize: 12, lineHeight: '16px' }}>
          {t('timeBand.end')}
          <Input aria-label={t('timeBand.end')} aria-invalid={Boolean(errors.end)} aria-describedby={errors.end ? endId : undefined} value={draft.endText} disabled={disabled} autoComplete="off" inputMode="text" className="mt-1" style={{ height: 40, fontSize: 14 }} onChange={(event) => onChange({ ...draft, endText: event.target.value })} onBlur={(event) => onBlur({ ...draft, endText: event.target.value }, 'end')} />
          <FieldError id={endId} message={errors.end} />
        </label>
      </div>
      <div>
        <div className="mb-1" style={{ fontSize: 12, lineHeight: '16px' }}>{t('timeBand.repeat')}</div>
        <div role="group" aria-label={t('timeBand.repeatDays')} aria-describedby={errors.weekdays ? weekdayId : undefined} className="flex flex-wrap" style={{ gap: 4 }}>
          {weekdays.map(([value, day]) => {
            const pressed = draft.weekdays.includes(value);
            return <button key={value} type="button" aria-label={t(`weekday.${day}.full`)} aria-pressed={pressed} disabled={disabled} className={cn('rounded-md border border-[var(--glass-border)]', pressed && 'bg-[var(--glass-hover)] font-medium')} style={{ minWidth: 32, height: 36, paddingInline: 6, fontSize: 14 }} onClick={() => {
              const nextDraft = { ...draft, weekdays: pressed ? draft.weekdays.filter((weekday) => weekday !== value) : [...draft.weekdays, value] };
              onChange(nextDraft);
              onBlur(nextDraft, 'weekdays');
            }}>{t(`weekday.${day}.narrow`)}</button>;
          })}
        </div>
        <FieldError id={weekdayId} message={errors.weekdays} />
      </div>
      <div>
        <div className="mb-1" style={{ fontSize: 12, lineHeight: '16px' }}>{t('timeBand.color')}</div>
        <div className="flex flex-wrap" style={{ gap: 4 }}>
          {colors.map((value) => {
            const pressed = draft.color === value;
            return <button key={value} type="button" aria-label={t(`timeBand.colors.${value}`)} aria-pressed={pressed} disabled={disabled} className="relative inline-flex items-center justify-center rounded-md" style={{ width: 36, height: 36, outline: pressed ? `2px solid var(--time-band-${value}-fg)` : undefined, outlineOffset: 0 }} onClick={() => onChange({ ...draft, color: value })}>
              <span aria-hidden="true" style={{ width: 20, height: 20, backgroundColor: `var(--time-band-${value}-bg)` }} />
              {pressed && <Check aria-hidden="true" className="absolute" style={{ width: 14, height: 14, color: `var(--time-band-${value}-fg)` }} />}
            </button>;
          })}
        </div>
      </div>
      <div><Button type="button" variant="ghost" disabled={disabled} onClick={onDelete}>{t('timeBand.delete')}</Button></div>
    </div>
  </article>;
}

export function TimeBandControls() {
  const { t } = useTranslation('plan');
  const queryClient = useQueryClient();
  const query = usePlanTimeBands();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [errors, setErrors] = useState<Record<string, FieldErrors>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || drafts || !query.isSuccess) return;
    setDrafts(query.data.bands.map((band) => toDraft(structuredClone(band))));
  }, [open, drafts, query.isSuccess, query.data]);

  const close = () => {
    if (saving) return;
    setOpen(false);
    setDrafts(null);
    setErrors({});
    setSaveError(null);
  };
  const openDialog = () => {
    setSaveError(null);
    setErrors({});
    setDrafts(query.isSuccess ? query.data.bands.map((band) => toDraft(structuredClone(band))) : null);
    setOpen(true);
  };
  const update = (id: string, next: Draft) => {
    setDrafts((current) => current?.map((draft) => draft.id === id ? next : draft) ?? current);
  };
  const blur = (draft: Draft, field: keyof FieldErrors) => {
    setDrafts((current) => current?.map((item) => item.id === draft.id ? draft : item) ?? current);
    const next = fieldErrors(draft);
    setErrors((current) => ({
      ...current,
      [draft.id]: field === 'start' || field === 'end'
        ? { ...current[draft.id], start: next.start, end: next.end }
        : { ...current[draft.id], [field]: next[field] },
    }));
  };
  const save = async () => {
    if (!drafts || saving) return;
    const nextErrors = Object.fromEntries(drafts.map((draft) => [draft.id, fieldErrors(draft)]));
    setErrors(nextErrors);
    if (drafts.some((draft) => Object.values(nextErrors[draft.id] ?? {}).some(Boolean))) return;
    const payload = drafts.flatMap((draft) => {
      const band = toBand(draft);
      return band ? [band] : [];
    });
    if (payload.length !== drafts.length) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api<PlanTimeBandsPayload>('/api/plan/time-bands', { method: 'PUT', body: JSON.stringify({ bands: payload }) });
      queryClient.setQueryData(planTimeBandsKey, saved);
      toast.success(t('timeBand.saved'));
      setSaving(false);
      setOpen(false);
      setDrafts(null);
      setErrors({});
    } catch {
      setSaveError(t('timeBand.saveFailed'));
      setSaving(false);
    }
  };
  const atLimit = (drafts?.length ?? 0) >= 100;

  return <>
    <button ref={triggerRef} type="button" className="glass-control inline-flex items-center justify-center rounded-md" style={{ height: 36, paddingLeft: 12, paddingRight: 12, fontSize: 14 }} onClick={openDialog}>{t('timeBand.open')}</button>
    {query.isError && <p role="alert" className="flex items-center gap-2 text-xs text-destructive">{t('timeBand.loadFailed')}<button type="button" className="underline" onClick={() => { void query.refetch(); }}>{t('timeBand.retry')}</button></p>}
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent
        surface="glass"
        className="flex w-[min(640px,calc(100vw-32px))] max-w-none flex-col gap-4 overflow-hidden p-6 max-[639px]:p-4"
        style={{ maxHeight: 'calc(100dvh - 32px)' }}
        onEscapeKeyDown={(event) => { if (saving) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (saving) event.preventDefault(); }}
        onInteractOutside={(event) => { if (saving) event.preventDefault(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle style={{ fontSize: 18, lineHeight: '28px', fontWeight: 600 }}>{t('timeBand.title')}</DialogTitle>
          <DialogDescription>{t('timeBand.description')}</DialogDescription>
        </DialogHeader>
        {!drafts ? <div className="min-w-0" style={{ display: 'grid', gap: 16 }}>
          {query.isError ? <p role="alert" className="text-destructive">{t('timeBand.loadFailed')}<button type="button" className="ml-2 underline" onClick={() => { void query.refetch(); }}>{t('timeBand.retry')}</button></p> : <p>{t('timeBand.loading')}</p>}
        </div> : <form className="flex min-h-0 flex-1 flex-col" style={{ gap: 16 }} onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <fieldset disabled={saving} className="flex min-h-0 min-w-0 flex-1 flex-col border-0 p-0" style={{ gap: 16 }}>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              {drafts.length === 0 && <p className="text-sm text-muted-foreground">{t('timeBand.empty')}</p>}
              <div style={{ display: 'grid', gap: 12 }}>
                {drafts.map((draft) => <EditorCard key={draft.id} draft={draft} errors={errors[draft.id] ?? {}} disabled={saving} onChange={(next) => update(draft.id, next)} onBlur={blur} onDelete={() => { setDrafts(drafts.filter((item) => item.id !== draft.id)); setErrors((current) => { const next = { ...current }; delete next[draft.id]; return next; }); }} />)}
              </div>
              <div className="mt-3 flex flex-wrap items-center" style={{ gap: 12 }}>
                <Button type="button" variant="outline" disabled={saving || atLimit} onClick={() => setDrafts([...drafts, createDraft()])}>{t('timeBand.add')}</Button>
                {atLimit && <p className="text-destructive" style={{ fontSize: 12, lineHeight: '16px' }}>{t('timeBand.error.limit')}</p>}
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-end" style={{ gap: 8 }}>
              {saveError && <p role="alert" className="mr-auto text-destructive" style={{ fontSize: 12, lineHeight: '16px' }}>{saveError}</p>}
              <Button type="button" variant="ghost" className="h-10" style={{ height: 40 }} disabled={saving} onClick={close}>{t('shared.cancel')}</Button>
              <Button type="submit" className="h-10" style={{ height: 40 }} disabled={saving}>{saving ? t('timeBand.saving') : t('timeBand.save')}</Button>
            </div>
          </fieldset>
        </form>}
      </DialogContent>
    </Dialog>
  </>;
}
