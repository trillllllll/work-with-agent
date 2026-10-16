import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api.js';
import { Button } from '@/components/ui/button.js';
import './memory-extraction-jobs.css';

type Job = {
  id: string; scopeName: string; status: string; attempt: number; requestedModel: string | null; responseModel: string | null; provider: string | null;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; usageStatus: string; reusedFromJobId: string | null;
  createdAt: string; startedAt: string | null; completedAt: string | null; durationMs: number | null; errorCode: string | null; errorMessage: string | null;
};
type JobsPage = { items: Job[]; total: number; nextCursor: number | null; summary: { jobCount: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; missingUsageCount: number }; filters: { models: string[]; providers: string[] } };
const statusNames: Record<string, string> = { queued: '等待执行', running: '提取中', proposed: '待确认建议', completed: '已完成', failed: '失败', cancelled: '已取消' };
const usageNames: Record<string, string> = { reported: '接口返回', computed: '总数由输入与输出相加', partial: '用量不完整', unavailable: '接口未返回用量', legacy: '历史用量未知', not_requested: '尚未调用模型', reused: '复用原输出，未重新调用' };
export const formatTokens = (value: number | null) => value === null ? '未知' : value.toLocaleString('zh-CN');
const providerName = (host: string | null) => host === 'api.deepseek.com' ? 'DeepSeek · ' + host : host ?? '未知';
const localDate = (date: Date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const initialStart = () => { const date = new Date(); date.setDate(date.getDate() - 6); return localDate(date); };
const jobTime = (job: Job) => new Date(job.createdAt).toLocaleString('zh-CN', { hour12: false });
const jobDuration = (job: Job) => job.durationMs === null ? '—' : (job.durationMs / 1000).toFixed(1) + ' 秒';
function Model({ job }: { job: Job }) {
  return <><span>{job.requestedModel ?? '未知'}</span>{job.responseModel && job.responseModel !== job.requestedModel && <small>实际：{job.responseModel}</small>}</>;
}
function Tokens({ job }: { job: Job }) {
  if (job.reusedFromJobId) return <span title={'原调用 ' + job.reusedFromJobId}>复用原调用</span>;
  return <span>{formatTokens(job.inputTokens)} / {formatTokens(job.outputTokens)} / {formatTokens(job.totalTokens)}</span>;
}
function Result({ job }: { job: Job }) {
  return <><span className={'memory-job-status memory-job-status-' + job.status}>{statusNames[job.status] ?? job.status}</span><small>{usageNames[job.usageStatus] ?? '用量未知'}</small>{job.errorMessage && <small className="ctx-error">{job.errorMessage}</small>}</>;
}

export function MemoryExtractionJobs({ topicId }: { topicId: string }) {
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
  return <section className="memory-jobs" aria-label="记忆提取记录" data-testid="memory-extraction-jobs">
    <div className="memory-jobs-heading">
      <div><h2>提取记录</h2><p className="ctx-muted">每次记忆提取的模型调用与 token 用量，包含失败记录。</p></div>
      <Button variant="outline" disabled={query.isFetching || invalidRange} onClick={() => void query.refetch()}>刷新记录</Button>
    </div>
    <div className="memory-jobs-filters">
      <label>开始日期<input type="date" aria-label="开始日期" value={from} onChange={(e) => change(setFrom, e.target.value)} /></label>
      <label>结束日期<input type="date" aria-label="结束日期" value={to} onChange={(e) => change(setTo, e.target.value)} /></label>
      <label>模型<select aria-label="筛选模型" value={model} onChange={(e) => change(setModel, e.target.value)}><option value="">全部模型</option>{Array.from(new Set([...(data?.filters.models ?? []), ...(model ? [model] : [])])).map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>API 提供商<select aria-label="筛选提供商" value={provider} onChange={(e) => change(setProvider, e.target.value)}><option value="">全部提供商</option>{Array.from(new Set([...(data?.filters.providers ?? []), ...(provider ? [provider] : [])])).map((value) => <option key={value} value={value}>{providerName(value)}</option>)}</select></label>
      <label>状态<select aria-label="筛选状态" value={status} onChange={(e) => change(setStatus, e.target.value)}><option value="">全部状态</option>{Object.entries(statusNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <Button variant="ghost" onClick={() => { setFrom(''); setTo(''); setModel(''); setProvider(''); setStatus(''); setCursor(0); }}>全部时间</Button>
    </div>
    {invalidRange && <p role="alert" className="ctx-error">开始日期不能晚于结束日期。</p>}
    {query.isPending && !invalidRange && <p role="status">正在读取提取记录…</p>}
    {query.error && <p role="alert" className="ctx-error">提取记录读取失败：{query.error.message} <Button variant="outline" onClick={() => void query.refetch()}>重试读取</Button></p>}
    {data && !invalidRange && <>
      <div className="memory-jobs-metrics" aria-label="筛选范围用量汇总">
        <div><span>提取任务</span><strong>{data.summary.jobCount.toLocaleString('zh-CN')}</strong></div>
        <div><span>已知输入 token</span><strong>{formatTokens(data.summary.inputTokens)}</strong></div>
        <div><span>已知输出 token</span><strong>{formatTokens(data.summary.outputTokens)}</strong></div>
        <div><span>已知总 token</span><strong>{formatTokens(data.summary.totalTokens)}</strong></div>
      </div>
      <p className="ctx-muted">汇总包含全部匹配记录，不受分页影响。用量缺失：{data.summary.missingUsageCount} 条；未知值不按零计算，复用输出不重复计入。</p>
      {!data.items.length ? <p className="memory-jobs-empty">这个范围内没有提取记录。</p> : <>
        <div className="memory-jobs-table-wrap"><table className="memory-jobs-table">
          <caption className="sr-only">每次记忆提取的模型、提供商及 token 用量</caption>
          <thead><tr><th>时间 / 清单</th><th>模型 / API 提供商</th><th>输入 / 输出 / 总 token</th><th>状态 / 用量说明</th><th>耗时</th></tr></thead>
          <tbody>{data.items.map((job) => <tr key={job.id}><td><span>{jobTime(job)}</span><small>{job.scopeName}</small></td><td><Model job={job} /><small>{providerName(job.provider)}</small></td><td><Tokens job={job} /></td><td><Result job={job} /></td><td>{jobDuration(job)}</td></tr>)}</tbody>
        </table></div>
        <div className="memory-jobs-cards">{data.items.map((job) => <article key={job.id} className="ctx-card" aria-label={'提取记录 ' + job.id}>
          <div className="memory-job-card-heading"><strong>{job.scopeName}</strong><span>{jobTime(job)}</span></div>
          <dl><dt>模型</dt><dd><Model job={job} /></dd><dt>API 提供商</dt><dd>{providerName(job.provider)}</dd><dt>输入 / 输出 / 总 token</dt><dd><Tokens job={job} /></dd><dt>状态</dt><dd><Result job={job} /></dd><dt>耗时</dt><dd>{jobDuration(job)}</dd></dl>
        </article>)}</div>
      </>}
      <nav aria-label="提取记录分页" className="memory-jobs-pagination">
        <span>共 {data.total} 条 · 第 {Math.floor(cursor / 20) + 1} 页</span>
        <Button variant="outline" disabled={cursor === 0 || query.isFetching} onClick={() => setCursor(Math.max(0, cursor - 20))}>上一页</Button>
        <Button variant="outline" disabled={data.nextCursor === null || query.isFetching} onClick={() => setCursor(data.nextCursor ?? cursor)}>下一页</Button>
      </nav>
    </>}
  </section>;
}
