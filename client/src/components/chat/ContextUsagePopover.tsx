import { useTranslation } from 'react-i18next';
import { ChevronDown, Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { settingsHash } from '@/components/settings/settings-categories.js';
import { compactTokens, tokenPercent, usageLevel, windowPercent, type ContextUsage } from '@/lib/context-usage.js';
import { cn } from '@/lib/utils.js';

const colors = { messages: '#3478df', tools: '#e07743', system: '#10a37f', skills: '#d49b16', manual: '#b279cc', work: '#d76b96', summary: '#597c45' };
const levelText = { normal: 'text-muted-foreground', high: 'text-warning', full: 'text-destructive' } as const;

/**
 * `stats` is the latest recorded request of the current run; `preview` is the
 * pre-send estimate of the next request. While a run is busy the live stats win;
 * when idle the preview is shown so the user sees usage before sending.
 */
export function ContextUsagePopover({ stats, preview, busy }: { stats: ContextUsage | null; preview?: ContextUsage | null; busy?: boolean }) {
  const { t } = useTranslation('chat');
  const number = (value: number | null | undefined) => typeof value === 'number' ? value.toLocaleString() : t('usage.unknown');
  const shown = busy ? stats : preview ?? stats;
  const isPreview = shown?.kind === 'preview';
  const capacity = shown?.contextWindow ?? null;
  const percent = shown ? windowPercent(shown) : null;
  const level = usageLevel(percent);
  // With a known window the bar is a share of capacity (free space stays empty); otherwise a share of the estimate.
  const scale = shown ? Math.max(capacity ?? 0, shown.estimatedInputTokens) : 0;
  const share = (tokens: number) => tokenPercent(tokens, capacity ?? shown?.estimatedInputTokens ?? 0);
  const badge = shown ? `≈${compactTokens(shown.estimatedInputTokens)}${capacity ? ` / ${compactTokens(capacity)}` : ''}` : t('usage.shortTitle');
  const totals = busy ? stats : stats?.kind === 'preview' ? null : stats;
  return <Popover>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" className={cn('h-7 gap-1 px-1.5 text-[11px]', levelText[level])} aria-label={t('usage.open')} title={percent === null ? t('usage.open') : t('usage.badgeTitle', { percent: percent.toFixed(1) })} data-testid="context-usage-trigger" data-level={level}>
      <Gauge className="size-3.5" /><span className="tabular-nums">{badge}</span>
    </Button></PopoverTrigger>
    <PopoverContent data-assistant-floating side="top" align="end" collisionPadding={16} onEscapeKeyDown={event => event.stopPropagation()} className="max-h-[min(620px,var(--radix-popover-content-available-height))] w-[380px] max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain p-4" data-testid="context-usage-popover" aria-label={t('usage.title')}>
      <div className="mb-1 flex items-center justify-between gap-3"><h3 className="text-sm font-medium">{t('usage.title')}</h3><span className={cn('text-sm tabular-nums', levelText[level])} data-testid="context-usage-total">{shown ? `≈ ${number(shown.estimatedInputTokens)}${capacity ? ` / ${number(capacity)}` : ''}` : '—'}</span></div>
      {!shown ? <p className="py-3 text-xs leading-relaxed text-muted-foreground">{t('usage.empty')}</p> : <>
        <p className="mb-3 text-[11px] text-muted-foreground">{isPreview ? t('usage.preview') : t('usage.latest', { round: shown.round + 1 })}{percent !== null && <> · <span className={levelText[level]}>{t('usage.ofWindow', { percent: percent.toFixed(1) })}</span></>}</p>
        <div className="mb-3 flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={capacity ? t('usage.compositionWindow') : t('usage.composition')}>
          {shown.categories.filter(c => c.tokens > 0).map(c => <span key={c.id} style={{ width: `${Number(tokenPercent(c.tokens, scale))}%`, background: colors[c.id] }} title={`${t(`usage.categories.${c.id}`)}: ${number(c.tokens)} token`} />)}
        </div>
        <div className="space-y-1.5 text-xs">
          {shown.categories.filter(c => c.tokens > 0).map(c => <div key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto_48px] items-center gap-3">
            <span className="flex min-w-0 items-center gap-2"><span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colors[c.id] }} /><span className="truncate">{t(`usage.categories.${c.id}`)}</span></span>
            <span className="tabular-nums text-muted-foreground">≈ {number(c.tokens)}</span><span className="text-right tabular-nums">{share(c.tokens)}%</span>
          </div>)}
          {capacity && <div className="grid grid-cols-[minmax(0,1fr)_auto_48px] items-center gap-3" data-testid="context-usage-free">
            <span className="flex min-w-0 items-center gap-2"><span className="size-2.5 shrink-0 rounded-[3px] bg-muted ring-1 ring-border" /><span className="truncate">{t('usage.free')}</span></span>
            <span className="tabular-nums text-muted-foreground">≈ {number(Math.max(0, capacity - shown.estimatedInputTokens))}</span><span className="text-right tabular-nums">{share(Math.max(0, capacity - shown.estimatedInputTokens))}%</span>
          </div>}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{capacity ? t('usage.estimateHintWindow') : <>{t('usage.estimateHint')} <a className="font-medium text-brand-link underline-offset-4 hover:underline" href={`#${settingsHash('model')}`}>{t('usage.setWindow')}</a></>}</p>
        {isPreview && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t('usage.previewHint')}</p>}
        {level !== 'normal' && <p className={cn('mt-2 text-xs', levelText[level])}>{level === 'full' ? t('usage.windowFull') : t('usage.windowHigh')}</p>}
        {shown.historyOverBudget && <p className="mt-2 text-xs text-warning">{t('usage.overBudget')}</p>}
        <Disclosure className="mt-3 border-t pt-2">
          <DisclosureTrigger className="flex items-center gap-1 py-1 text-xs"><ChevronDown className="size-3.5" />{t('usage.toolDetails', { count: shown.tools.length })}</DisclosureTrigger>
          <div className="mt-2 max-h-36 space-y-1 overflow-y-auto pr-1 text-[11px]">
            {[...shown.tools].sort((a, b) => b.tokens - a.tokens).map(tool => <div className="flex items-start justify-between gap-3" key={tool.name}><span className="min-w-0 break-all font-mono">{tool.name}</span><span className="shrink-0 tabular-nums text-muted-foreground">≈ {number(tool.tokens)}</span></div>)}
          </div>
        </Disclosure>
        {totals && <div className="mt-3 border-t pt-3 text-xs">
          <p className="mb-2 font-medium">{isPreview ? t('usage.lastRunTotals', { count: totals.totals.requests }) : t('usage.runTotals', { count: totals.totals.requests })}</p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-muted-foreground">
            {isPreview && <><dt>{t('usage.lastRequest', { round: totals.round + 1 })}</dt><dd className="text-right tabular-nums">≈ {number(totals.estimatedInputTokens)}</dd></>}
            <dt>{t('usage.actualInput')}</dt><dd className="text-right tabular-nums">{number(totals.totals.actualInputTokens)}</dd>
            <dt>{t('usage.actualOutput')}</dt><dd className="text-right tabular-nums">{number(totals.totals.actualOutputTokens)}</dd>
            <dt>{t('usage.cached')}</dt><dd className="text-right tabular-nums">{number(totals.totals.cachedInputTokens)}</dd>
            <dt>{t('usage.estimatedTotal')}</dt><dd className="text-right tabular-nums">≈ {number(totals.totals.estimatedInputTokens)}</dd>
            <dt>{t('usage.summaries')}</dt><dd className="text-right tabular-nums">{totals.summaryCalls.length}</dd>
          </dl>
          {!totals.totals.usageComplete && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t('usage.partial')}</p>}
        </div>}
      </>}
    </PopoverContent>
  </Popover>;
}
