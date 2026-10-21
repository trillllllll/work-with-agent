import { useTranslation } from 'react-i18next';
import type { ReviewRule } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';

export type ReviewDraftSeed = {
  name: string;
  frequency: ReviewRule['frequency'];
  timeOfDay: string;
  weekDay: number;
  includeInbox: boolean;
  topicIds: string[];
  provider: ReviewRule['provider'];
  timeZone?: string;
};

type ReviewEmptyProps = {
  onTemplate: (seed: ReviewDraftSeed) => void;
};

export function ReviewEmpty({ onTemplate }: ReviewEmptyProps) {
  const { t } = useTranslation('workspace');
  const steps = [
    { title: t('reviews.emptyStep1'), hint: t('reviews.emptyStep1Hint') },
    { title: t('reviews.emptyStep2'), hint: t('reviews.emptyStep2Hint') },
    { title: t('reviews.emptyStep3'), hint: t('reviews.emptyStep3Hint') },
  ];
  return (
    <div className="glass-subtle rounded-xl px-5 py-8 text-center">
      <h2 className="text-lg font-semibold">{t('reviews.emptyTitle')}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{t('reviews.emptyDescription')}</p>
      <ol className="mt-6 grid gap-3 text-left sm:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="rounded-xl border border-border bg-muted/40 px-3 py-3">
            <p className="text-xs text-muted-foreground">{index + 1}</p>
            <p className="mt-1 text-sm font-medium">{step.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{step.hint}</p>
          </li>
        ))}
      </ol>
      <div className="mt-6 grid gap-2 text-left sm:grid-cols-2">
        <Button type="button" variant="outline" className="h-auto whitespace-normal flex-col items-start px-3 py-3" onClick={() => onTemplate({ name: t('reviews.templateDaily'), frequency: 'daily', timeOfDay: '21:00', weekDay: 0, includeInbox: true, topicIds: [], provider: 'none' })}>
          <span className="text-sm font-medium">{t('reviews.templateDaily')}</span>
          <span className="mt-1 text-xs font-normal text-muted-foreground">{t('reviews.templateDailyHint')}</span>
        </Button>
        <Button type="button" variant="outline" className="h-auto whitespace-normal flex-col items-start px-3 py-3" onClick={() => onTemplate({ name: t('reviews.templateWeekly'), frequency: 'weekly', timeOfDay: '18:00', weekDay: 5, includeInbox: false, topicIds: [], provider: 'none' })}>
          <span className="text-sm font-medium">{t('reviews.templateWeekly')}</span>
          <span className="mt-1 text-xs font-normal text-muted-foreground">{t('reviews.templateWeeklyHint')}</span>
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t('reviews.templateHint')}</p>
    </div>
  );
}
