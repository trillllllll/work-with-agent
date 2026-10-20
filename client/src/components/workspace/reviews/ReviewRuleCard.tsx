import { useTranslation } from 'react-i18next';
import { CalendarDays, Clock, Ellipsis, Inbox, Pencil, Play, TriangleAlert } from 'lucide-react';
import type { ReviewBatch, ReviewRule, Topic } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { classifyScope, formatInZone } from '@/lib/review-format.js';
import { settingsHash } from '@/components/settings/settings-categories.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
import { Switch } from '@/components/ui/switch.js';
import { browserTimeZone } from './ScheduleFields.js';

const providerKey: Record<ReviewRule['provider'], string> = {
  none: 'reviews.providerNone',
  builtin: 'reviews.providerBuiltin',
  external: 'reviews.providerExternal',
  codex: 'reviews.providerCodex',
  claude: 'reviews.providerClaude',
};

const statusKey: Record<ReviewBatch['status'], string> = {
  ready: 'reviews.statusReady',
  partial: 'reviews.statusPartial',
  failed: 'reviews.statusFailed',
  generating: 'reviews.statusGenerating',
};

const statusClass: Record<ReviewBatch['status'], string> = {
  ready: 'border-success-border bg-success-bg text-success',
  partial: 'border-warning-border bg-warning-bg text-warning',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  generating: 'border-border bg-muted text-foreground',
};

function stamp(iso: string, locale: string, timeZone?: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try { return formatInZone(iso, locale, timeZone); }
  catch { return iso; }
}

type ReviewRuleCardProps = {
  rule: ReviewRule;
  topics: Topic[];
  archivedTopics: Topic[];
  archivedLoaded: boolean;
  latest?: ReviewBatch;
  running: boolean;
  modelMissing: boolean;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onEdit: (step: 1 | 2) => void;
  onDuplicate: () => void;
  onFilter: () => void;
  onDelete: () => void;
  onRetry: (batch: ReviewBatch) => void;
  onView: (batch: ReviewBatch) => void;
};

export function ReviewRuleCard({ rule, topics, archivedTopics, archivedLoaded, latest, running, modelMissing, onToggle, onRun, onEdit, onDuplicate, onFilter, onDelete, onRetry, onView }: ReviewRuleCardProps) {
  const { t } = useTranslation('workspace');
  const locale = intlLocale();
  const scope = classifyScope(rule.topicIds, topics, archivedTopics, archivedLoaded);
  const schedule = rule.frequency === 'weekly'
    ? t('reviews.scheduleWeekly', { day: t(`reviews.weekdayShort.${rule.weekDay}`), time: rule.timeOfDay })
    : t('reviews.scheduleDaily', { time: rule.timeOfDay });
  const zone = rule.timeZone === browserTimeZone() ? '' : ` · ${rule.timeZone}`;
  const next = rule.enabled && rule.nextRunAt ? t('reviews.nextRun', { time: stamp(rule.nextRunAt, locale, rule.timeZone) }) : t('reviews.notScheduled');
  const chip = 'inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs';
  const showModel = rule.provider === 'builtin' && modelMissing;
  return (
    <article className="glass-subtle space-y-3 rounded-xl p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          {rule.frequency === 'daily' ? <Clock className="size-4" /> : <CalendarDays className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold break-words">{rule.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{schedule}{zone} · {next}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">{rule.enabled ? t('reviews.enabled') : t('reviews.paused')}</span>
          <Switch checked={rule.enabled} aria-label={t('reviews.enableAria', { name: rule.name })} onCheckedChange={onToggle} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t('reviews.more')} disabled={running}><Ellipsis /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onEdit(1)}>{t('reviews.edit')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={onDuplicate}>{t('reviews.duplicate')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={onFilter}>{t('reviews.filterThisRule')}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>{t('reviews.delete')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <dl className="space-y-2 text-sm">
        <div className="grid gap-1 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-start sm:gap-3">
          <dt className="text-muted-foreground">{t('reviews.scopeLabel')}</dt>
          <dd className="flex min-w-0 flex-wrap gap-1">
            {rule.includeInbox && <span className={chip}><Inbox aria-hidden="true" className="size-3 shrink-0" />{t('inbox')}</span>}
            {scope.active.map((topic) => (
              <span key={topic.id} className={chip}>
                <span className="sidebar-list-mark" data-color={topic.color || 'slate'} aria-hidden="true" />
                <span className="truncate">{topic.name}</span>
              </span>
            ))}
            {scope.archived.map((topic) => (
              <span key={topic.id} className={chip}>
                <span className="sidebar-list-mark" data-color={topic.color || 'slate'} aria-hidden="true" />
                <span className="truncate">{topic.name}</span>
                <Badge variant="outline">{t('reviews.archivedList')}</Badge>
              </span>
            ))}
            {scope.missingIds.map((id) => <span key={id} className="inline-flex max-w-full items-center rounded-md border border-warning-border bg-warning-bg px-1.5 py-0.5 text-xs text-warning line-through">{t('reviews.missingList')}</span>)}
          </dd>
        </div>
        <div className="grid gap-1 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-muted-foreground">{t('reviews.providerLabel')}</dt>
          <dd className="min-w-0 break-words">{t(providerKey[rule.provider])}</dd>
        </div>
        <div className="grid gap-1 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-start sm:gap-3">
          <dt className="text-muted-foreground">{t('reviews.lastLabel')}</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-2">
            {latest ? (
              <>
                <Badge variant="outline" className={statusClass[latest.status]}>{t(statusKey[latest.status])}</Badge>
                <span className="text-xs text-muted-foreground">{stamp(latest.createdAt, locale)}</span>
                {latest.counts && <span className="text-xs">{t('reviews.countsSummary', { added: latest.counts.added, completed: latest.counts.completed, overdue: latest.counts.overdue })}</span>}
                <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => onView(latest)}>{t('reviews.viewReport')}</Button>
                {latest.pendingProposalCount > 0 && <a className="text-xs underline underline-offset-4" href="#/proposals">{t('reviews.goConfirm', { count: latest.pendingProposalCount })}</a>}
              </>
            ) : <span className="text-muted-foreground">{t('reviews.neverRun')}</span>}
          </dd>
        </div>
      </dl>
      {showModel && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
          <span>{t('reviews.modelMissingOnCard')}</span>
          <a className="font-medium underline underline-offset-4" href={`#${settingsHash('model')}`}>{t('reviews.modelMissingAction')}</a>
        </div>
      )}
      {latest?.status === 'failed' && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="min-w-0 break-words">{latest.error || t('reviews.lastFailedTitle')}</span>
          <span className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={running} onClick={() => onRetry(latest)}>{t('reviews.retry')}</Button>
            {scope.missingIds.length > 0 && <Button type="button" size="sm" variant="outline" disabled={running} onClick={() => onEdit(1)}>{t('reviews.editScope')}</Button>}
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={running} onClick={onRun}>
          {running ? t('reviews.running') : <><Play aria-hidden="true" />{t('reviews.runNow')}</>}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={running} onClick={() => onEdit(1)}>
          <Pencil aria-hidden="true" />{t('reviews.edit')}
        </Button>
      </div>
    </article>
  );
}
