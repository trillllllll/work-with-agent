import { useTranslation } from 'react-i18next';
import { ChevronDown, Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { compactTokens, tokenPercent, type ContextUsage } from '@/lib/context-usage.js';

const colors = { messages: '#3478df', tools: '#e07743', system: '#10a37f', skills: '#d49b16', manual: '#b279cc', work: '#d76b96', summary: '#597c45' };

export function ContextUsagePopover({ stats }: { stats: ContextUsage | null }) {
  const { t } = useTranslation('chat');
  const number = (value: number | null | undefined) => typeof value === 'number' ? value.toLocaleString() : t('usage.unknown');
  return <Popover>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-1.5 text-[11px] text-muted-foreground" aria-label={t('usage.open')} title={t('usage.open')} data-testid="context-usage-trigger">
      <Gauge className="size-3.5" /><span>{stats ? `≈${compactTokens(stats.estimatedInputTokens)}` : t('usage.shortTitle')}</span>
    </Button></PopoverTrigger>
    <PopoverContent data-assistant-floating side="top" align="end" collisionPadding={16} onEscapeKeyDown={event => event.stopPropagation()} className="max-h-[min(620px,var(--radix-popover-content-available-height))] w-[380px] max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain p-4" data-testid="context-usage-popover" aria-label={t('usage.title')}>
      <div className="mb-1 flex items-center justify-between gap-3"><h3 className="text-sm font-medium">{t('usage.title')}</h3><span className="text-sm tabular-nums text-muted-foreground">{stats ? `≈ ${number(stats.estimatedInputTokens)}` : '—'}</span></div>
      {!stats ? <p className="py-3 text-xs leading-relaxed text-muted-foreground">{t('usage.empty')}</p> : <>
        <p className="mb-3 text-[11px] text-muted-foreground">{t('usage.latest', { round: stats.round + 1 })}</p>
        <div className="mb-3 flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={t('usage.composition')}>
          {stats.categories.filter(c => c.tokens > 0).map(c => <span key={c.id} style={{ width: `${Number(tokenPercent(c.tokens, stats.estimatedInputTokens))}%`, background: colors[c.id] }} title={`${t(`usage.categories.${c.id}`)}: ${number(c.tokens)} token`} />)}
        </div>
        <div className="space-y-1.5 text-xs">
          {stats.categories.filter(c => c.tokens > 0).map(c => <div key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto_48px] items-center gap-3">
            <span className="flex min-w-0 items-center gap-2"><span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colors[c.id] }} /><span className="truncate">{t(`usage.categories.${c.id}`)}</span></span>
            <span className="tabular-nums text-muted-foreground">≈ {number(c.tokens)}</span><span className="text-right tabular-nums">{tokenPercent(c.tokens, stats.estimatedInputTokens)}%</span>
          </div>)}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{t('usage.estimateHint')}</p>
        {stats.historyOverBudget && <p className="mt-2 text-xs text-warning">{t('usage.overBudget')}</p>}
        <Disclosure className="mt-3 border-t pt-2">
          <DisclosureTrigger className="flex items-center gap-1 py-1 text-xs"><ChevronDown className="size-3.5" />{t('usage.toolDetails', { count: stats.tools.length })}</DisclosureTrigger>
          <div className="mt-2 max-h-36 space-y-1 overflow-y-auto pr-1 text-[11px]">
            {[...stats.tools].sort((a, b) => b.tokens - a.tokens).map(tool => <div className="flex items-start justify-between gap-3" key={tool.name}><span className="min-w-0 break-all font-mono">{tool.name}</span><span className="shrink-0 tabular-nums text-muted-foreground">≈ {number(tool.tokens)}</span></div>)}
          </div>
        </Disclosure>
        <div className="mt-3 border-t pt-3 text-xs">
          <p className="mb-2 font-medium">{t('usage.runTotals', { count: stats.totals.requests })}</p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-muted-foreground">
            <dt>{t('usage.actualInput')}</dt><dd className="text-right tabular-nums">{number(stats.totals.actualInputTokens)}</dd>
            <dt>{t('usage.actualOutput')}</dt><dd className="text-right tabular-nums">{number(stats.totals.actualOutputTokens)}</dd>
            <dt>{t('usage.cached')}</dt><dd className="text-right tabular-nums">{number(stats.totals.cachedInputTokens)}</dd>
            <dt>{t('usage.estimatedTotal')}</dt><dd className="text-right tabular-nums">≈ {number(stats.totals.estimatedInputTokens)}</dd>
            <dt>{t('usage.summaries')}</dt><dd className="text-right tabular-nums">{stats.summaryCalls.length}</dd>
          </dl>
          {!stats.totals.usageComplete && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t('usage.partial')}</p>}
        </div>
      </>}
    </PopoverContent>
  </Popover>;
}
