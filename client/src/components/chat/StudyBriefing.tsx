import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { LearningBriefing } from '../../../../server/src/domain/learning-briefing.js';
import { api } from '@/lib/api.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { Button } from '@/components/ui/button.js';
import { LearningPracticeCard } from './LearningPracticeCard.js';

export function StudyBriefing({ topicId }: { topicId: string }) {
  const { t } = useTranslation('chat');
  const runtime = useEditorRuntime();
  const query = useQuery({ queryKey: ['learning-briefing', topicId, runtime?.scopeKey], enabled: Boolean(topicId && runtime),
    queryFn: () => api<LearningBriefing>(`/api/v1/learning/maps/${encodeURIComponent(topicId)}/briefing`), staleTime: 30_000 });
  return <Disclosure className="shrink-0 border-b px-3 text-xs" data-testid="study-briefing">
    <DisclosureTrigger className="min-h-11 text-muted-foreground">{t('briefing.title')}</DisclosureTrigger>
    <div className="max-h-[40dvh] space-y-3 overflow-y-auto pb-3">
      {query.isError ? <div role="alert"><p>{query.error.message}</p><Button variant="outline" size="sm" onClick={() => void query.refetch()}>{t('retry')}</Button></div>
        : !query.data ? <p role="status">{t('studyTopic.loading')}</p> : <>
          <p className="whitespace-pre-wrap">{query.data.checkpoint?.content || t('briefing.noCheckpoint')}</p>
          <p>{t('briefing.recent', { count: query.data.attempts.length })} · {t('briefing.due', { count: query.data.reviews.length, more: query.data.moreReviews ? '+' : '' })}</p>
          <p className="text-muted-foreground">{t('briefing.coverage')}</p>
          {query.data.sessions.map(session => <LearningPracticeCard key={session.id} part={{ schemaVersion: 1, type: 'learning_card', id: `brief:${session.id}`, kind: 'practice', mapId: topicId, sessionId: session.id, title: query.data!.map.title }} />)}
        </>}
    </div>
  </Disclosure>;
}
