import { useTranslation } from 'react-i18next';
import { ArrowRight, Play, RotateCcw, LoaderCircle } from 'lucide-react';
import { useLearningCapabilities } from '@/lib/learning-api.js';
import { Button } from '@/components/ui/button.js';
import { MarkdownView } from '@/components/shared/MarkdownView.js';

export function LearningHomeSummary({ scope, onNode, onSession, onReview, onGenerate, onJob }: {
  scope: string; onNode: (mapId: string,nodeId: string) => void; onSession: (id: string) => void; onReview: () => void; onGenerate: () => void; onJob: (mapId: string, id: string) => void;
}) {
  const { t, i18n } = useTranslation('learning');
  const { overview, unsupported } = useLearningCapabilities(scope);
  if (unsupported) return null; // The page shows the shared compatibility notice beside maps and notes.
  if (overview.isError) return <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"><span>{t('workflow.overviewFailed')}</span><Button variant="outline" onClick={() => void overview.refetch()}>{t('retry')}</Button></div>;
  const data = overview.data;
  const ongoing = data?.sessions[0];
  return <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5" data-testid="learning-home-summary" aria-label={t('workflow.continue')}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">{t('workflow.continue')}</p><h2 className="mt-1 break-words text-lg font-semibold">{ongoing?.mapTitle ?? data?.resume?.nodeTitle ?? t('workflow.choosePoint')}</h2>{ongoing ? <p className="mt-1 text-sm text-muted-foreground">{t('workflow.sessionPosition', { current: ongoing.currentPosition + 1, total: ongoing.total })}</p> : data?.resume && <p className="mt-1 text-xs text-muted-foreground">{t('workflow.lastSaved', { time: new Date(data.resume.updatedAt).toLocaleString(i18n.language) })}</p>}</div>
      {ongoing ? <Button data-session-id={ongoing.id} className="min-h-11" onClick={() => onSession(ongoing.id)}><Play />{t('workflow.continuePractice')}</Button> : data?.resume?.nodeId && data.resume.mapId ? <Button className="min-h-11" onClick={() => onNode(data.resume!.mapId!,data.resume!.nodeId!)}><ArrowRight />{t('workflow.continue')}</Button> : <Button className="min-h-11" onClick={onGenerate}>{t('workflow.startPractice')}</Button>}
    </div>
    <div className="flex flex-wrap items-center gap-3 border-t pt-3"><Button variant="outline" className="min-h-11" onClick={onReview}><RotateCcw />{t('workflow.reviewDue', { count: data?.counts.due ?? 0 })}</Button><Button variant="ghost" className="min-h-11" onClick={onGenerate}>{t('workflow.startPractice')}</Button>{overview.isLoading && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-label={t('workflow.loading')} />}</div>
    {data?.sessions.slice(1).map(session => <Button variant="row" size="bare" key={session.id} data-session-id={session.id} className="flex min-h-11 w-full items-center justify-between gap-2 border-t py-2 text-left text-sm" onClick={() => onSession(session.id)}><span className="min-w-0 break-words">{session.mapTitle} · {t('workflow.sessionPosition', { current: session.currentPosition + 1,total: session.total })}</span><ArrowRight className="size-4 shrink-0" /></Button>)}
    {data?.pendingGenerationJobs.map(job => <Button variant="outline" key={job.id} className="min-h-11 w-full justify-start whitespace-normal text-left" onClick={() => onJob(job.mapId,job.id)}>{t(job.state === 'succeeded' ? 'workflow.setup.ready' : 'workflow.setup.generating')}</Button>)}
    {data?.checkpoint && <div className="border-t pt-3"><h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('workflow.lastCheckpoint')}</h3><MarkdownView content={data.checkpoint.content} /></div>}
  </section>;
}
