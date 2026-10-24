import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewRule, Topic } from '@/lib/api.js';
import { classifyScope } from '@/lib/review-format.js';
import { topicIdsForSave } from '@/lib/scope-selection.js';
import { cn } from '@/lib/utils.js';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { Input } from '@/components/ui/input.js';
import { Switch } from '@/components/ui/switch.js';
import { ScopePicker, type ScopePickerLabels } from '@/components/shared/ScopePicker.js';
import { browserTimeZone, normalizeTime, ScheduleFields, type ReviewSchedule } from './ScheduleFields.js';
import { ProviderCards, useBuiltinModelState } from './ProviderCards.js';
import type { ReviewDraftSeed } from './ReviewEmpty.js';

const dialogClass = 'flex max-h-[85dvh] min-h-0 w-full max-w-[min(40rem,calc(100%-3rem))] flex-col gap-0 overflow-hidden p-0 max-lg:inset-0! max-lg:top-0! max-lg:left-0! max-lg:h-dvh! max-lg:max-h-none! max-lg:w-full! max-lg:max-w-none! max-lg:translate-x-0! max-lg:translate-y-0! max-lg:rounded-none!';

export type ReviewRuleDraft = ReviewDraftSeed & {
  timeZone: string;
  enabled: boolean;
  /** Create saved as paused because the built-in model is not configured. */
  pausedForModel: boolean;
};

type ReviewRuleDialogProps = {
  mode: 'create' | 'edit';
  rule?: ReviewRule;
  seed?: ReviewDraftSeed;
  initialStep?: 1 | 2;
  topics: Topic[];
  archivedTopics: Topic[];
  archivedLoaded: boolean;
  onClose: () => void;
  onSubmit: (draft: ReviewRuleDraft) => Promise<void>;
};

function scopeLabels(t: (key: string, options?: Record<string, unknown>) => string): ScopePickerLabels {
  return {
    legend: t('reviews.scope'),
    count: (selected, total) => t('reviews.scopeCount', { selected, total }),
    missingCount: (count) => t('reviews.scopeMissingCount', { count }),
    selectAll: t('reviews.selectAll'),
    clear: t('reviews.clear'),
    searchAria: t('reviews.searchAria'),
    searchPlaceholder: (count) => t('reviews.searchLists', { count }),
    inboxAria: t('reviews.inboxAria'),
    inboxHint: t('reviews.inboxHint'),
    itemAria: (name) => t('reviews.listAria', { name }),
    missingName: () => t('reviews.missingList'),
    missingRow: (name) => t('reviews.missingRow', { name }),
    archivedBadge: t('reviews.archivedList'),
    filterAll: t('reviews.filterAll'),
    filterSelected: (count) => t('reviews.filterSelected', { count }),
    footer: t('reviews.scopeFooter'),
  };
}

export function ReviewRuleDialog({ mode, rule, seed, initialStep = 1, topics, archivedTopics, archivedLoaded, onClose, onSubmit }: ReviewRuleDialogProps) {
  const { t } = useTranslation('workspace');
  const editing = mode === 'edit';
  const source = editing ? rule : undefined;
  const [step, setStep] = useState<1 | 2>(initialStep === 2 ? 2 : 1);
  const [name, setName] = useState(source?.name ?? seed?.name ?? '');
  const [includeInbox, setIncludeInbox] = useState(source?.includeInbox ?? seed?.includeInbox ?? true);
  const [topicIds, setTopicIds] = useState<string[]>(source?.topicIds ?? seed?.topicIds ?? []);
  const [provider, setProvider] = useState<ReviewRule['provider']>(source?.provider ?? seed?.provider ?? 'none');
  const [enableOnSave, setEnableOnSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [schedule, setSchedule] = useState<ReviewSchedule>({
    frequency: source?.frequency ?? seed?.frequency ?? 'daily',
    weekDay: source?.weekDay ?? seed?.weekDay ?? 0,
    timeOfDay: source?.timeOfDay ?? seed?.timeOfDay ?? '21:00',
    timeZone: source?.timeZone ?? seed?.timeZone ?? browserTimeZone(),
  });
  const { missing: modelMissing } = useBuiltinModelState();
  const missingIds = classifyScope(topicIds, topics, archivedTopics, archivedLoaded).missingIds;
  const blocked = missingIds.length > 0;
  const savedTopicIds = topicIdsForSave(topicIds, missingIds);
  const nameReady = name.trim().length > 0;
  const scopeReady = includeInbox || savedTopicIds.length > 0;
  const timeReady = /^([01]\d|2[0-3]):[0-5]\d$/.test(normalizeTime(schedule.timeOfDay));
  const zoneReady = schedule.timeZone.trim().length > 0;
  const step1Valid = nameReady && scopeReady && timeReady && zoneReady && !blocked;
  const forcePause = !editing && provider === 'builtin' && modelMissing;
  const stepTitle = step === 1 ? t('reviews.stepWhatWhen') : t('reviews.stepHow');
  const hint = blocked
    ? t('reviews.missingBlocked', { count: missingIds.length })
    : !nameReady
      ? t('reviews.hintName')
      : !scopeReady
        ? t('reviews.hintScope')
        : !timeReady || !zoneReady
          ? t('reviews.hintSchedule')
          : editing
            ? t('reviews.editAppliesNext')
            : step === 2 && forcePause
              ? t('reviews.enableNeedsModel')
              : step === 1
                ? t('reviews.hintReady')
                : t('reviews.hintSave');
  const goTo = (next: 1 | 2) => {
    if (next === 2 && !editing && !step1Valid) return;
    setStep(next);
  };
  const save = async () => {
    if (busy || !step1Valid || step !== 2) return;
    setBusy(true);
    const draft: ReviewRuleDraft = {
      name: name.trim(),
      frequency: schedule.frequency,
      timeOfDay: normalizeTime(schedule.timeOfDay),
      timeZone: schedule.timeZone.trim(),
      weekDay: schedule.weekDay,
      topicIds: savedTopicIds,
      includeInbox,
      provider,
      enabled: forcePause ? false : enableOnSave,
      pausedForModel: forcePause,
    };
    try { await onSubmit(draft); }
    finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Advancing replaces this button with Save. A submit that follows that swap must not save.
    if (step === 1 && step1Valid) setStep(2);
  };
  const labels = scopeLabels(t);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent surface="glass" className={dialogClass}>
        <DialogHeader className="shrink-0 border-b glass-divider px-5 py-4 text-left">
          <DialogTitle>{editing ? t('reviews.editRule') : t('reviews.newRule')}</DialogTitle>
          <DialogDescription>{t('reviews.stepProgress', { step, title: stepTitle })}</DialogDescription>
          <div className="flex gap-2" role="group" aria-label={t('reviews.stepsAria')}>
            {([1, 2] as const).map((index) => {
              const title = index === 1 ? t('reviews.stepWhatWhen') : t('reviews.stepHow');
              const allowed = editing || index === 1 || step1Valid;
              return (
                <Button variant="plain" size="bare" key={index} type="button" className="flex min-h-8 min-w-0 flex-1 items-center" disabled={!allowed} aria-current={step === index ? 'step' : undefined} aria-label={t('reviews.stepProgress', { step: index, title })} onClick={() => goTo(index)}>
                  <span className={cn('h-1.5 w-full rounded-full', step === index ? 'bg-foreground' : 'bg-foreground/20', !allowed && 'opacity-40')} />
                </Button>
              );
            })}
          </div>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {step === 1 ? (
              <>
                <label className="block text-sm">
                  {t('reviews.nameAria')}
                  <Input className="mt-2" aria-label={t('reviews.nameAria')} placeholder={t('reviews.namePlaceholder')} required value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                <ScopePicker
                  topics={topics}
                  archivedTopics={archivedTopics}
                  missingIds={missingIds}
                  includeInbox={includeInbox}
                  topicIds={topicIds}
                  pinSelected={editing}
                  labels={labels}
                  exploringLabel={t('settings:topicList.exploring')}
                  onChange={(next) => { setIncludeInbox(next.includeInbox); setTopicIds(next.topicIds); }}
                />
                <ScheduleFields value={schedule} onChange={(patch) => setSchedule((current) => ({ ...current, ...patch }))} />
              </>
            ) : (
              <ProviderCards value={provider} onChange={setProvider} />
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t glass-divider px-5 py-4">
            <div className="min-w-0 space-y-2">
              {step === 2 && !editing && (
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={forcePause ? false : enableOnSave} disabled={forcePause} aria-label={t('reviews.enableOnSave')} onCheckedChange={setEnableOnSave} />
                  <span>{t('reviews.enableOnSave')}</span>
                </label>
              )}
              <p aria-live="polite" className={blocked || (step === 2 && forcePause) ? 'text-xs text-warning' : 'text-xs text-muted-foreground'}>{hint}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {step === 2 && <Button type="button" variant="ghost" disabled={busy} onClick={() => setStep(1)}>{t('reviews.back')}</Button>}
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t('reviews.cancel')}</Button>
              {step === 1
                ? <Button type="button" disabled={!step1Valid} onClick={() => setStep(2)}>{t('reviews.next')}</Button>
                : <Button type="button" disabled={busy || !step1Valid} onClick={() => { void save(); }}>{busy ? t('reviews.saving') : t('reviews.save')}</Button>}
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
