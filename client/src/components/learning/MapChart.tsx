import { useEffect, useRef, type MutableRefObject } from 'react';
import * as echarts from 'echarts/core';
import { TreeChart } from 'echarts/charts';
import { TooltipComponent, AriaComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { useTranslation } from 'react-i18next';
import type { LearningMap, LearningNode } from './learning-model.js';
import { getMastery, masterySummary } from './learning-model.js';
echarts.use([TreeChart, TooltipComponent, AriaComponent, SVGRenderer]);
export type ViewState = { collapsed: Record<string, boolean>; zoom: number; center: unknown; command: number; scrollLeft?: number };
export type ChartCommand = { kind: 'fit' | 'expand' | 'collapse'; counter: number };
type Props = { map: LearningMap; nodes: LearningNode[]; dark: boolean; views: MutableRefObject<Record<string, ViewState>>; command: ChartCommand; onOpen: (id: string) => void; mobile?: boolean; focusId?: string };
function roundedSymbol(w: number, h: number) {
  const r = 7;
  return `path://M${r},0H${w-r}Q${w},0 ${w},${r}V${h-r}Q${w},${h} ${w-r},${h}H${r}Q0,${h} 0,${h-r}V${r}Q0,0 ${r},0Z`;
}
type ChartNode = { name: string; id: string; nodeId?: string; kind: string; collapsed?: boolean; symbol: string; symbolSize: number[]; label: object; itemStyle: object; emphasis?: object; children: ChartNode[] };
export function MapChart({ map, nodes, dark, views, command, onOpen, mobile = false, focusId }: Props) {
  const { t } = useTranslation('learning');
  const host = useRef<HTMLDivElement>(null);
  const open = useRef(onOpen); open.current = onOpen;
  useEffect(() => {
    const element = host.current!;
    const viewport = element.parentElement!;
    const instance = echarts.init(element, undefined, { renderer: 'svg' });
    const focus = nodes.find(n => n.id === focusId && n.kind === 'topic');
    const viewKey = map.id + (mobile ? '/mobile/' : '/desktop/') + (focus?.id ?? 'root');
    const state = views.current[viewKey] ??= { collapsed: {}, zoom: 1, center: null, command: command.counter };
    let frame = 0;
    const capture = () => {
      const series = (instance.getOption() as { series?: Array<{ zoom?: number; center?: unknown }> }).series?.[0];
      if (series) { state.zoom = series.zoom ?? 1; state.center = series.center ?? null; if (viewport.isConnected) state.scrollLeft = viewport.scrollLeft; element.dataset.zoom = String(state.zoom); element.dataset.center = JSON.stringify(state.center); }
    };
    const draw = () => {
      const width = viewport.clientWidth;
      if (width < 80) return;
      const css = getComputedStyle(element);
      const color = css.getPropertyValue('--foreground').trim();
      const line = css.getPropertyValue('--border').trim();
      const paper = css.getPropertyValue('--card').trim();
      const soft = css.getPropertyValue('--muted').trim();
      const accent = css.getPropertyValue('--primary').trim();
      const selected = css.getPropertyValue('--accent').trim();
      const fontFamily = css.fontFamily;
      const textHeight = (text: string, width: number, fontWeight: number = 400) => new echarts.graphic.Text({ style: {
        text, width, font: `${fontWeight} 13px ${fontFamily}`, lineHeight: 18, overflow: 'break',
      } }).getBoundingRect().height;
      const narrow = width < 520;
      const itemWidth = mobile ? Math.min(180, Math.max(154, width * .5)) : narrow ? 164 : 206;
      const groupWidth = mobile ? 110 : narrow ? 94 : 126;
      const rootWidth = mobile ? 110 : narrow ? 94 : 122;
      const terminalSizes: number[] = [];
      const build = (parent: string | null): ChartNode[] => nodes.filter(n => n.parentId === parent).map(n => {
        const children = build(n.id);
        const collapsed = state.collapsed[n.id] ?? false;
        const w = n.kind === 'item' ? itemWidth : groupWidth;
        const status = getMastery(n);
        const summary = masterySummary(nodes,n.id);
        const title = (n.kind === 'topic' ? (collapsed ? '▸ ' : '▾ ') : '') + n.title;
        const caption = n.kind === 'item' ? status.symbol + ' ' + t('status.' + status.id) : t('progress', summary);
        const label = title + '\n' + caption;
        const h = Math.max(54, textHeight(label, w - 24) + 12);
        terminalSizes.push(h);
        return { id: n.id, name: n.title, nodeId: n.id, kind: n.kind, collapsed,
          symbol: roundedSymbol(w, h), symbolSize: [w, h],
          label: { position: 'inside', formatter: label, color, fontSize: 13, fontFamily, width: w - 24, overflow: 'break', lineHeight: 18, padding: 0 },
          itemStyle: { color: n.kind === 'item' ? css.getPropertyValue(status.fill).trim() || paper : soft, borderColor: n.kind === 'item' ? css.getPropertyValue(status.border).trim() || line : line, borderWidth: 1.2, shadowBlur: 0 },
          emphasis: { itemStyle: { color: selected, borderColor: accent, borderWidth: 1.6 } }, children };
      });
      const rootSummary = masterySummary(nodes);
      const rootHeight = Math.max(54, textHeight(map.title + '\n' + t('progress', rootSummary), rootWidth - 22, 500) + 12);
      let tree: ChartNode;
      if (focus) tree = build(focus.parentId).find(n => n.id === focus.id)!;
      else tree = { name: map.title, id: map.id, kind: 'root', collapsed: false,
        symbol: roundedSymbol(rootWidth, rootHeight), symbolSize: [rootWidth, rootHeight],
        label: { position: 'inside', formatter: map.title+'\n'+t('progress', rootSummary), color, fontWeight: 500, fontSize: 13, fontFamily, width: rootWidth - 22, overflow: 'break', lineHeight: 18 },
        itemStyle: { color: soft, borderColor: line, borderWidth: 1.2 }, children: build(null) };
      const terminalParents: string[] = [];
      const collectTerminals = (node: ChartNode, parent: string) => {
        if (node.collapsed || !node.children.length) terminalParents.push(parent);
        else node.children.forEach(child => collectTerminals(child, node.id));
      };
      collectTerminals(tree, 'root');
      // ECharts gives non-sibling branches twice the sibling spacing.
      const boundarySlots = terminalParents.slice(1).filter((parent, i) => parent !== terminalParents[i]).length;
      const outerSlot = terminalParents[0] !== terminalParents[terminalParents.length - 1] ? 1 : 0;
      const spacing = Math.max(44, focus ? 0 : rootHeight, ...terminalSizes) + 10;
      const height = Math.max(focus ? 0 : rootHeight + 24, mobile ? 236 : 220, (terminalParents.length + boundarySlots + outerSlot) * spacing + 24);
      const depth = (node: ChartNode): number => node.collapsed || !node.children.length ? 0 : 1 + Math.max(...node.children.map(depth));
      const levels = Math.max(1, depth(tree));
      const leftEdge = (focus ? groupWidth : rootWidth) / 2 + 13;
      const rightEdge = Math.max(itemWidth, groupWidth) / 2 + 13;
      // Preserve readable target sizes for deep trees. The viewport scrolls instead of squeezing columns together.
      const step = mobile ? Math.max(groupWidth, (groupWidth + itemWidth) / 2) + 18 : Math.max(rootWidth, groupWidth, itemWidth) + 24;
      const canvasWidth = Math.max(width, leftEdge + rightEdge + levels * step);
      if (element.style.width !== canvasWidth + 'px' || element.style.height !== height + 'px') {
        element.style.width = canvasWidth + 'px'; element.style.height = height + 'px'; instance.resize();
      }
      const plotWidth = Math.min(canvasWidth - leftEdge - rightEdge, levels * 218);
      const left = leftEdge + Math.max(0, (canvasWidth - leftEdge - rightEdge - plotWidth) / 2);
      instance.setOption({ animation: !matchMedia('(prefers-reduced-motion: reduce)').matches,
        animationDuration: 160, animationDurationUpdate: 200,
        aria: { enabled: true, description: t('chart.description', { title: map.title }) },
        tooltip: { trigger: 'item', renderMode: 'richText', formatter: (p: unknown) => {
          const d = (p as { data: { name: string; kind: string; nodeId?: string } }).data;
          const source = nodes.find(n=>n.id===d.nodeId);
          if(source?.kind==='item')return d.name+'\n'+t('status.'+getMastery(source).id)+' · '+t('openNote');
          return d.name + '\n' + (d.kind === 'item' ? t('openNote') : d.kind === 'root' ? t('topic') : t('toggleGroup'));
        } },
        series: [{ id: map.id, type: 'tree', data: [tree], layout: 'orthogonal', orient: 'LR',
          top: 12, bottom: 12, left, width: plotWidth,
          roam: mobile ? 'move' : true, roamTrigger: 'global', scaleLimit: { min: .55, max: 2 },
          expandAndCollapse: false, initialTreeDepth: -1, zoom: state.zoom, center: state.center,
          lineStyle: { color: line, width: 1.6, curveness: .3 }, edgeShape: 'curve',
          emphasis: { focus: 'self', scale: false }, symbolKeepAspect: false,
          label: { position: 'inside' }, leaves: { label: { position: 'inside' } } }],
      } as echarts.EChartsCoreOption, { notMerge: true });
      element.dataset.chartReady = 'true'; element.dataset.zoom = String(state.zoom);
      element.dataset.collapsed = JSON.stringify(state.collapsed); element.dataset.focus = focus?.id ?? '';
    };
    instance.on('click', p => {
      const d = p.data as { nodeId?: string; kind?: string };
      if (d.kind === 'item' && d.nodeId) { capture(); open.current(d.nodeId); }
      else if (d.kind === 'topic' && d.nodeId) { capture(); state.collapsed[d.nodeId] = !state.collapsed[d.nodeId]; draw(); }
    });
    instance.on('treeroam', () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(capture); });
    const captureScroll = () => { state.scrollLeft = viewport.scrollLeft; };
    viewport.addEventListener('scroll', captureScroll, { passive: true });
    const observer = new ResizeObserver(() => { if (element.clientWidth < 80) return; capture(); instance.resize(); draw(); });
    observer.observe(viewport);
    if (state.command !== command.counter) {
      if (command.kind === 'fit') { state.zoom = 1; state.center = null; state.scrollLeft = 0; }
      else nodes.filter(n => n.kind === 'topic').forEach(n => { state.collapsed[n.id] = command.kind === 'collapse'; });
      state.command = command.counter;
    }
    draw();
    viewport.scrollLeft = state.scrollLeft ?? 0;
    return () => { cancelAnimationFrame(frame); capture(); viewport.removeEventListener('scroll', captureScroll); observer.disconnect(); instance.dispose(); };
  }, [map, nodes, dark, views, command, mobile, focusId, t]);
  return <div className="max-w-full overflow-x-auto"><div ref={host} className="learning-map-chart w-full" data-testid="echarts-tree" role="img" aria-label={t('chart.label', { title: map.title })} /></div>;
}
