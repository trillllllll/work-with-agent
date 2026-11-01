import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Map as MapIcon, Plus, X } from 'lucide-react';
import { api } from '@/lib/api.js';
import { askAssistant, contextLabel } from '@/lib/assistant-context.js';
import { learningHash } from '@/lib/learning-navigation.js';
import { useEditorRuntime } from '@/lib/task-editor-runtime.js';
import { Button } from '@/components/ui/button.js';
import { ActionMenu, ActionMenuItem } from '@/components/ui/action-menu.js';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover.js';
import { LearningFigure } from '@/components/learning/LearningFigure.js';
import { MasteryBadge } from '@/components/learning/MasteryDisplay.js';
import { flattenTree, type LearningMapAggregate, type LearningMapSummary } from '@/components/learning/learning-model.js';
import { isFigureShortcut } from './study-shortcuts.js';
import { LEARNING_FIGURE_EVENT, navigateLearning } from './learning-events.js';

/** Topic switcher and the 学习主图 sheet for the study assistant. The figure is one keystroke (M) away while learning. */
export function StudyTopicBar({ topicId, focusNodeId, disabled, onSelectTopic, onNewTopic, onOpenNode, onAsk }: {
  topicId: string; focusNodeId?: string; disabled?: boolean;
  onSelectTopic: (mapId: string) => void; onNewTopic: () => void; onOpenNode: (hash: string) => void; onAsk: (prompt: string) => void;
}) {
  const { t } = useTranslation('chat');
  const scope = useEditorRuntime()?.scopeKey;
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState('');
  const figureButton = useRef<HTMLButtonElement>(null);
  const maps = useQuery({ queryKey: ['learning-maps', scope], queryFn: () => api<{ maps: LearningMapSummary[] }>('/api/v1/learning/maps') });
  const current = maps.data?.maps.find(map => map.id === topicId);
  const aggregate = useQuery({ queryKey: ['learning-map', topicId, scope], enabled: Boolean(current) && open, queryFn: () => api<LearningMapAggregate>(`/api/v1/learning/maps/${encodeURIComponent(topicId)}`) });
  const nodes = useMemo(() => flattenTree(aggregate.data?.tree ?? []), [aggregate.data]);
  const figure = aggregate.data?.figure;
  const node = nodes.find(item => item.id === picked && item.kind === 'item');
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (!current || !isFigureShortcut(event)) return; event.preventDefault(); setPicked(''); setOpen(value => !value); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [current]);
  useEffect(() => { setOpen(false); setPicked(''); }, [topicId]);
  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent<{ mapId?: string; nodeId?: string }>).detail;
      if (!detail?.mapId) return;
      if (detail.mapId !== topicId) { navigateLearning(learningHash({ mapId: detail.mapId, nodeId: detail.nodeId, tab: 'figure' })); return; }
      setPicked(detail.nodeId ?? ''); setOpen(true);
    };
    window.addEventListener(LEARNING_FIGURE_EVENT, show);
    return () => window.removeEventListener(LEARNING_FIGURE_EVENT, show);
  }, [topicId]);
  const askFigure = (key: 'figure.askDraw' | 'figure.askUpdate') => {
    if (!current) return;
    setOpen(false);
    askAssistant({ kind: 'draft', title: contextLabel(current.title), text: `${current.title}\n${current.goal}`, learningMapId: current.id, learningRevision: current.revision, unsaved: false }, { prompt: t(key) });
  };
  const missing = (figure?.missingNodeIds.length ?? 0) + (figure?.removedNodeIds.length ?? 0);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverAnchor asChild><div className="study-topic-bar flex shrink-0 items-center gap-1 border-b px-3 py-1.5" data-testid="study-topic-bar">
      <ActionMenu open={menu} onOpenChange={setMenu} trigger={<Button variant="ghost" size="sm" className="h-8 min-w-0 max-w-[60%] gap-1 px-2 font-medium" disabled={disabled} aria-label={t('studyTopic.switch')} title={t('studyTopic.switch')}>
        <span className="truncate">{current?.title ?? t('studyTopic.none')}</span><ChevronDown className="size-3.5 shrink-0" />
      </Button>}>
        {maps.data?.maps.map(map => <ActionMenuItem key={map.id} onSelect={() => onSelectTopic(map.id)}>
          <span className="min-w-0 flex-1 truncate">{map.title}</span><span className="text-xs text-muted-foreground">{map.stats.itemsDone}/{map.stats.items}</span>{map.id === topicId && <Check />}
        </ActionMenuItem>)}
        <ActionMenuItem onSelect={onNewTopic}><Plus />{t('studyTopic.new')}</ActionMenuItem>
      </ActionMenu>
      <Button ref={figureButton} variant="ghost" size="sm" className="min-h-11 gap-1 px-2" disabled={!current} aria-expanded={open} aria-haspopup="dialog" aria-keyshortcuts="M" title={t('studyTopic.figureShortcut')} onClick={() => { setPicked(''); setOpen(value => !value); }}>
        <MapIcon />{t('studyTopic.figure')}<kbd className="study-topic-kbd">M</kbd>
      </Button>
    </div></PopoverAnchor>
    <PopoverContent data-assistant-floating align="start" onCloseAutoFocus={event => { event.preventDefault(); if (document.activeElement === document.body || !document.activeElement?.isConnected) figureButton.current?.focus(); }} className="w-[min(640px,calc(100vw-1.5rem))] max-h-[min(70dvh,560px)] overflow-y-auto p-3" aria-label={t('studyTopic.figureOf', { title: current?.title ?? '' })} data-testid="study-figure-sheet">
      <div className="mb-2 flex items-center gap-2"><h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('studyTopic.figureOf', { title: current?.title ?? '' })}</h3><Button variant="ghost" size="icon-sm" aria-label={t('learningCard.collapse')} onClick={() => setOpen(false)}><X /></Button></div>
      {aggregate.isLoading ? <p role="status" className="py-6 text-center text-xs text-muted-foreground">{t('studyTopic.loading')}</p>
        : aggregate.isError ? <div role="alert"><p className="text-xs">{aggregate.error.message}</p><Button variant="outline" onClick={() => void aggregate.refetch()}>{t('retry')}</Button></div>
        : !figure ? <div className="space-y-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground"><p>{t('studyTopic.noFigure')}</p><Button size="sm" variant="outline" onClick={() => askFigure('figure.askDraw')}>{t('studyTopic.drawFigure')}</Button></div>
          : <>
            {figure.stale && <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-warning-bg/70 px-3 py-2 text-xs" role="status" data-testid="figure-stale"><span className="flex-1">{t('studyTopic.stale', { count: missing })}</span><Button size="xs" variant="outline" onClick={() => askFigure('figure.askUpdate')}>{t('studyTopic.updateFigure')}</Button></div>}
            <LearningFigure svg={figure.svg} nodes={nodes} currentId={focusNodeId} selectedId={picked} onPick={setPicked} label={t('studyTopic.figureOf', { title: current?.title ?? '' })} />
            {node ? <div className="mt-2 space-y-2 rounded-lg bg-muted/60 p-3 text-sm" data-testid="figure-node-detail">
              <div className="flex items-center gap-2"><strong className="min-w-0 flex-1 truncate">{node.title}</strong><MasteryBadge status={node.status} /></div>
              <p className="line-clamp-2 text-xs text-muted-foreground">{node.detail.replace(/[#*`>_-]/g, '').trim().slice(0, 160) || t('studyTopic.noNote')}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => { setOpen(false); onOpenNode(learningHash({ mapId: topicId, nodeId: node.id })); }}>{t('studyTopic.openNote')}</Button>
                <Button size="sm" variant="outline" onClick={() => { setOpen(false); onAsk(t('studyTopic.askNode', { title: node.title })); }}>{t('studyTopic.askAssistant')}</Button>
              </div>
            </div> : <p className="mt-2 text-[11px] text-muted-foreground">{t('studyTopic.shortcutHint')}</p>}
          </>}
    </PopoverContent>
  </Popover>;
}
