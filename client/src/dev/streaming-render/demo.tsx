// i18n-ignore-file: Chinese design/engineering demo, not a production surface.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDown, ArrowUpRight, Braces, ChartNoAxesColumn, Check, ChevronRight, Code2, FileText, GitBranch, Moon, Pause, Play, RotateCcw, Shapes, SkipForward, Square, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { NativeSelect } from '@/components/ui/native-select.js';
import { Surface } from '@/components/ui/surface.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { Toaster } from 'sonner';
import i18n from '@/i18n/index.js';
import { kinds, type Kind } from './fixtures.js';
import { useStream } from './use-stream.js';
import { StreamingRenderer } from './renderers.js';
import '../../index.css';
import '../../components/chat/conversation.css';
import './style.css';

void i18n.changeLanguage('zh-CN');
const icons = { markdown: FileText, chart: ChartNoAxesColumn, mermaid: GitBranch, svg: Shapes, html: Code2 };

function Experiment({ kind, invalid, dark, replay }: { kind: Kind; invalid: boolean; dark: boolean; replay: () => void }) {
  const stream = useStream(kind, invalid);
  const { state, stopped } = stream;
  const [mode, setMode] = useState<'live' | 'complete'>('live');
  const [metrics, setMetrics] = useState({ updates: 0, first: 0, beforeEnd: false, settled: false, error: '' });
  const observed = useRef(state); observed.current = state;
  const report = useCallback((error?: string, phase?: 'complete') => {
    if (error) setMetrics(old => ({ ...old, error }));
    else if (phase === 'complete') setMetrics(old => ({ ...old, settled: true }));
    else setMetrics(old => ({ ...old, updates: old.updates + 1, beforeEnd: old.updates ? old.beforeEnd : !observed.current.done, first: old.first || (stream.startedAt.current ? performance.now() - stream.startedAt.current : 0) }));
  }, [stream.startedAt]);
  const sourceRef = useRef<HTMLPreElement>(null);
  useEffect(() => { if (sourceRef.current) sourceRef.current.scrollTop = sourceRef.current.scrollHeight; }, [state.source]);
  const meta = kinds.find(item => item.id === kind)!;
  const percent = Math.round(state.received / stream.total * 100);
  const status = metrics.error ? '保留上一版' : state.error ? '解析失败' : state.interrupted ? '已中断' : state.done ? metrics.settled ? '生成完成' : '正在完成渲染' : stream.playing ? '正在接收' : state.received ? '已暂停' : '准备就绪';
  return <>
    <div className="stream-controls">
      <div className="stream-playback">
        <Button className="stream-primary" size="sm" onClick={() => stream.setPlaying(!stream.playing)} disabled={stopped} aria-label={stream.playing ? '暂停' : state.received ? '继续' : '开始演示'}>{stream.playing ? <Pause /> : <Play />}{stream.playing ? '暂停' : state.received ? '继续' : '开始演示'}</Button>
        <Button variant="ghost" size="icon-sm" onClick={replay} aria-label="重新演示" title="重新演示"><RotateCcw /></Button>
        <Button variant="ghost" size="icon-sm" onClick={stream.advance} disabled={stream.playing || stopped} aria-label="接收下一块" title="单步：接收下一块"><SkipForward /></Button>
        <Button variant="ghost" size="icon-sm" onClick={stream.interrupt} disabled={stopped || !state.received} aria-label="模拟断流" title="模拟中途断流"><Square /></Button>
      </div>
      <div className="stream-options"><label>速度<NativeSelect aria-label="播放速度" value={stream.speed} onChange={event => stream.setSpeed(Number(event.target.value))}><option value="0.5">0.5×</option><option value="1">1×</option><option value="4">4×</option></NativeSelect></label><label>分块<NativeSelect aria-label="分块大小" value={stream.chunkSize} onChange={event => stream.setChunkSize(Number(event.target.value))}><option value="32">32 字节</option><option value="1">1 字节</option><option value="128">128 字节</option></NativeSelect></label></div>
      <span className={`stream-status ${stream.playing ? 'active' : ''}`} role="status" data-testid="stream-status"><i />{status}</span>
    </div>
    <div className="stream-progress" role="progressbar" aria-label="接收进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
    <div className="stream-workspace">
      <Surface tone="card" className="stream-preview">
        <div className="stream-preview-top"><span className="stream-avatar">d</span><div><strong>Dovun 助手</strong><span>帮我用{meta.label}展示一个清楚的结果。</span></div><span className="stream-fixture-label">模拟回复</span></div>
        <div className="stream-preview-bar"><div className="stream-mode" aria-label="渲染方式"><Button variant="plain" size="sm" aria-pressed={mode === 'live'} onClick={() => { if (mode === 'live') return; setMode('live'); setMetrics({ updates: 0, first: 0, beforeEnd: false, settled: false, error: '' }); }}>流式渲染</Button><Button variant="plain" size="sm" aria-pressed={mode === 'complete'} onClick={() => { if (mode === 'complete') return; setMode('complete'); setMetrics({ updates: 0, first: 0, beforeEnd: false, settled: false, error: '' }); }}>等待完成</Button></div><span>{percent}%</span></div>
        <div className="stream-output" data-testid="stream-output" data-done={state.done} data-render-complete={metrics.settled} data-kind={kind}>
          {mode === 'complete' && !state.done ? <div className="stream-empty"><span className="stream-empty-mark">···</span><strong>收到完整内容后再显示</strong><p>当前已接收 {percent}%，还在等待这一块结束。</p></div> : kind === 'markdown' ? <StreamingRenderer key={mode} kind={kind} state={state} dark={dark} report={report} /> : <section className="stream-visual-frame"><header><h3>{meta.label}</h3><span>{kind === 'html' ? '完成后启用交互' : '渐进预览'}</span></header><StreamingRenderer key={mode} kind={kind} state={state} dark={dark} report={report} /></section>}
        </div>
        {(state.interrupted || metrics.error || state.error) && <div className="stream-notice" role="alert">{metrics.error ? `这一版未通过校验，保留最近成功的预览。${metrics.error}` : state.error || '流已中断。已生成的内容保留，未完成的片段不作为最终结果。'}<Button variant="link" size="xs" onClick={replay}>重新演示</Button></div>}
        <div className="stream-preview-foot"><span><span className="stream-tiny-dot" />{meta.hint}</span><span>本地实验</span></div>
      </Surface>
      <aside className="stream-inspector" aria-label="流式解析观察">
        <div className="stream-inspector-title"><Braces size={16} /><strong>看看它如何发生</strong><span>LIVE</span></div>
        <div className="stream-flow"><span>字节片段</span><ChevronRight /><span>解析与校验</span><ChevronRight /><span>预览</span></div>
        <div className="stream-metrics"><div><span>接收进度</span><strong data-testid="received-bytes">{state.received.toLocaleString()}<small> / {stream.total.toLocaleString()} B</small></strong></div><div><span>成功更新</span><strong data-testid="render-count" data-first-before-end={metrics.updates ? metrics.beforeEnd : undefined}>{metrics.updates}<small> 次</small></strong></div><div><span>首个可见结果</span><strong>{metrics.first ? (metrics.first / 1000).toFixed(2) : '—'}<small> 秒</small></strong></div></div>
        <div className="stream-source-title"><span>已解析的内容</span><span>{state.chunks} 块</span></div>
        <pre ref={sourceRef} className="stream-source" data-testid="decoded-source">{state.source || '等待第一段内容…'}{stream.playing && <span className="stream-code-caret">▍</span>}</pre>
        <p className="stream-measure-note">耗时是本页模拟传输与渲染的观测值，包含暂停时间；不是模型响应速度。</p>
        <Disclosure className="stream-wire"><DisclosureTrigger>查看原始 JSON 输入 <ArrowDown size={12} /></DisclosureTrigger><pre>{stream.wire}</pre></Disclosure>
      </aside>
    </div>
  </>;
}

function Demo() {
  const [kind, setKind] = useState<Kind>('markdown');
  const [dark, setDark] = useState(false);
  const [run, setRun] = useState(0);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); }, [dark]);
  return <div className="stream-page">
    <header className="stream-header"><a href="/streaming-render-demo.html" className="stream-brand">dovun<span>/</span><span>交互实验室</span></a><div><span className="stream-lab-tag">EXPERIMENT 01</span><Button variant="ghost" size="icon-sm" aria-label={dark ? '切换浅色' : '切换深色'} onClick={() => setDark(value => !value)}>{dark ? <Sun /> : <Moon />}</Button></div></header>
    <main className="stream-main">
      <div className="stream-intro"><div><p className="stream-eyebrow"><span />STREAMING, MADE VISIBLE</p><h1>让回答，<span>逐步成形。</span></h1><p className="stream-lede">从第一行文字，到一张可交互的页面。<br className="stream-mobile-break" />生成一点，就看见一点。</p></div><div className="stream-intro-note"><ArrowUpRight /><span>5 种内容 · 同一条流<br /><strong>真实渲染，模拟输入</strong></span></div></div>
      <div className="stream-tabs" aria-label="内容类型">{kinds.map(item => { const Icon = icons[item.id]; return <Button key={item.id} variant="plain" size="bare" className="stream-tab" aria-pressed={kind === item.id} onClick={() => { setKind(item.id); setInvalid(false); }}><Icon size={19} /><span><strong>{item.name}</strong><small>{item.label}</small></span><span className="stream-tab-dot" /></Button>; })}</div>
      {(kind === 'mermaid' || kind === 'svg') && <div className="stream-fault-option"><span>边界实验</span><Button variant="chip" size="xs" aria-pressed={invalid} onClick={() => setInvalid(value => !value)}>{invalid && <Check />}在末尾加入错误片段</Button><span>观察上一版是否保留</span></div>}
      <Experiment key={`${kind}-${run}-${invalid}`} kind={kind} invalid={invalid} dark={dark} replay={() => setRun(value => value + 1)} />
      <div className="stream-principles"><div><span>01</span><p><strong>先让内容可读</strong>文字边来边排版，无需等整段结束。</p></div><div><span>02</span><p><strong>只更新成功的结果</strong>未闭合的图形暂存，保留上一版预览。</p></div><div><span>03</span><p><strong>页面更新，输入留下</strong>完整片段追加，脚本在最后执行一次。</p></div></div>
      <footer className="stream-footer"><span>DOVUN · DESIGN & ENGINEERING</span><span>固定数据 · 本地 Demo · 未接入正式对话</span></footer>
    </main><Toaster /></div>;
}
createRoot(document.getElementById('root')!).render(<Demo />);
