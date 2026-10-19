import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTheme } from 'next-themes';
import DOMPurify from 'dompurify';
import { Code, Copy, Download, Maximize2, Minus, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import type { ContentBlock } from '@/lib/message-blocks.js';
import type { ChartSpec, ImageResult } from '../../../../server/src/agent/content-blocks.js';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';

export function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function savePng(svg: string, name: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image(); img.src = url; await img.decode();
    const canvas = document.createElement('canvas');
    const scale = Math.min(2, 4096 / Math.max(img.naturalWidth || 800, img.naturalHeight || 500));
    canvas.width = Math.ceil((img.naturalWidth || 800) * scale); canvas.height = Math.ceil((img.naturalHeight || 500) * scale);
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('无法创建导出画布');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('导出失败')), 'image/png'));
    save(blob, name);
  } finally { URL.revokeObjectURL(url); }
}
function useSvg(block: ContentBlock, dark: boolean) {
  const [svg, setSvg] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setSvg(''); setError('');
    void (async () => {
      let source = block.source || '';
      if (block.type === 'mermaid') {
        if (!/^\s*(flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram)\b/.test(source) || /%%\{|^\s*---|\bclick\b|https?:\/\//im.test(source)) throw new Error('图形含有不支持的语法或交互');
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', htmlLabels: false, flowchart: { htmlLabels: false }, maxTextSize: 16384, maxEdges: 200, suppressErrorRendering: true });
        const result = await mermaid.render(`diagram-${crypto.randomUUID()}`, source);
        source = result.svg;
      }
      const clean = DOMPurify.sanitize(source, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'script', 'a', 'image', 'animate', 'set'], FORBID_ATTR: ['href', 'xlink:href', 'onload', 'onclick'] });
      if (!clean.includes('<svg')) throw new Error('SVG 内容无效');
      if (!cancelled) setSvg(clean);
    })().catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : '图形渲染失败'); });
    return () => { cancelled = true; };
  }, [block.source, block.type, dark]);
  const [url, setUrl] = useState('');
  useEffect(() => { if (!svg) { setUrl(''); return; } const next = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); setUrl(next); return () => URL.revokeObjectURL(next); }, [svg]);
  return { svg, url, error };
}
function chartOption(spec: ChartSpec, dark: boolean): EChartsCoreOption {
  const colors = dark ? ['#a9c3ce', '#d6b98c', '#acc5a6', '#c3add5'] : ['#416e85', '#a77634', '#5a8050', '#805ca1'];
  const common = { color: colors, backgroundColor: 'transparent', textStyle: { color: dark ? '#d4d4d4' : '#343434' }, animation: !matchMedia('(prefers-reduced-motion: reduce)').matches,
    tooltip: { trigger: spec.kind === 'line' || spec.kind === 'bar' ? 'axis' : 'item', renderMode: 'richText' }, legend: { top: 4, textStyle: { color: dark ? '#aaa' : '#666' } } };
  if (spec.kind === 'pie') return { ...common, series: [{ type: 'pie', radius: ['25%', '65%'], center: ['50%', '55%'], data: spec.values }] } as EChartsCoreOption;
  if (spec.kind === 'scatter') return { ...common, xAxis: { type: 'value' }, yAxis: { type: 'value' }, grid: { top: 44, bottom: 35, left: 50, right: 20 }, series: spec.series.map((row) => ({ name: row.name, type: 'scatter', data: row.values })) } as EChartsCoreOption;
  return { ...common, grid: { top: 44, bottom: 45, left: 50, right: 20 }, xAxis: { type: 'category', data: spec.categories, axisLabel: { hideOverlap: true } }, yAxis: { type: 'value', name: spec.unit || '' }, series: spec.series.map((row) => ({ name: row.name, type: spec.kind, data: row.values, connectNulls: false })) } as EChartsCoreOption;
}
function Chart({ spec, dark, onReady, large = false }: { spec: ChartSpec; dark: boolean; onReady?: (chart: EChartsType | null) => void; large?: boolean }) {
  const host = useRef<HTMLDivElement>(null); const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false; let chart: EChartsType | undefined; let observer: ResizeObserver | undefined;
    void (async () => {
      const [core, charts, components, renderers] = await Promise.all([import('echarts/core'), import('echarts/charts'), import('echarts/components'), import('echarts/renderers')]);
      if (disposed || !host.current) return;
      core.use([charts.LineChart, charts.BarChart, charts.PieChart, charts.ScatterChart, components.GridComponent, components.TooltipComponent, components.LegendComponent, renderers.CanvasRenderer]);
      chart = core.init(host.current); chart.setOption(chartOption(spec, dark)); onReady?.(chart);
      observer = new ResizeObserver(() => chart?.resize()); observer.observe(host.current);
    })().catch((reason) => setError(reason instanceof Error ? reason.message : '图表加载失败'));
    return () => { disposed = true; observer?.disconnect(); onReady?.(null); chart?.dispose(); };
  }, [spec, dark, onReady]);
  return error ? <p role="alert">{error}</p> : <div ref={host} role="img" aria-label={`${spec.title}，${spec.provenance.label}`} className={large ? 'h-[min(60dvh,480px)] w-full' : 'h-72 w-full'} />;
}
function ImageGallery({ items, layout = 'grid' }: { items: ImageResult[]; layout?: ContentBlock['layout'] }) {
  const [position, setPosition] = useState(0); const [preview, setPreview] = useState<ImageResult | null>(null); const [failed, setFailed] = useState<Set<string>>(new Set());
  const visible = layout === 'carousel' ? items.slice(position, position + 1) : layout === 'single' ? items.slice(0, 1) : items;
  return <><div className={layout === 'grid' ? 'grid grid-cols-2 gap-3 p-3' : 'p-3'}>{visible.map((item) => <figure key={item.id} className="min-w-0"><button type="button" onClick={() => setPreview(item)} className="flex min-h-28 w-full items-center justify-center overflow-hidden rounded-lg border bg-muted/30" aria-label={`查看图片：${item.title}`}>{failed.has(item.id) ? <span className="p-4 text-xs text-muted-foreground">图片已失效，可查看来源</span> : <img src={item.thumbnail} alt={item.title} loading="lazy" referrerPolicy="no-referrer" className="max-h-64 w-full object-contain" onError={() => setFailed((current) => new Set([...current, item.id]))} />}</button><figcaption className="mt-1 truncate text-[11px] text-muted-foreground"><a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">{item.title} · 来源 ↗</a></figcaption></figure>)}</div>{layout === 'carousel' && <div className="flex items-center justify-center gap-3 pb-3"><Button size="sm" variant="ghost" disabled={!position} onClick={() => setPosition((value) => value - 1)}>上一张</Button><span className="text-xs">{position + 1} / {items.length}</span><Button size="sm" variant="ghost" disabled={position >= items.length - 1} onClick={() => setPosition((value) => value + 1)}>下一张</Button></div>}
    <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open) setPreview(null); }}><DialogContent data-assistant-floating className="max-w-[min(900px,calc(100vw-2rem))]"><DialogHeader><DialogTitle>{preview?.title}</DialogTitle></DialogHeader>{preview && <><img src={preview.url} alt={preview.title} referrerPolicy="no-referrer" className="max-h-[65dvh] w-full object-contain" onError={() => toast.error('原图加载失败，请查看来源')} /><a className="text-sm underline" href={preview.sourceUrl} target="_blank" rel="noopener noreferrer">查看图片来源</a></>}</DialogContent></Dialog>
  </>;
}
export function VisualFrame({ title, children, actions, source, caption }: { title: string; children: ReactNode; actions?: ReactNode; source: string; caption?: string }) {
  const [showSource, setShowSource] = useState(false);
  return <section className="overflow-hidden rounded-xl border bg-muted/10"><header className="flex min-w-0 flex-wrap items-center gap-1 border-b px-3 py-2"><h3 className="min-w-20 flex-1 text-xs font-medium">{title}</h3><Button size="icon-xs" variant="ghost" title="查看源码" aria-label="查看源码" aria-pressed={showSource} onClick={() => setShowSource((value) => !value)}><Code /></Button><Button size="icon-xs" variant="ghost" title="复制源码" aria-label="复制源码" onClick={() => void navigator.clipboard.writeText(source).then(() => toast.success('已复制源码'), () => toast.error('复制失败'))}><Copy /></Button>{actions}</header>{showSource ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-4 text-xs">{source}</pre> : children}{caption && <p className="border-t px-3 py-2 text-[10px] text-muted-foreground">{caption}</p>}</section>;
}
export default memo(function VisualizationBlock({ block }: { block: ContentBlock }) {
  const { resolvedTheme } = useTheme(); const dark = resolvedTheme === 'dark';
  const graphic = block.type === 'mermaid' || block.type === 'svg';
  // Non-graphic blocks do not import or invoke Mermaid.
  const graphicBlock = graphic ? block : { ...block, source: '', type: 'pending' as const };
  const { svg, url, error } = useSvg(graphicBlock, dark);
  const [large, setLarge] = useState(false); const [zoom, setZoom] = useState(1);
  const chartRef = useRef<EChartsType | null>(null); const largeChartRef = useRef<EChartsType | null>(null);
  const title = block.title || block.spec?.title || ({ mermaid: '流程与关系', svg: '图示', chart: '数据图表', image_search: '图片搜索' } as Record<string, string>)[block.type] || '可视化';
  const source = block.source || JSON.stringify(block.spec || block.items || {}, null, 2);
  const exported = async (png: boolean) => {
    try {
      if (block.type === 'chart') {
        const chart = large ? largeChartRef.current : chartRef.current;
        if (!chart) throw new Error('图表尚未准备好');
        const response = await fetch(chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: dark ? '#222222' : '#ffffff' })); save(await response.blob(), 'chart.png');
      } else if (svg) { if (png) await savePng(svg, 'diagram.png'); else save(new Blob([svg], { type: 'image/svg+xml' }), 'diagram.svg'); }
      else throw new Error('图形尚未准备好');
      toast.success('已导出');
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : '导出失败'); }
  };
  const preview = (enlarged: boolean) => graphic ? error ? <p role="alert" className="p-4 text-xs text-destructive">图形无法显示：{error}。可查看源码。</p> : url ? <div className="overflow-auto p-4"><img src={url} alt={block.alt || title} className="mx-auto h-auto max-h-[50dvh] w-full" style={enlarged ? { minWidth: `${zoom * 100}%`, maxHeight: 'none' } : undefined} /></div> : <p role="status" className="p-4 text-xs text-muted-foreground">正在渲染图形…</p> : null;
  // Stable callbacks keep chart instances alive while surrounding text streams.
  const mainReady = useRef((chart: EChartsType | null) => { chartRef.current = chart; }).current;
  const expandedReady = useRef((chart: EChartsType | null) => { largeChartRef.current = chart; }).current;
  const renderPreview = (expanded: boolean) => block.type === 'chart' && block.spec ? <Chart spec={block.spec} dark={dark} large={expanded} onReady={expanded ? expandedReady : mainReady} /> : preview(expanded);
  return <VisualFrame title={title} source={source} caption={block.spec ? `${block.spec.provenance.kind === 'simulated' ? '模拟数据' : block.spec.provenance.kind === 'tool' ? '已核验工具数据' : '来源未验证'} · ${block.spec.provenance.label}` : block.type === 'image_search' ? '真实搜索结果 · 点击来源查看原网页' : block.alt} actions={block.type !== 'image_search' && <><Button size="icon-xs" variant="ghost" title="放大查看" aria-label="放大查看" onClick={() => { setZoom(1); setLarge(true); }}><Maximize2 /></Button><Button size="icon-xs" variant="ghost" title="导出 PNG" aria-label="导出 PNG" onClick={() => void exported(true)}><Download /></Button>{graphic && <Button size="xs" variant="ghost" onClick={() => void exported(false)}>SVG</Button>}</>}>
    {block.type === 'image_search' ? <ImageGallery items={block.items ?? []} layout={block.layout} /> : renderPreview(false)}
    <Dialog open={large} onOpenChange={setLarge}><DialogContent data-assistant-floating className="max-w-[min(1000px,calc(100vw-2rem))]"><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>{graphic && <div className="flex items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label="缩小图形" disabled={zoom <= 0.5} onClick={() => setZoom((value) => value - .25)}><Minus /></Button><span className="text-xs">{Math.round(zoom * 100)}%</span><Button variant="ghost" size="icon-sm" aria-label="放大图形" disabled={zoom >= 3} onClick={() => setZoom((value) => value + .25)}><Plus /></Button></div>}<div className="max-h-[65dvh] overflow-auto">{renderPreview(true)}</div><Button variant="outline" size="sm" onClick={() => void exported(true)}>导出 PNG</Button></DialogContent></Dialog>
  </VisualFrame>;
});
