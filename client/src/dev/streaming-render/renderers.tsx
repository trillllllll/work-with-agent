// i18n-ignore-file: isolated experiment controls; renderers are shared with the chat.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { MarkdownView } from '@/components/shared/MarkdownView.js';
import { Chart } from '@/components/chat/VisualizationBlock.js';
import { HtmlFrame } from '@/components/chat/HtmlBlock.js';
import { useProgressiveSvg } from '@/lib/use-progressive-svg.js';
import type { ContentBlock } from '@/lib/message-blocks.js';
import type { Kind } from './fixtures.js';
import type { StreamState } from './use-stream.js';
export type Report = (error?: string, phase?: 'complete') => void;
type Props = { state: StreamState; dark: boolean; report: Report };
const Waiting = () => <div className="stream-empty"><span className="stream-empty-mark">↳</span><strong>等待可显示的内容</strong><p>片段完整后，结果会出现在这里。</p></div>;
function Markdown({ state, report }: Props) {
  useEffect(() => { if (state.source) report(); if (state.done) report(undefined, 'complete'); }, [state.source, state.done, report]);
  return state.source ? <div className="stream-markdown"><MarkdownView content={state.source} responsiveTables diagrams streaming={!state.done} /><span className={state.done ? 'stream-caret finished' : 'stream-caret'} /></div> : <Waiting />;
}
function StreamingChart({ state, dark, report }: Props) {
  const spec = useMemo(() => ({ kind: 'bar' as const, title: '一周的进展', categories: state.categories, series: [{ name: '完成任务', values: state.values }], provenance: { kind: 'simulated' as const, label: '演示数据' } }), [state.categories, state.values]);
  const painted = useRef<number[] | null>(null);
  const paint = useCallback(() => { if (!state.values.length) return; painted.current = state.values; report(); if (state.done) report(undefined, 'complete'); }, [state.values, state.done, report]);
  useEffect(() => { if (state.done && painted.current === state.values) report(undefined, 'complete'); }, [state.values, state.done, report]);
  return <div className="stream-chart-wrap" data-points={state.values.length}><Chart spec={spec} dark={dark} onPaint={paint} /></div>;
}
function Diagram({ state, dark, report, kind }: Props & { kind: 'mermaid' | 'svg' }) {
  const result = useProgressiveSvg({ id: 'demo', index: 0, type: kind, source: state.source, status: state.done ? 'ready' : state.interrupted ? 'error' : 'pending' }, dark);
  const loaded = useRef('');
  useEffect(() => { if (result.complete && loaded.current === result.svg) report(undefined, 'complete'); }, [result.complete, result.svg, report]);
  useEffect(() => { if (result.error) report(result.error); }, [result.error, report]);
  return result.url ? <div className="stream-diagram"><img src={result.url} onLoad={() => { loaded.current = result.svg; report(); if (result.complete) report(undefined, 'complete'); }} alt={kind === 'svg' ? '逐步生成的矢量图' : '逐步生成的流程图'} /></div> : <Waiting />;
}
function Html({ state, dark, report }: Props) {
  const block: ContentBlock = { id: 'demo', index: 0, type: 'html', renderMode: 'fragments', source: state.source, status: state.done ? 'ready' : state.interrupted ? 'error' : 'pending' };
  const paint = useCallback((complete: boolean) => { report(); if (complete) report(undefined, 'complete'); }, [report]);
  return <div className="stream-html"><HtmlFrame block={block} cdn={[]} theme={dark ? 'dark' : 'light'} title="实时 HTML 预览" onPaint={paint} /></div>;
}
export function StreamingRenderer({ kind, ...props }: Props & { kind: Kind }) {
  if (kind === 'markdown') return <Markdown {...props} />;
  if (kind === 'chart') return <StreamingChart {...props} />;
  if (kind === 'html') return <Html {...props} />;
  return <Diagram {...props} kind={kind} />;
}
