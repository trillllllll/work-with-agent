import type { LearningCardPart } from '../../chat.js';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api.js';
import { learningKey, type PracticeJobView } from '@/lib/learning-api.js';
import { learningHash } from '@/lib/learning-navigation.js';
import { askAssistant, contextLabel } from '@/lib/assistant-context.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';
import { Surface } from '@/components/ui/surface.js';
import { Button } from '@/components/ui/button.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { PracticeSetup } from '@/components/learning/PracticeSetup.js';
import { PracticeSessionView } from '@/components/learning/PracticeSessionView.js';
import { navigateLearning } from './learning-events.js';

export function LearningPracticeCard({ part }: { part: LearningCardPart }) {
  const runtime = useEditorRuntime();
  return runtime ? <PracticeCardContent key={`${runtime.scopeKey}:${part.id}`} scope={runtime.scopeKey} part={part} /> : <Skeleton className="h-14 w-full" />;
}

function PracticeCardContent({ scope, part }: { scope: string; part: LearningCardPart }) {
  const { t } = useTranslation('chat');
  const client = useQueryClient();
  const [started, setStarted] = useState('');
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const job = useQuery({ queryKey: learningKey(scope, 'job', part.jobId), enabled: Boolean(part.jobId),
    queryFn: () => api<PracticeJobView>(`/api/v1/learning/jobs/${encodeURIComponent(part.jobId!)}`), retry: false,
    refetchInterval: query => ['queued', 'running'].includes(query.state.data?.state ?? '') ? 1500 : false });
  const sessionId = part.sessionId || started || job.data?.adoptedSessionId;
  // Historical adopted cards start collapsed, so a restored transcript cannot
  // mount several editors for the same practice before the user picks one.
  const open = expanded ?? Boolean(part.jobId && !sessionId);
  const morePractice = () => askAssistant({ kind: 'draft', title: contextLabel(part.title), text: part.title, learningMapId: part.mapId, unsaved: false }, { prompt: t('learningCard.morePractice') });
  return <Surface as="section" tone="card" className="learning-card min-w-0 space-y-3 rounded-xl p-3" data-testid="learning-card-practice">
    <header className="flex flex-wrap items-center gap-2"><h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{part.title}</h3>
      <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setExpanded(!open)}>{t(open ? 'learningCard.collapse' : 'learningCard.openPractice')}</Button>
      {sessionId && <Button variant="ghost" size="sm" onClick={() => { setExpanded(false); navigateLearning(learningHash({ mapId: part.mapId, sessionId })); }}>{t('learningCard.inArchive')}</Button>}
    </header>
    {open && (sessionId ? <PracticeSessionView scope={scope} sessionId={sessionId} onBack={() => setExpanded(false)} onAgain={morePractice} />
      : job.isLoading ? <Skeleton className="h-24 w-full" />
        : job.isError ? <div role="alert" className="space-y-2 text-sm"><p>{job.error.message}</p><Button variant="outline" onClick={() => void job.refetch()}>{t('retry')}</Button></div>
          : <PracticeSetup key={part.jobId} inline scope={scope} mapId={part.mapId} initialJobId={part.jobId} onClose={() => setExpanded(false)} onStarted={id => { setStarted(id); setExpanded(true); void client.invalidateQueries({ queryKey: learningKey(scope, 'job', part.jobId) }); }} />)}
  </Surface>;
}
