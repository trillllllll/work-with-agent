import { Button } from '@/components/ui/button.js';
import { Surface } from '@/components/ui/surface.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePageContext } from '@/lib/assistant-context.js';
import { api, type Topic } from '@/lib/api.js';
import { json } from '@/lib/platform.js';
import { analyzeProposal } from '@/lib/proposal-group.js';
import type { ProposalKind } from '@/lib/proposal-fields.js';
import { proposalSource, sourceGroupKey, type ConnectionName } from '@/lib/proposal-source.js';
import { usePendingProposalCount } from '@/lib/use-pending-proposal-count.js';
import { cn } from '@/lib/utils.js';
import { BulkBar } from './proposals/BulkBar.js';
import { ChatProposalCards, isChatProposal } from './proposals/ChatProposalCards.js';
import { ProposalCard } from './proposals/ProposalCard.js';
import { ProposalFilters, type FilterValue } from './proposals/ProposalFilters.js';
import { invalidateProposalViews } from './proposals/present.js';
import type { Proposal } from './proposals/types.js';

const statuses = ['pending', 'applied', 'rejected'] as const;
type StatusTab = (typeof statuses)[number];
const typeOrder: ProposalKind[] = ['task', 'memory', 'skill', 'other'];
const emptySources = ['connection', 'autoMemory', 'organization', 'learning', 'assistant'] as const;

function selectable(proposal: Proposal) {
  return proposal.status === 'pending' && !isChatProposal(proposal);
}

export function ProposalsPage() {
  const { t } = useTranslation('proposals');
  const client = useQueryClient();
  const [status, setStatus] = useState<StatusTab>('pending');
  const [pinned, setPinned] = useState<Proposal[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [cardErrors, setCardErrors] = useState<Record<string, unknown>>({});
  const [bulkResult, setBulkResult] = useState<{ ok: number; fail: number } | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [filter, setFilter] = useState<FilterValue>({ type: 'all', source: 'all' });
  usePageContext('proposals', { pageState: { status } });
  const query = useQuery({ queryKey: ['proposals', status], queryFn: () => api<Proposal[]>(`/api/v1/proposals?status=${status}`) });
  const pendingCount = usePendingProposalCount();
  const topicsQuery = useQuery({ queryKey: ['topics'], queryFn: () => api<Topic[]>('/api/topics') });
  const connectionsQuery = useQuery({ queryKey: ['connections'], queryFn: () => api<ConnectionName[]>('/api/v1/connections') });
  const topics = topicsQuery.isSuccess && Array.isArray(topicsQuery.data) ? topicsQuery.data.map((topic) => ({ id: topic.id, name: topic.name, color: topic.color })) : undefined;
  const connections = connectionsQuery.isSuccess && Array.isArray(connectionsQuery.data) ? connectionsQuery.data.map((item) => ({ id: item.id, name: item.name })) : undefined;
  const rows = new Map<string, Proposal>();
  for (const proposal of query.data ?? []) rows.set(proposal.id, proposal);
  for (const proposal of pinned) rows.set(proposal.id, proposal);
  const listed = [...rows.values()];
  const annotated = listed.map((proposal) => {
    const analysis = analyzeProposal(proposal.commands, proposal.preview);
    return {
      proposal,
      type: analysis.type,
      items: analysis.items.length,
      sourceKey: sourceGroupKey(proposal.actorId, proposal.connectionId),
      sourceLabel: proposalSource(proposal.actorId, { connectionId: proposal.connectionId, connections }).label,
    };
  });
  const typeCounts = new Map<string, number>();
  const sourceCounts = new Map<string, { label: string; count: number }>();
  for (const row of annotated) {
    typeCounts.set(row.type, (typeCounts.get(row.type) ?? 0) + 1);
    const current = sourceCounts.get(row.sourceKey) ?? { label: row.sourceLabel, count: 0 };
    current.count += 1;
    current.label = row.sourceLabel;
    sourceCounts.set(row.sourceKey, current);
  }
  const typeOptions = [
    { id: 'all', label: t('filter.all'), count: listed.length },
    ...typeOrder.filter((id) => (typeCounts.get(id) ?? 0) > 0).map((id) => ({ id, label: t(`type.${id}`), count: typeCounts.get(id) ?? 0 })),
  ];
  const sourceOptions = [
    { id: 'all', label: t('filter.all'), count: listed.length },
    ...[...sourceCounts.entries()].filter(([, row]) => row.count > 0).map(([id, row]) => ({ id, label: row.label, count: row.count })),
  ];
  const effective: FilterValue = {
    type: typeOptions.some((item) => item.id === filter.type) ? filter.type : 'all',
    source: sourceOptions.some((item) => item.id === filter.source) ? filter.source : 'all',
  };
  const filtered = annotated.filter((row) => (effective.type === 'all' || row.type === effective.type) && (effective.source === 'all' || row.sourceKey === effective.source));
  const chosen = filtered.filter((row) => selected.includes(row.proposal.id) && selectable(row.proposal));
  const chosenItems = chosen.reduce((sum, row) => sum + row.items, 0);
  const loaded = query.data?.length ?? 0;
  const pendingTotal = pendingCount.data?.pending;
  const capped = query.isSuccess && (status === 'pending' ? typeof pendingTotal === 'number' && pendingTotal > loaded : loaded >= 100);
  const barVisible = chosen.length > 0 || bulkRunning || bulkResult !== null;
  const selectStatus = (next: StatusTab) => {
    setStatus(next);
    setPinned([]);
    setSelected([]);
    setCardErrors({});
    setBulkResult(null);
    setFilter({ type: 'all', source: 'all' });
  };
  const clearError = (id: string) => setCardErrors((current) => {
    if (!(id in current)) return current;
    const next = { ...current };
    delete next[id];
    return next;
  });
  const runBulk = async (path: 'approve' | 'reject') => {
    if (bulkRunning || !chosen.length) return;
    setBulkRunning(true);
    const targets = chosen.map((row) => row.proposal);
    let ok = 0;
    let fail = 0;
    const next = { ...cardErrors };
    const done: string[] = [];
    for (const proposal of targets) {
      try {
        if (path === 'approve') await api(`/api/v1/proposals/${proposal.id}/approve`, { method: 'POST', body: json({ expectedRevision: proposal.revision, requestId: crypto.randomUUID() }) });
        else await api(`/api/v1/proposals/${proposal.id}/reject`, { method: 'POST', body: json({ expectedRevision: proposal.revision, reason: '' }) });
        ok += 1;
        done.push(proposal.id);
        delete next[proposal.id];
      } catch (error) {
        fail += 1;
        next[proposal.id] = error;
      }
    }
    setCardErrors(next);
    setSelected((current) => current.filter((id) => !done.includes(id)));
    setBulkResult({ ok, fail });
    setBulkRunning(false);
    await invalidateProposalViews(client);
  };
  const pendingLabel = typeof pendingTotal === 'number' ? `${t('status.pending')} ${pendingTotal}` : t('status.pending');
  const tabLabel = (id: StatusTab) => id === 'pending' ? pendingLabel : t(`status.${id}`);
  return (
    <section className={cn('mx-auto max-w-4xl space-y-5 p-5 sm:p-7', barVisible && 'max-sm:pb-36')}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Surface as="div" tone="input" role="tablist" aria-label={t('statusAria')} className="glass-control inline-flex flex-wrap rounded-lg p-1">
          {statuses.map((id) => (
            <Button variant="tab" size="bare" key={id} type="button" role="tab" aria-selected={status === id} aria-pressed={status === id} className="px-3 py-1.5 text-sm" onClick={() => selectStatus(id)}>
              {tabLabel(id)}
            </Button>
          ))}
        </Surface>
      </header>
      {query.error ? <p role="alert" className="text-sm">{query.error.message}</p> : null}
      {listed.length ? <ProposalFilters types={typeOptions} sources={sourceOptions} value={effective} onChange={setFilter} /> : null}
      {capped ? <p className="text-sm text-muted-foreground">{t('capped')}</p> : null}
      <BulkBar groups={chosen.length} items={chosenItems} running={bulkRunning} result={bulkResult} onClear={() => { setSelected([]); setBulkResult(null); }} onApprove={() => { void runBulk('approve'); }} onReject={() => { void runBulk('reject'); }} />
      {query.isLoading && !listed.length ? <p className="text-sm">{t('loading')}</p> : null}
      {!query.isLoading && !query.error && !listed.length ? (
        status === 'pending' ? (
          <Surface as="div" tone="subtle" className="rounded-xl px-4 py-8">
            <h2 className="text-base font-semibold">{t('empty.title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('empty.pending')}</p>
            <ul className="mt-4 space-y-3">
              {emptySources.map((id) => (
                <li key={id}>
                  <div className="text-sm font-medium">{t(`empty.sources.${id}`)}</div>
                  <div className="text-xs text-muted-foreground">{t(`empty.sources.${id}Hint`)}</div>
                </li>
              ))}
            </ul>
          </Surface>
        ) : <p className="py-8 text-sm text-muted-foreground">{t('empty.other')}</p>
      ) : null}
      {listed.length && !filtered.length ? <p className="py-8 text-sm text-muted-foreground">{t('filter.empty')}</p> : null}
      <div className="space-y-4">
        {filtered.map(({ proposal }) => {
          const chat = proposal.appChangeCard?.review || proposal.batchCard || isChatProposal(proposal);
          if (chat) return <ChatProposalCards key={`${proposal.id}:${proposal.revision}`} proposal={proposal} connections={connections} onSettled={(next) => setPinned((current) => [...current.filter((item) => item.id !== next.id), next])} />;
          return (
            <ProposalCard
              key={`${proposal.id}:${proposal.revision}`}
              proposal={proposal}
              connections={connections}
              topics={topics}
              selected={selected.includes(proposal.id)}
              onSelected={(on) => setSelected((current) => on ? [...current.filter((id) => id !== proposal.id), proposal.id] : current.filter((id) => id !== proposal.id))}
              externalError={cardErrors[proposal.id]}
              onClearError={() => clearError(proposal.id)}
              actionsLocked={bulkRunning}
            />
          );
        })}
      </div>
    </section>
  );
}
