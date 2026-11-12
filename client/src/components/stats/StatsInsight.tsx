import { ArrowUpRight, ChevronDown, RefreshCw, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, type StatsInsightNote, type StatsInsightResponse } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { shortMonthDay } from '@/lib/stats-range.js';
import { cn } from '@/lib/utils.js';
import { Button } from '@/components/ui/button.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { Surface } from '@/components/ui/surface.js';

const toneColor: Record<StatsInsightNote['tone'], string> = { warn: 'var(--warning)', info: 'var(--primary)', idea: 'var(--success)' };

function Note({ note }: { note: StatsInsightNote }) {
  return (
    <li className="flex gap-2 text-sm leading-relaxed">
      <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full" style={{ background: toneColor[note.tone] }} />
      <span>{note.label && <b className="font-medium">{note.label}</b>}{note.label ? ' · ' : ''}{note.text}</span>
    </li>
  );
}

/**
 * Option-A banner: one collapsed headline line, opinions and actions behind it.
 * Quiet ranges (<3 recorded days) stay bannerless; the sparse line already says why.
 */
export function StatsInsight({ from, to, tz, rangeDays, recordedDays }: { from: string; to: string; tz: string; rangeDays: number; recordedDays: number }) {
  const { t } = useTranslation('stats');
  const [open, setOpen] = useState(false);
  const refreshRef = useRef(false);
  const enough = recordedDays >= 3;
  const query = useQuery({
    queryKey: ['stats-insight', from, to, tz],
    enabled: enough,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: () => {
      const refresh = refreshRef.current;
      refreshRef.current = false;
      return api<StatsInsightResponse>(`/api/stats/insight?${new URLSearchParams({ from, to, tz })}${refresh ? '&refresh=1' : ''}`);
    },
  });
  if (!enough || query.isError || query.data?.reason === 'no-model') return null;

  const insight = query.data?.insight ?? null;
  const failed = query.data?.reason === 'failed';
  const analyzing = query.isFetching;
  const analyzedAt = query.data?.generatedAt
    ? new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(query.data.generatedAt))
    : '';
  const span = t('range.span', { from: shortMonthDay(from), to: shortMonthDay(to) });

  const reanalyze = () => { refreshRef.current = true; void query.refetch(); };
  const ask = () => {
    if (!insight) return;
    const note = insight.notes[0];
    const prompt = note
      ? t('insight.askPrompt', { headline: insight.headline, note: note.text })
      : t('insight.askPromptPlain', { headline: insight.headline });
    window.dispatchEvent(new CustomEvent('dovun-open-assistant', { detail: { prompt } }));
  };

  return (
    <Surface tone="subtle" className="rounded-xl border" data-testid="stats-insight">
      {insight && !analyzing ? (
        <>
          <Button type="button" variant="row" size="bare" data-testid="stats-insight-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="w-full flex-nowrap items-center gap-2.5 p-4 text-left">
            <Sparkles className="size-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 text-sm leading-relaxed">{insight.headline}</span>
            <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />
          </Button>
          {open && (
            <div className="space-y-3 px-4 pb-3.5 pt-1 sm:pl-[42px]">
              {insight.notes.length > 0 && <ul className="space-y-2">{insight.notes.map((note, index) => <Note key={index} note={note} />)}</ul>}
              <div className="flex flex-wrap items-center gap-1.5">
                <Button type="button" variant="ghost" size="xs" onClick={reanalyze}><RefreshCw />{t('insight.reanalyze')}</Button>
                <Button type="button" variant="ghost" size="xs" onClick={ask}><ArrowUpRight />{t('insight.ask')}</Button>
                {analyzedAt && <span className="ml-auto text-xs text-muted-foreground">{t('insight.meta', { time: analyzedAt, span })}</span>}
              </div>
            </div>
          )}
        </>
      ) : failed && !analyzing ? (
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-destructive">{t('insight.error')}</p>
          <Button type="button" variant="outline" size="sm" onClick={reanalyze}>{t('retry')}</Button>
        </div>
      ) : analyzing ? (
        <div className="flex items-center gap-2.5 p-4">
          <Sparkles className="size-4 shrink-0 animate-pulse text-primary" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="text-sm text-muted-foreground">{t('insight.analyzing', { days: rangeDays })}</p>
            <Skeleton className="h-3.5 w-3/5" />
          </div>
        </div>
      ) : null}
    </Surface>
  );
}
