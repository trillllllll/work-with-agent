import { useEffect, useMemo, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import { intlLocale, t as translate } from '../../i18n/index.js';
import './memory-extraction-jobs.css';

type Job = {
  id: string; scopeName: string; status: string; attempt: number; requestedModel: string | null; responseModel: string | null; provider: string | null;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; usageStatus: string; reusedFromJobId: string | null;
  createdAt: string; startedAt: string | null; completedAt: string | null; durationMs: number | null; errorCode: string | null; errorMessage: string | null;
};
type JobsPage = { items: Job[]; total: number; nextCursor: number | null; summary: { jobCount: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; missingUsageCount: number }; filters: { models: string[]; providers: string[] } };
const jobStatusKeys = ['queued', 'running', 'proposed', 'completed', 'failed', 'cancelled'] as const;
const usageStatusKeys = ['reported', 'computed', 'partial', 'unavailable', 'legacy', 'not_requested', 'reused'] as const;
export const formatTokens = (value: number | null) => value === null ? translate('knowledge:jobs.unknown') : value.toLocaleString(intlLocale());
const providerName = (host: string | null) => host === 'api.deepseek.com' ? 'DeepSeek · ' + host : host ?? translate('knowledge:jobs.unknown');
const localDate = (date: Date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const initialStart = () => { const date = new Date(); date.setDate(date.getDate() - 6); return localDate(date); };
const jobTime = (job: Job) => new Date(job.createdAt).toLocaleString(intlLocale(), { hour12: false });
const jobDuration = (job: Job) => job.durationMs === null ? '—' : translate('knowledge:jobs.duration', { duration: (job.durationMs / 1000).toFixed(1) });
const jobStatusLabel = (status: string) => (jobStatusKeys as readonly string[]).includes(status) ? translate(`knowledge:jobs.status.${status}`) : status;
const usageLabel = (status: string) => (usageStatusKeys as readonly string[]).includes(status) ? translate(`knowledge:jobs.usage.${status}`) : translate('knowledge:jobs.usage.unknown');
function Model({ job }: { job: Job }) {
  const { t } = useTranslation('knowledge');
  return <><span>{job.requestedModel ?? t('jobs.unknown')}</span>{job.responseModel && job.responseModel !== job.requestedModel && <small>{t('jobs.actualModel', { model: job.responseModel })}</small>}</>;
}
function Tokens({ job }: { job: Job }) {
  const { t } = useTranslation('knowledge');
  if (job.reusedFromJobId) return <span title={t('jobs.originalCall', { id: job.reusedFromJobId })}>{t('jobs.reusedCall')}</span>;
  return <span>{formatTokens(job.inputTokens)} / {formatTokens(job.outputTokens)} / {formatTokens(job.totalTokens)}</span>;
}
function Result({ job }: { job: Job }) {
  useTranslation('knowledge');
  return <><span className={'memory-job-status memory-job-status-' + job.status}>{jobStatusLabel(job.status)}</span><small>{usageLabel(job.usageStatus)}</small>{job.errorMessage && <small className="ctx-error">{job.errorMessage}</small>}</>;
}

export function MemoryExtractionJobs({ topicId }: { topicId: string }) {
  const { t } = useTranslation('knowledge');
  const [from, setFrom] = useState(initialStart);
  const [to, setTo] = useState(() => localDate(new Date()));
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState(0);
  useEffect(() => { setCursor(0); }, [topicId]);
  const invalidRange = Boolean(from && to && from > to);
  const filterQuery = useMemo(() => {
    const params = new URLSearchParams({ topicId: topicId || 'inbox', limit: '20' });
    if (from) params.set('from', new Date(from + 'T00:00:00').toISOString());
    if (to) { const end = new Date(to + 'T00:00:00'); end.setDate(end.getDate() + 1); params.set('to', end.toISOString()); }
    if (model) params.set('model', model);
    if (provider) params.set('provider', provider);
    if (status) params.set('status', status);
    return params.toString();
  }, [topicId, from, to, model, provider, status]);
  const query = useQuery({
    queryKey: ['auto-memory-jobs', filterQuery, cursor],
    queryFn: ({ signal }) => api<JobsPage>('/api/v1/knowledge/auto-memory/jobs?' + filterQuery + '&cursor=' + cursor, { signal }),
    enabled: !invalidRange,
    refetchInterval: () => document.visibilityState === 'visible' ? 15000 : false,
  });
  const change = (set: (value: string) => void, value: string) => { set(value); setCursor(0); };
  const data = query.data;
  return <section className="memory-jobs" aria-label={t('jobs.label')} data-testid="memory-extraction-jobs">
    <div className="memory-jobs-heading">
      <div><h2>{t('jobs.title')}</h2><p className="ctx-muted">{t('jobs.description')}</p></div>
      <Button variant="outline" disabled={query.isFetching || invalidRange} onClick={() => void query.refetch()}>{t('jobs.refresh')}</Button>
    </div>
    <div className="memory-jobs-filters">
      <label>{t('jobs.startDate')}<input type="date" aria-label={t('jobs.startDate')} value={from} onChange={(e) => change(setFrom, e.target.value)} /></label>
      <label>{t('jobs.endDate')}<input type="date" aria-label={t('jobs.endDate')} value={to} onChange={(e) => change(setTo, e.target.value)} /></label>
      <label>{t('jobs.model')}<select aria-label={t('jobs.filterModel')} value={model} onChange={(e) => change(setModel, e.target.value)}><option value="">{t('jobs.allModels')}</option>{Array.from(new Set([...(data?.filters.models ?? []), ...(model ? [model] : [])])).map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>{t('jobs.provider')}<select aria-label={t('jobs.filterProvider')} value={provider} onChange={(e) => change(setProvider, e.target.value)}><option value="">{t('jobs.allProviders')}</option>{Array.from(new Set([...(data?.filters.providers ?? []), ...(provider ? [provider] : [])])).map((value) => <option key={value} value={value}>{providerName(value)}</option>)}</select></label>
      <label>{t('jobs.statusLabel')}<select aria-label={t('jobs.filterStatus')} value={status} onChange={(e) => change(setStatus, e.target.value)}><option value="">{t('jobs.allStatuses')}</option>{jobStatusKeys.map((key) => <option key={key} value={key}>{jobStatusLabel(key)}</option>)}</select></label>
      <Button variant="ghost" onClick={() => { setFrom(''); setTo(''); setModel(''); setProvider(''); setStatus(''); setCursor(0); }}>{t('jobs.allTime')}</Button>
    </div>
    {invalidRange && <p role="alert" className="ctx-error">{t('jobs.invalidRange')}</p>}
    {query.isPending && !invalidRange && <p role="status">{t('jobs.loading')}</p>}
    {query.error && <p role="alert" className="ctx-error"><Trans t={t} i18nKey="jobs.loadFailed" values={{ message: query.error.message }} components={{ retry: <Button variant="outline" onClick={() => void query.refetch()} /> }} /></p>}
    {data && !invalidRange && <>
      <div className="memory-jobs-metrics" aria-label={t('jobs.metricsLabel')}>
        <div><span>{t('jobs.metrics.jobs')}</span><strong>{data.summary.jobCount.toLocaleString(intlLocale())}</strong></div>
        <div><span>{t('jobs.metrics.inputTokens')}</span><strong>{formatTokens(data.summary.inputTokens)}</strong></div>
        <div><span>{t('jobs.metrics.outputTokens')}</span><strong>{formatTokens(data.summary.outputTokens)}</strong></div>
        <div><span>{t('jobs.metrics.totalTokens')}</span><strong>{formatTokens(data.summary.totalTokens)}</strong></div>
      </div>
      <p className="ctx-muted">{t('jobs.summaryNote', { count: data.summary.missingUsageCount })}</p>
      {!data.items.length ? <p className="memory-jobs-empty">{t('jobs.empty')}</p> : <>
        <div className="memory-jobs-table-wrap"><table className="memory-jobs-table">
          <caption className="sr-only">{t('jobs.caption')}</caption>
          <thead><tr><th>{t('jobs.columns.timeList')}</th><th>{t('jobs.columns.modelProvider')}</th><th>{t('jobs.columns.tokens')}</th><th>{t('jobs.columns.statusUsage')}</th><th>{t('jobs.columns.duration')}</th></tr></thead>
          <tbody>{data.items.map((job) => <tr key={job.id}><td><span>{jobTime(job)}</span><small>{job.scopeName}</small></td><td><Model job={job} /><small>{providerName(job.provider)}</small></td><td><Tokens job={job} /></td><td><Result job={job} /></td><td>{jobDuration(job)}</td></tr>)}</tbody>
        </table></div>
        <div className="memory-jobs-cards">{data.items.map((job) => <article key={job.id} className="ctx-card" aria-label={t('jobs.cardLabel', { id: job.id })}>
          <div className="memory-job-card-heading"><strong>{job.scopeName}</strong><span>{jobTime(job)}</span></div>
          <dl><dt>{t('jobs.model')}</dt><dd><Model job={job} /></dd><dt>{t('jobs.provider')}</dt><dd>{providerName(job.provider)}</dd><dt>{t('jobs.tokensLabel')}</dt><dd><Tokens job={job} /></dd><dt>{t('jobs.statusLabel')}</dt><dd><Result job={job} /></dd><dt>{t('jobs.columns.duration')}</dt><dd>{jobDuration(job)}</dd></dl>
        </article>)}</div>
      </>}
      <nav aria-label={t('jobs.pagination')} className="memory-jobs-pagination">
        <span>{t('jobs.pageSummary', { count: data.total, page: Math.floor(cursor / 20) + 1 })}</span>
        <Button variant="outline" disabled={cursor === 0 || query.isFetching} onClick={() => setCursor(Math.max(0, cursor - 20))}>{t('jobs.previous')}</Button>
        <Button variant="outline" disabled={data.nextCursor === null || query.isFetching} onClick={() => setCursor(data.nextCursor ?? cursor)}>{t('jobs.next')}</Button>
      </nav>
    </>}
  </section>;
}
