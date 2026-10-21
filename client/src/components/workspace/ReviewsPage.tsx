import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { usePageContext } from '@/lib/assistant-context.js';
import { ApiError, api, type ReviewBatch, type ReviewRule, type Topic } from '@/lib/api.js';
import { json } from '@/lib/platform.js';
import { latestBatchByRule, sortRules } from '@/lib/review-format.js';
import { useHashRoute } from '@/hooks/useHashRoute.js';
import { settingsHash } from '@/components/settings/settings-categories.js';
import { Button } from '@/components/ui/button.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog.js';
import { ReviewEmpty, type ReviewDraftSeed } from './reviews/ReviewEmpty.js';
import { ReviewRecordList, type RunningRuleRow } from './reviews/ReviewRecordList.js';
import { ReviewReportDrawer } from './reviews/ReviewReportDrawer.js';
import { ReviewRuleCard } from './reviews/ReviewRuleCard.js';
import { ReviewRuleDialog, type ReviewRuleDraft } from './reviews/ReviewRuleDialog.js';
import { useBuiltinModelState } from './reviews/ProviderCards.js';
import { browserTimeZone } from './reviews/ScheduleFields.js';

type DialogState =
  | { kind: 'create'; key: string; seed: ReviewDraftSeed }
  | { kind: 'edit'; rule: ReviewRule; initialStep: 1 | 2 };

function blankSeed(): ReviewDraftSeed {
  return { name: '', frequency: 'daily', timeOfDay: '21:00', weekDay: 0, includeInbox: true, topicIds: [], provider: 'none', timeZone: browserTimeZone() };
}

export function ReviewsPage({ topics }: { topics: Topic[] }) {
  const { t } = useTranslation('workspace');
  const queryClient = useQueryClient();
  const { query, setQuery } = useHashRoute();
  const rules = useQuery({ queryKey: ['review-rules'], queryFn: () => api<ReviewRule[]>('/api/v1/reviews/rules') });
  const batches = useQuery({ queryKey: ['review-batches'], queryFn: () => api<ReviewBatch[]>('/api/v1/reviews/batches'), refetchInterval: 30_000 });
  const archivedQuery = useQuery({ queryKey: ['topics', 'archived'], queryFn: () => api<Topic[]>('/api/topics?archived=true') });
  const { missing: modelMissing } = useBuiltinModelState();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [conflict, setConflict] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ReviewRule | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [runningRuleIds, setRunningRuleIds] = useState<Set<string>>(() => new Set());
  const startedAt = useRef(new Map<string, string>());
  const batchId = query.batch ?? '';
  const selectedId = dialog?.kind === 'edit' ? dialog.rule.id : batchId;
  usePageContext('reviews', { pageState: { selectedId } });
  const ruleList = rules.data ?? [];
  const batchList = batches.data ?? [];
  const archivedTopics = archivedQuery.data ?? [];
  const archivedLoaded = archivedQuery.isSuccess;
  const latest = latestBatchByRule(batchList);
  const ordered = sortRules(ruleList, latest);
  const listed = batchList.find((batch) => batch.id === batchId) ?? null;
  const single = useQuery({
    queryKey: ['review-batches', batchId],
    queryFn: () => api<ReviewBatch>(`/api/v1/reviews/batches/${encodeURIComponent(batchId)}`),
    enabled: Boolean(batchId) && !listed && batches.isFetched,
  });
  const openBatch = listed ?? single.data ?? null;
  const batchLoading = Boolean(batchId) && !openBatch && !single.isError && (batches.isLoading || !batches.isFetched || single.isLoading || single.isFetching);
  const batchMissing = Boolean(batchId) && !openBatch && !batchLoading;
  const loading = (rules.isLoading && !rules.data) || (batches.isLoading && !batches.data);
  const enabledCount = ruleList.filter((rule) => rule.enabled).length;
  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['review-rules'] }),
    queryClient.invalidateQueries({ queryKey: ['review-batches'] }),
  ]);
  const report = (error: unknown) => {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      setDialog(null);
      setDeleteTarget(null);
      setConflict(true);
      return;
    }
    toast.error(error instanceof Error ? error.message : t('app:action.failed'));
  };
  const refresh = () => {
    setConflict(false);
    void rules.refetch();
    void batches.refetch();
  };
  const runNow = useMutation({
    mutationFn: (rule: ReviewRule) => api(`/api/v1/reviews/rules/${rule.id}/run`, { method: 'POST', body: '{}' }),
    onMutate: (rule) => {
      startedAt.current.set(rule.id, new Date().toISOString());
      setRunningRuleIds((current) => new Set(current).add(rule.id));
    },
    onSuccess: async () => { await invalidate(); },
    onError: (error) => { toast.error(error instanceof Error ? error.message : t('app:action.failed')); },
    onSettled: (_data, _error, rule) => {
      startedAt.current.delete(rule.id);
      setRunningRuleIds((current) => {
        const next = new Set(current);
        next.delete(rule.id);
        return next;
      });
    },
  });
  const runningRules: RunningRuleRow[] = ruleList.flatMap((rule) => (
    runningRuleIds.has(rule.id) ? [{ id: rule.id, name: rule.name, startedAt: startedAt.current.get(rule.id) ?? new Date().toISOString() }] : []
  ));
  const submit = async (draft: ReviewRuleDraft) => {
    try {
      if (dialog?.kind === 'edit') {
        const rule = dialog.rule;
        await api(`/api/v1/reviews/rules/${rule.id}`, { method: 'PATCH', body: json({ name: draft.name, frequency: draft.frequency, timeOfDay: draft.timeOfDay, timeZone: draft.timeZone, weekDay: draft.weekDay, topicIds: draft.topicIds, includeInbox: draft.includeInbox, provider: draft.provider, expectedVersion: rule.revision }) });
        toast.success(t('reviews.savedToast'));
      } else {
        await api('/api/v1/reviews/rules', { method: 'POST', body: json({ name: draft.name, frequency: draft.frequency, timeOfDay: draft.timeOfDay, timeZone: draft.timeZone, weekDay: draft.weekDay, topicIds: draft.topicIds, includeInbox: draft.includeInbox, provider: draft.provider, enabled: draft.pausedForModel ? false : draft.enabled }) });
        toast.success(draft.pausedForModel ? t('reviews.savedPausedToast') : t('reviews.savedToast'));
      }
      await invalidate();
      setDialog(null);
    } catch (error) { report(error); }
  };
  const toggle = async (rule: ReviewRule, enabled: boolean) => {
    if (enabled && rule.provider === 'builtin' && modelMissing) {
      toast.warning(t('reviews.enableNeedsModel'), { action: { label: t('reviews.modelMissingAction'), onClick: () => { window.location.hash = settingsHash('model'); } } });
      return;
    }
    try {
      await api(`/api/v1/reviews/rules/${rule.id}`, { method: 'PATCH', body: json({ expectedVersion: rule.revision, enabled }) });
      await invalidate();
      toast.success(enabled ? t('reviews.enableToast') : t('reviews.pauseToast'));
    } catch (error) { report(error); }
  };
  const retry = async (batch: ReviewBatch) => {
    setRetryingId(batch.id);
    try {
      const created = await api<ReviewBatch>(`/api/v1/reviews/batches/${batch.id}/retry`, { method: 'POST', body: '{}' });
      await invalidate();
      toast.success(t('reviews.retryToast'));
      if (created?.id) setQuery({ batch: created.id });
    } catch (error) { report(error); }
    finally { setRetryingId(null); }
  };
  const remove = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api(`/api/v1/reviews/rules/${deleteTarget.id}`, { method: 'DELETE', body: json({ expectedVersion: deleteTarget.revision }) });
      await invalidate();
      toast.success(t('reviews.deletedToast'));
      if (query.rule === deleteTarget.id) setQuery({ rule: null });
      setDeleteTarget(null);
    } catch (error) { report(error); }
    finally { setDeleteBusy(false); }
  };
  const openCreate = (seed: ReviewDraftSeed = blankSeed()) => setDialog({ kind: 'create', key: crypto.randomUUID(), seed });
  return (
    <section className="mx-auto max-w-4xl space-y-6 p-5 sm:p-7">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{t('reviews.title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('reviews.description')}</p>
        </div>
        <Button type="button" className="shrink-0" aria-label={t('reviews.new')} onClick={() => openCreate()}>
          <Plus aria-hidden="true" />
          <span className="sm:hidden">{t('reviews.newShort')}</span>
          <span className="hidden sm:inline">{t('reviews.new')}</span>
        </Button>
      </header>
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Clock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>{t('reviews.serviceHint')}</span>
      </p>
      {conflict && <Callout message={t('reviews.conflict')} onRefresh={refresh} />}
      {(rules.isError || batches.isError) && <Callout message={t('reviews.loadFailed')} onRefresh={refresh} />}
      {loading ? (
        <div role="status" aria-label={t('reviews.loading')} className="space-y-3">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : (
        <>
          {rules.isSuccess && ruleList.length === 0 && <ReviewEmpty onTemplate={openCreate} />}
          {ruleList.length > 0 && (
            <section className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-sm font-semibold">{t('reviews.rulesHeading')}</h2>
                <span className="text-xs text-muted-foreground">{t('reviews.rulesSummary', { enabled: enabledCount, paused: ruleList.length - enabledCount })}</span>
              </div>
              {ordered.map((rule) => (
                <ReviewRuleCard
                  key={rule.id}
                  rule={rule}
                  topics={topics}
                  archivedTopics={archivedTopics}
                  archivedLoaded={archivedLoaded}
                  latest={latest.get(rule.id)}
                  running={runningRuleIds.has(rule.id)}
                  modelMissing={modelMissing}
                  onToggle={(enabled) => { void toggle(rule, enabled); }}
                  onRun={() => { if (!runningRuleIds.has(rule.id)) runNow.mutate(rule); }}
                  onEdit={(step) => setDialog({ kind: 'edit', rule, initialStep: step })}
                  onDuplicate={() => openCreate({ name: rule.name, frequency: rule.frequency, timeOfDay: rule.timeOfDay, weekDay: rule.weekDay, includeInbox: rule.includeInbox, topicIds: [...rule.topicIds], provider: rule.provider, timeZone: rule.timeZone })}
                  onFilter={() => setQuery({ rule: rule.id })}
                  onDelete={() => setDeleteTarget(rule)}
                  onRetry={(batch) => { void retry(batch); }}
                  onView={(batch) => setQuery({ batch: batch.id })}
                />
              ))}
            </section>
          )}
          {(ruleList.length > 0 || batchList.length > 0) && (
            <section className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-sm font-semibold">{t('reviews.recordsHeading')}</h2>
                <span className="text-xs text-muted-foreground">{t('reviews.recordsLimit')}</span>
              </div>
              <ReviewRecordList rules={ruleList} batches={batchList} ruleId={query.rule ?? ''} selectedId={batchId} runningRules={runningRules} onRuleChange={(ruleId) => setQuery({ rule: ruleId })} onOpen={(id) => setQuery({ batch: id })} />
            </section>
          )}
        </>
      )}
      {dialog && (
        <ReviewRuleDialog
          key={dialog.kind === 'edit' ? `${dialog.rule.id}:${dialog.rule.revision}:${dialog.initialStep}` : dialog.key}
          mode={dialog.kind}
          rule={dialog.kind === 'edit' ? dialog.rule : undefined}
          seed={dialog.kind === 'create' ? dialog.seed : undefined}
          initialStep={dialog.kind === 'edit' ? dialog.initialStep : 1}
          topics={topics}
          archivedTopics={archivedTopics}
          archivedLoaded={archivedLoaded}
          onClose={() => setDialog(null)}
          onSubmit={submit}
        />
      )}
      <ReviewReportDrawer key={batchId || 'closed'} open={Boolean(batchId)} batch={openBatch} loading={batchLoading} missing={batchMissing} retrying={retryingId !== null && retryingId === openBatch?.id} onClose={() => setQuery({ batch: null })} onRetry={(batch) => { void retry(batch); }} />
      {deleteTarget && (
        <ConfirmDialog title={t('reviews.deleteTitle', { name: deleteTarget.name })} itemName={deleteTarget.name} description={t('reviews.deleteDescription')} confirmLabel={t('reviews.delete')} busy={deleteBusy} onCancel={() => { if (!deleteBusy) setDeleteTarget(null); }} onConfirm={() => { void remove(); }} />
      )}
    </section>
  );
}

function Callout({ message, onRefresh }: { message: string; onRefresh: () => void }) {
  const { t } = useTranslation('workspace');
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <span className="min-w-0 break-words">{message}</span>
      <Button type="button" size="sm" variant="outline" onClick={onRefresh}><RefreshCw aria-hidden="true" />{t('reviews.refresh')}</Button>
    </div>
  );
}
