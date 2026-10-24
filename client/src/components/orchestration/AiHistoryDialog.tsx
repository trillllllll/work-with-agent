import { Surface } from '@/components/ui/surface.js';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { intlLocale } from '@/i18n/index.js';
import { Badge } from '@/components/ui/badge.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { orchestrationStatusLabels, stepKindLabels, stepStatusLabels } from './labels.js';
import { formatCost, formatDiff, formatDuration, formatMissing, formatTokens } from './format.js';

type Commit = { sha: string; subject: string };
type Check = { name: string; passed: boolean };
type Review = { decision: string; comment: string | null };
type HistoryJob = {
  id: string; phase: string; status: string; nodeId: string | null; nodeName: string | null; provider: string | null; cliVersion: string | null; model: string | null;
  startedAt: string | null; endedAt: string | null; durationMs: number | null; cliDurationMs: number | null; runDurationMs: number | null; exitCode: number | null;
  inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; costMicroUsd: number | null;
  filesChanged: number | null; linesAdded: number | null; linesDeleted: number | null; commits: Commit[]; checks: Check[]; error: string | null;
};
type HistoryStep = {
  id: string; kind: string; subtaskId: string | null; subtaskTitle: string | null; status: string; attempt: number; continueCount: number; retryCount: number;
  resultCommit: string | null; mergeCommit: string | null; error: string | null; review: Review | null; checkProblems: string[] | null;
  filesChanged: number | null; linesAdded: number | null; linesDeleted: number | null;
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costMicroUsd: number | null; durationMs: number | null;
  jobs: HistoryJob[];
};
type HistoryRound = {
  id: string; taskId: string; taskTitle: string | null; role: 'main' | 'subtask'; round: number; status: string; pauseReason: string | null; finalComment: string | null;
  acceptanceNote?: string | null; rejectionReason?: string | null; rejectedAt?: string | null;
  startedAt: string | null; endedAt: string | null; provider: string | null; integrationBranch: string | null;
  totals: { durationMs: number | null; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costMicroUsd: number | null; costJobs: number; jobs: number; rework: number; rateRetries: number };
  steps: HistoryStep[];
};
type LegacyRun = { id: string; status: string; provider: string; mode: string; createdAt: string; startedAt: string | null; endedAt: string | null; exitCode: number | null; model: string | null; inputTokens: number | null; outputTokens: number | null; costMicroUsd: number | null; summary: string | null; error: string | null };
type History = { rounds: HistoryRound[]; legacy: Array<{ id: string; status: string; provider: string; mode: string; createdAt: string; runs: LegacyRun[] }> };

function when(value: string | null) {
  if (!value) return formatMissing();
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString(intlLocale()) : formatMissing();
}

function JobLine({ job, kind, review }: { job: HistoryJob; kind: string; review: Review | null }) {
  const { t } = useTranslation('orchestration');
  const phase = job.phase === 'verify' ? t('stepPhase.verify') : (stepKindLabels[kind] ?? kind);
  return <div data-testid="ai-history-job" className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
    <span>{phase}</span>
    <span>{t('history.node', { node: job.nodeName ?? formatMissing(), provider: job.provider ?? formatMissing(), cli: job.cliVersion ?? formatMissing() })}</span>
    <span>{t('history.model', { model: job.model ?? formatMissing() })}</span>
    <span>{t('history.started', { time: when(job.startedAt) })}</span>
    <span>{t('history.duration', { value: formatDuration(job.durationMs) })}</span>
    <span>{t('history.cliDuration', { value: formatDuration(job.cliDurationMs) })}</span>
    <span>{t('history.tokens', { input: formatTokens(job.inputTokens), output: formatTokens(job.outputTokens) })}</span>
    <span>{t('history.cached', { cached: formatTokens(job.cachedInputTokens) })}</span>
    <span>{t('history.cost', { value: formatCost(job.costMicroUsd) })}</span>
    <span>{t('history.exitCode', { code: job.exitCode ?? formatMissing() })}</span>
    <span>{formatDiff(job.filesChanged, job.linesAdded, job.linesDeleted)}</span>
    {job.commits.length > 0 && <span>{t('history.commits')} {job.commits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.subject}`).join(', ')}</span>}
    {job.checks.length > 0 && <span>{job.checks.map((check) => `${check.name} ${check.passed ? t('history.checkPassed') : t('history.checkFailed')}`).join(', ')}</span>}
    {review && <span>{t('history.review', { decision: review.decision, comment: review.comment ?? formatMissing() })}</span>}
    {job.error && <span className="text-destructive">{job.error}</span>}
  </div>;
}

function RoundCard({ round }: { round: HistoryRound }) {
  const { t } = useTranslation('orchestration');
  const totals = round.totals;
  const partial = totals.jobs > 0 && totals.costJobs < totals.jobs;
  return <Surface as="article" tone="subtle" data-testid="ai-history-round" className="space-y-3 rounded-xl border p-4">
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">{t('history.roundTotal', { round: round.round })}</span>
      <Badge variant="secondary">{round.role === 'subtask' ? t('history.roleSubtask') : t('history.roleMain')}</Badge>
      <Badge variant="outline">{orchestrationStatusLabels[round.status] ?? round.status}</Badge>
      {round.taskTitle && <span className="min-w-0 break-words text-sm">{round.taskTitle}</span>}
    </div>
    <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
      <span>{t('history.duration', { value: formatDuration(totals.durationMs) })}</span>
      <span>{t('history.tokens', { input: formatTokens(totals.inputTokens), output: formatTokens(totals.outputTokens) })}</span>
      <span>{t('history.cached', { cached: formatTokens(totals.cachedInputTokens) })}</span>
      <span>{t('history.cost', { value: formatCost(totals.costMicroUsd) })}</span>
      {partial && <span>{t('history.costPartial')}</span>}
      <span>{t('history.rework', { n: totals.rework })}</span>
      {totals.rateRetries > 0 && <span>{t('history.rateRetries', { n: totals.rateRetries })}</span>}
    </p>
    {round.finalComment && <p className="text-sm">{round.finalComment}</p>}
    {(round.rejectionReason || round.acceptanceNote) && <p data-testid="ai-history-verdict" className="text-sm">
      {round.rejectionReason && <span>{t('history.rejection', { reason: round.rejectionReason })}</span>}
      {round.rejectionReason && round.acceptanceNote ? ' ' : null}
      {round.acceptanceNote && <span>{t('history.acceptanceNote', { note: round.acceptanceNote })}</span>}
    </p>}
    <div className="space-y-2">
      {round.steps.map((step) => <section key={step.id} data-testid="ai-history-step" className="space-y-1 rounded-lg border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{stepKindLabels[step.kind] ?? step.kind}</span>
          {step.subtaskTitle && <span className="min-w-0 break-words">{step.subtaskTitle}</span>}
          {step.attempt > 1 && <Badge variant="outline">{t('history.attempt', { n: step.attempt })}</Badge>}
          {step.continueCount > 0 && <Badge variant="outline">{t('history.continued', { n: step.continueCount })}</Badge>}
          <span className="text-xs text-muted-foreground">{stepStatusLabels[step.status] ?? step.status}</span>
        </div>
        {step.jobs.map((job) => <JobLine key={job.id} job={job} kind={step.kind} review={step.review} />)}
        {!!step.checkProblems?.length && <p className="text-xs text-muted-foreground">{t('panel.problems', { problems: step.checkProblems.join(t('panel.problemSep')) })}</p>}
        {step.error && <p className="text-xs text-destructive">{step.error}</p>}
      </section>)}
    </div>
  </Surface>;
}

function LegacyRuns({ rows }: { rows: History['legacy'] }) {
  const { t } = useTranslation('orchestration');
  if (!rows.length) return null;
  return <section className="space-y-2">
    <h3 className="text-sm font-medium">{t('history.legacy')}</h3>
    {rows.map((handoff) => <Surface as="article" tone="subtle" key={handoff.id} className="space-y-2 rounded-xl border p-4">
      <p className="text-sm">{handoff.provider} · {handoff.mode} · {handoff.status}</p>
      {handoff.runs.map((run) => <p key={run.id} className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span>{t('history.legacyRun')}</span>
        <span>{run.status}</span>
        <span>{t('history.started', { time: when(run.startedAt ?? run.createdAt) })}</span>
        <span>{t('history.model', { model: run.model ?? formatMissing() })}</span>
        <span>{t('history.tokens', { input: formatTokens(run.inputTokens), output: formatTokens(run.outputTokens) })}</span>
        <span>{t('history.cost', { value: formatCost(run.costMicroUsd) })}</span>
        <span>{t('history.exitCode', { code: run.exitCode ?? formatMissing() })}</span>
        {run.summary && <span className="w-full whitespace-pre-wrap break-words">{run.summary}</span>}
        {run.error && <span className="text-destructive">{run.error}</span>}
      </p>)}
    </Surface>)}
  </section>;
}

export function AiHistoryDialog({ taskId, open, onOpenChange }: { taskId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('orchestration');
  const history = useQuery<History>({ queryKey: ['ai-history', taskId], queryFn: () => api(`/api/tasks/${taskId}/ai-history`), enabled: open });
  const data = history.data;
  const empty = !!data && !data.rounds.length && !data.legacy.length;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent surface="glass" data-testid="ai-history-dialog" className="max-h-[85dvh] max-w-[min(48rem,calc(100%-2rem))] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('history.title')}</DialogTitle>
        <DialogDescription>{t('history.description')}</DialogDescription>
      </DialogHeader>
      {history.isLoading && <p className="text-sm text-muted-foreground">{t('history.loading')}</p>}
      {history.isError && <p role="alert" className="text-sm text-destructive">{t('history.loadError')}</p>}
      {empty && <p className="text-sm text-muted-foreground">{t('history.empty')}</p>}
      <div className="space-y-3">
        {data?.rounds.map((round) => <RoundCard key={round.id} round={round} />)}
        {data && <LegacyRuns rows={data.legacy} />}
      </div>
    </DialogContent>
  </Dialog>;
}
