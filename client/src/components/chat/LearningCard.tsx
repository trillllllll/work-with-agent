import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Map as MapIcon } from 'lucide-react';
import { api, ApiError } from '@/lib/api.js';
import { learningHash, learningNodePath } from '@/lib/learning-navigation.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';
import { Button } from '@/components/ui/button.js';
import { Surface } from '@/components/ui/surface.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { LearningFigure } from '@/components/learning/LearningFigure.js';
import { MasteryBadge } from '@/components/learning/MasteryDisplay.js';
import { flattenTree, type LearningMapAggregate } from '@/components/learning/learning-model.js';
import type { LearningCardPart } from '../../chat.js';
import { LearningPracticeCard } from './LearningPracticeCard.js';
import { navigateLearning, showLearningFigure } from './learning-events.js';

/** Learning cards render current data, so a status or note changed later shows up in old messages too. */
export function LearningCard({ part }: { part: LearningCardPart }) {
  if (part.kind === 'practice') return <LearningPracticeCard part={part} />;
  return <TopicCard part={part} />;
}

function TopicCard({ part }: { part: LearningCardPart }) {
  const { t } = useTranslation('chat');
  const scope = useEditorRuntime()?.scopeKey;
  const aggregate = useQuery({ queryKey: ['learning-map', part.mapId, scope], queryFn: () => api<LearningMapAggregate>(`/api/v1/learning/maps/${encodeURIComponent(part.mapId)}`), retry: false });
  const nodes = useMemo(() => flattenTree(aggregate.data?.tree ?? []), [aggregate.data]);
  if (aggregate.isLoading) return <Skeleton className="h-14 w-full max-w-[560px] rounded-xl" />;
  if (aggregate.isError) return <Surface tone="subtle" className="max-w-[560px] space-y-2 rounded-xl px-3 py-2 text-xs text-muted-foreground" data-testid="learning-card-unavailable"><p role="alert">{aggregate.error instanceof ApiError && aggregate.error.status === 404 ? t('learningCard.unavailable', { title: part.title }) : aggregate.error.message}</p><Button variant="outline" size="sm" onClick={() => void aggregate.refetch()}>{t('retry')}</Button></Surface>;
  const mapTitle = aggregate.data?.map.title ?? '';
  if (part.kind === 'figure') {
    const figure = aggregate.data?.figure;
    return <Surface as="section" tone="card" className="learning-card max-w-[640px] space-y-2 rounded-xl p-3" data-testid="learning-card-figure" aria-label={t('studyTopic.figureOf', { title: mapTitle })}>
      <div className="flex items-center gap-2"><MapIcon className="size-4 text-muted-foreground" /><h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('studyTopic.figureOf', { title: mapTitle })}</h3></div>
      {figure ? <LearningFigure svg={figure.svg} nodes={nodes} currentId={part.nodeId} onPick={(id) => showLearningFigure(part.mapId, id)} label={t('studyTopic.figureOf', { title: mapTitle })} />
        : <p className="text-xs text-muted-foreground">{t('studyTopic.noFigure')}</p>}
    </Surface>;
  }
  const node = nodes.find(item => item.id === part.nodeId && item.kind === 'item');
  if (!node) return <Surface tone="subtle" className="max-w-[560px] rounded-xl px-3 py-2 text-xs text-muted-foreground" data-testid="learning-card-unavailable">{t('learningCard.unavailable', { title: part.title })}</Surface>;
  const path = learningNodePath(nodes, node.id).slice(0, -1).map(item => item.title);
  return <Surface as="section" tone="card" className="learning-card flex max-w-[560px] flex-wrap items-center gap-2 rounded-xl px-3 py-2" data-testid="learning-card-node" data-node-id={node.id}>
    <BookOpen className="size-4 shrink-0 text-muted-foreground" />
    <div className="min-w-0 flex-1"><strong className="block truncate text-sm">{node.title}</strong><span className="block truncate text-[11px] text-muted-foreground">{[mapTitle, ...path].join(' / ')}</span></div>
    <MasteryBadge status={node.status} />
    <div className="flex gap-1">
      {aggregate.data?.figure && <Button size="sm" variant="ghost" onClick={() => showLearningFigure(part.mapId, node.id)}><MapIcon />{t('learningCard.inFigure')}</Button>}
      <Button size="sm" variant="ghost" onClick={() => navigateLearning(learningHash({ mapId: part.mapId, nodeId: node.id }))}>{t('studyTopic.openNote')}</Button>
    </div>
  </Surface>;
}
