import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';
import { api } from '@/lib/api.js';
import { usePageContext } from '@/lib/assistant-context.js';
import { Button } from '@/components/ui/button.js';
import { Skeleton } from '@/components/ui/skeleton.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { GraduationCap, Map as MapIcon } from 'lucide-react';
import { intlLocale } from '@/i18n/index.js';

type LearningMapSummary = {
  id: string; title: string; goal: string; status: string; revision: number; updatedAt: string;
  stats: { topics: number; items: number; itemsDone: number; averageMastery: number | null };
};
type LearningTreeNode = {
  id: string; mapId: string; parentId: string | null; kind: string; title: string;
  detail: string; status: string; mastery: number; sortOrder: number; revision: number;
  children: LearningTreeNode[];
};
type LearningActivityRow = { id: string; nodeId: string | null; kind: string; content: string; createdAt: string };
type LearningMapAggregate = {
  map: { id: string; title: string; goal: string; status: string; revision: number; updatedAt: string };
  tree: LearningTreeNode[];
  stats: { topics: number; items: number; itemsDone: number; itemsLearning: number; averageMastery: number | null };
  recentActivity: LearningActivityRow[];
};
type ChartNode = { name: string; value: number; nodeId: string; itemStyle: { color: string; borderColor: string }; label: { color: string }; children: ChartNode[] };

function toChartNode(node: LearningTreeNode, dark: boolean, statusDone: string): ChartNode {
  const hue = Math.round(node.mastery * 1.2);
  const color = node.status === statusDone ? `hsl(150 45% ${dark ? 38 : 40}%)` : node.kind === 'item' ? `hsl(${hue} 42% ${dark ? 42 : 44}%)` : dark ? '#416e85' : '#a9c3ce';
  return {
    name: node.title,
    value: node.mastery,
    nodeId: node.id,
    itemStyle: { color, borderColor: dark ? '#1f2937' : '#ffffff' },
    label: { color: dark ? '#d4d4d4' : '#343434' },
    children: node.children.map((child) => toChartNode(child, dark, statusDone)),
  };
}

function findNode(tree: LearningTreeNode[], nodeId: string): LearningTreeNode | null {
  for (const node of tree) {
    if (node.id === nodeId) return node;
    const found = findNode(node.children, nodeId);
    if (found) return found;
  }
  return null;
}

function LearningTreeChart({ data, dark, onSelect, selectedNodeId }: { data: LearningTreeNode[]; dark: boolean; onSelect: (nodeId: string) => void; selectedNodeId: string }) {
  const { t } = useTranslation('learning');
  const host = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const chartData = useMemo(() => data.map((node) => toChartNode(node, dark, 'done')), [data, dark]);
  useEffect(() => {
    let disposed = false;
    let chart: EChartsType | undefined;
    let observer: ResizeObserver | undefined;
    void (async () => {
      const [core, charts, components, renderers] = await Promise.all([import('echarts/core'), import('echarts/charts'), import('echarts/components'), import('echarts/renderers')]);
      if (disposed || !host.current) return;
      core.use([charts.TreeChart, components.TooltipComponent, renderers.CanvasRenderer]);
      chart = core.init(host.current);
      chart.on('click', (params) => {
        const nodeId = (params.data as { nodeId?: string } | undefined)?.nodeId;
        if (nodeId) selectRef.current(nodeId);
      });
      chart.setOption({
        backgroundColor: 'transparent',
        animation: !matchMedia('(prefers-reduced-motion: reduce)').matches,
        tooltip: { trigger: 'item', renderMode: 'richText', formatter: (params: { data: ChartNode }) => `${params.data.name}<br/>${t('chart.mastery')}: ${params.data.value}` },
        series: [{
          type: 'tree',
          data: chartData,
          layout: 'orthogonal',
          orient: 'LR',
          roam: true,
          expandAndCollapse: true,
          initialTreeDepth: 2,
          symbol: 'circle',
          symbolSize: (value: number) => 10 + Math.round(value / 12),
          itemStyle: { borderWidth: 1.5 },
          lineStyle: { color: dark ? '#3f3f46' : '#d4d4d8', width: 1.5 },
          label: { position: 'top', distance: 6, fontSize: 12, color: dark ? '#d4d4d4' : '#343434' },
          leaves: { label: { position: 'right', distance: 8, align: 'left' } },
          emphasis: { focus: 'descendant' },
        }],
      } as EChartsCoreOption);
      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(host.current);
    })().catch(() => { /* echarts 加载失败时详情面板仍然可用 */ });
    return () => { disposed = true; observer?.disconnect(); chart?.dispose(); };
  }, [chartData, dark, t]);
  return <div ref={host} role="img" aria-label={t('chart.label')} data-selected={selectedNodeId || undefined} className="h-[min(62dvh,540px)] w-full" />;
}

export function LearningMapPage({ onAskAssistant }: { onAskAssistant?: () => void }) {
  const { t } = useTranslation('learning');
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === 'dark';
  const mapsQuery = useQuery({ queryKey: ['learning-maps'], queryFn: () => api<{ maps: LearningMapSummary[] }>('/api/v1/learning/maps') });
  const maps = mapsQuery.data?.maps ?? [];
  const [selectedMapId, setSelectedMapId] = useState('');
  const activeMapId = selectedMapId || maps[0]?.id || '';
  const mapQuery = useQuery({ queryKey: ['learning-map', activeMapId], enabled: Boolean(activeMapId), queryFn: () => api<LearningMapAggregate>(`/api/v1/learning/maps/${encodeURIComponent(activeMapId)}`) });
  const [selectedNodeId, setSelectedNodeId] = useState('');
  usePageContext('learning', { pageState: { selectedId: selectedNodeId || undefined } });
  useEffect(() => { setSelectedNodeId(''); }, [activeMapId]);
  const aggregate = mapQuery.data;
  const selectedNode = useMemo(() => (aggregate && selectedNodeId ? findNode(aggregate.tree, selectedNodeId) : null), [aggregate, selectedNodeId]);
  const nodeActivity = useMemo(() => {
    if (!aggregate) return [];
    return selectedNodeId ? aggregate.recentActivity.filter((item) => item.nodeId === selectedNodeId) : aggregate.recentActivity;
  }, [aggregate, selectedNodeId]);

  if (mapsQuery.isLoading) return <div className="space-y-4 p-5 sm:p-7"><Skeleton className="h-8 w-56" /><Skeleton className="h-64 w-full" /></div>;
  if (mapsQuery.isError) return <div className="p-5 sm:p-7"><p role="alert" className="text-sm text-destructive">{t('loadFailed')}</p></div>;
  if (!maps.length) return <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 p-6 text-center">
    <MapIcon className="size-10 text-muted-foreground" aria-hidden="true" />
    <h1 className="text-xl font-semibold">{t('empty.title')}</h1>
    <p className="max-w-md text-sm text-muted-foreground">{t('empty.hint')}</p>
    {onAskAssistant && <Button className="mt-2" onClick={onAskAssistant}><GraduationCap aria-hidden="true" />{t('askAssistant')}</Button>}
  </div>;

  const activeSummary = maps.find((item) => item.id === activeMapId);
  const stats = aggregate?.stats ?? activeSummary?.stats;

  return <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6">
    <header className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{activeSummary?.goal || t('defaultGoal')}</p>
      </div>
      {maps.length > 1 && <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t('selectMap')}</span>
        <Select value={activeMapId} onValueChange={setSelectedMapId}>
          <SelectTrigger type="button" size="sm" className="h-7 text-xs" aria-label={t('selectMap')}><SelectValue /></SelectTrigger>
          <SelectContent>{maps.map((item) => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent>
        </Select>
      </div>}
      {onAskAssistant && <Button variant="outline" onClick={onAskAssistant}><GraduationCap aria-hidden="true" />{t('askAssistant')}</Button>}
    </header>
    {stats && <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground" role="status">
      <span>{t('stats.topics')}: <span className="font-medium text-foreground">{stats.topics}</span></span>
      <span>{t('stats.items')}: <span className="font-medium text-foreground">{stats.items}</span></span>
      <span>{t('stats.done')}: <span className="font-medium text-foreground">{stats.itemsDone}</span></span>
      {stats.averageMastery !== null && stats.averageMastery !== undefined && <span>{t('stats.mastery')}: <span className="font-medium text-foreground">{stats.averageMastery}</span></span>}
    </div>}
    <div className="flex min-h-0 flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1 overflow-hidden rounded-xl border">
        {mapQuery.isLoading ? <Skeleton className="h-[min(62dvh,540px)] w-full" /> : mapQuery.isError ? <p role="alert" className="p-4 text-sm text-destructive">{t('loadFailed')}</p> : <LearningTreeChart data={aggregate?.tree ?? []} dark={dark} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} />}
      </div>
      <aside className="w-full shrink-0 space-y-3 lg:w-72" aria-label={t('detail.panel')}>
        {selectedNode ? <section className="rounded-xl border p-3">
          <h2 className="text-sm font-semibold">{selectedNode.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t(`kind.${selectedNode.kind}`)} · {t(`status.${selectedNode.status}`)} · {t('detail.mastery')}: {selectedNode.mastery}</p>
          {selectedNode.detail && <p className="mt-2 whitespace-pre-wrap text-xs">{selectedNode.detail}</p>}
        </section> : <section className="rounded-xl border p-3">
          <h2 className="text-sm font-semibold">{t('detail.panel')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('detail.empty')}</p>
        </section>}
        <section className="rounded-xl border p-3">
          <h2 className="text-sm font-semibold">{t('activity.title')}</h2>
          <ul className="mt-2 space-y-2">
            {nodeActivity.slice(0, 8).map((item) => <li key={item.id} className="text-xs">
              <span className="text-muted-foreground">{new Date(item.createdAt).toLocaleString(intlLocale())} · {t(`activity.${item.kind}`, { defaultValue: item.kind })}</span>
              <p className="mt-0.5 whitespace-pre-wrap">{item.content}</p>
            </li>)}
            {!nodeActivity.length && <li className="text-xs text-muted-foreground">{t('activity.empty')}</li>}
          </ul>
        </section>
      </aside>
    </div>
  </div>;
}
