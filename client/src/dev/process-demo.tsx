import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, Brain, Check, CheckCheck, ChevronRight, CircleAlert, LoaderCircle, Moon, Play, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Surface } from '@/components/ui/surface.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import '../index.css';
import './process-demo.css';

// Isolated visual fixture: no app bootstrap, API calls, migrations or preference writes.
// i18n-ignore-file: Chinese design demo, not application UI.
type Mode = 'done' | 'running' | 'error';
const steps = [
  { kind: 'think', title: '梳理查询范围', detail: '先查看今天的任务，再核对项目进展，优先关注临近截止日期的事项。', time: '1 秒' },
  { kind: 'tool', title: '查询今日任务', detail: '找到 8 项任务，其中 3 项已完成、5 项待处理。', time: '0.4 秒' },
  { kind: 'tool', title: '读取项目清单', detail: '读取了产品迭代、日常工作和个人计划 3 个清单。', time: '0.2 秒' },
  { kind: 'tool', title: '核对截止日期', detail: '2 项任务今天到期：确认首页方案、整理评审反馈。', time: '0.3 秒' },
  { kind: 'think', title: '补充项目上下文', detail: '已获得任务列表，接下来核对相关项目与备注，再整理建议顺序。', time: '<1 秒' },
  { kind: 'tool', title: '查询关联项目', detail: '找到 2 个关联项目，当前均在进行中。', time: '0.6 秒' },
  { kind: 'tool', title: '读取任务备注', detail: '已核对 2 项到期任务的备注，没有发现阻塞事项。', time: '0.3 秒' },
];

function Process({ mode, progress }: { mode: Mode; progress: number }) {
  const [open, setOpen] = useState(false);
  const visible = mode === 'running' ? steps.slice(0, progress + 1) : steps;
  const count = visible.filter(step => step.kind === 'tool').length;
  const current = visible[visible.length - 1];
  return <Disclosure className="process" open={open} onToggle={event => setOpen(event.currentTarget.open)} data-state={mode}>
    <DisclosureTrigger className="process-trigger">
      <span className={`process-status ${mode}`}>
        {mode === 'running' ? <LoaderCircle className="spin" /> : mode === 'error' ? <CircleAlert /> : <CheckCheck />}
      </span>
      <span className="process-title">{mode === 'running' ? current.title : mode === 'error' ? '有 1 项查询未完成' : '已完成查询'}</span>
      <span className="process-count">{mode === 'running' ? `已查询 ${count} 项` : mode === 'error' ? '4 / 5 项' : '5 项 · 思考 2 次'}</span>
      <span className="process-time">{mode === 'running' ? `${progress + 1} 秒` : '4 秒'}</span>
      <ChevronRight className={`process-chevron ${open ? 'expanded' : ''}`} />
    </DisclosureTrigger>
    <div className="process-body">
      <p className="process-caption">执行过程<span>按发生顺序</span></p>
      <ol className="process-steps">
        {visible.map((step, index) => {
          const active = mode === 'running' && index === progress;
          const failed = mode === 'error' && index === steps.length - 1;
          return <li key={step.title} className={failed ? 'step failed' : 'step'}>
            <span className="step-icon">{active ? <LoaderCircle className="spin" /> : failed ? <CircleAlert /> : step.kind === 'think' ? <Brain /> : <Check />}</span>
            <Disclosure className="step-disclosure">
              <DisclosureTrigger className="step-trigger">
                <span>{step.title}</span><span className="step-meta">{active ? '进行中' : failed ? '查询失败' : step.time}</span><ChevronRight className="step-chevron" />
              </DisclosureTrigger>
              <div className="step-detail">{active ? '正在处理，请稍候…' : failed ? '读取备注超时，已保留其余 4 项查询结果。' : step.detail}
                {step.kind === 'think' && <small>示例思考内容，仅用于演示展开效果。</small>}
              </div>
            </Disclosure>
          </li>;
        })}
      </ol>
      {mode === 'error' && <p className="process-error">这次回答未包含任务备注，结果可能不完整。</p>}
    </div>
  </Disclosure>;
}

function Original() {
  return <div className="original">
    {[3, 2].map((count, i) => <div className="original-round" key={count}>
      <div><Brain size={15} /><span>已思考 {i ? '0' : '1'} 秒</span><span className="original-link">查看过程 <ChevronRight size={13} /></span></div>
      <Surface tone="subtle" className="original-tool"><CheckCheck size={16} /><span>查询了 {count} 项</span><ChevronRight size={14} /></Surface>
    </div>)}
  </div>;
}

function Demo() {
  const [mode, setMode] = useState<Mode>('done');
  const [progress, setProgress] = useState(0);
  const [original, setOriginal] = useState(false);
  const [dark, setDark] = useState(false);
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); }, [dark]);
  useEffect(() => {
    if (mode !== 'running') return;
    const timer = setInterval(() => setProgress(previous => Math.min(previous + 1, steps.length)), 1100);
    return () => clearInterval(timer);
  }, [mode]);
  useEffect(() => { if (mode === 'running' && progress >= steps.length) setMode('done'); }, [mode, progress]);
  function replay() { setOriginal(false); setProgress(0); setMode('running'); }
  return <div className="demo-page">
    <header className="demo-header"><a href="/process-demo.html" className="demo-brand">dovun<span>/</span><span>交互实验</span></a><div className="demo-header-right"><span className="demo-badge">DEMO</span><Button variant="ghost" size="icon-sm" aria-label={dark ? '切换浅色' : '切换深色'} onClick={() => setDark(value => !value)}>{dark ? <Sun /> : <Moon />}</Button></div></header>
    <main className="demo-main">
      <div className="demo-intro"><p className="eyebrow">CHAT / 执行过程</p><h1>过程收起来，重点留下来。</h1><p>多次思考与查询合为一条记录，需要时再展开。</p></div>
      <div className="demo-toolbar">
        <div className="demo-switch" aria-label="展示方案">{['优化后', '原样对照'].map((label, index) => <Button key={label} variant="plain" size="sm" aria-pressed={original === Boolean(index)} onClick={() => setOriginal(Boolean(index))}>{label}</Button>)}</div>
        <Button variant="ghost" size="sm" onClick={replay} disabled={mode === 'running'}><Play />重播过程</Button>
      </div>
      <Surface tone="card" className="chat-preview" aria-label="对话预览">
        <div className="chat-top"><span className="assistant-dot" /><strong>内置助手</strong><span>今日工作安排</span><span className="fixture">模拟对话</span></div>
        <div className="chat-content">
          <div className="user-question">帮我看看今天有哪些任务，先做哪几件？</div>
          <div className="assistant-label"><span className="assistant-avatar">d</span>Dovun</div>
          {original ? <Original /> : <Process mode={mode} progress={Math.min(progress, steps.length - 1)} />}
          <div className="answer" aria-live="polite">
            {mode === 'running' && !original ? <p className="answer-wait">正在核对任务与项目进展…</p> : <>
              <p>今天还有 <strong>5 项任务</strong>待处理，建议先完成这两件：</p>
              <div className="answer-task"><span>1</span><div><strong>确认首页方案</strong><p>今天到期 · 产品迭代</p></div><span className="task-tag">优先处理</span></div>
              <div className="answer-task"><span>2</span><div><strong>整理评审反馈</strong><p>今天到期 · 日常工作</p></div></div>
              <p className="answer-end">其他 3 项没有临近截止日期，可以安排在这两件之后。</p>
              {mode === 'error' && !original && <div className="retry-note"><span><CircleAlert />有 1 项查询失败，建议补查后再安排。</span><Button variant="outline" size="xs" onClick={replay}>重试查询</Button></div>}
            </>}
          </div>
        </div>
        <div className="composer"><span>输入消息…</span><span className="send-placeholder"><ArrowUp size={16} /></span></div>
      </Surface>
      <div className="state-controls"><span>查看状态</span>{([['done', '已完成'], ['running', '执行中'], ['error', '部分失败']] as const).map(([value, label]) => <Button key={value} variant="plain" size="sm" aria-pressed={mode === value} onClick={() => { setOriginal(false); if (value === 'running') replay(); else setMode(value); }}>{label}</Button>)}</div>
      <div className="design-notes"><div><span>01</span><p><strong>一轮回答，一条过程</strong>连续调用不再撑开聊天记录。</p></div><div><span>02</span><p><strong>正在做什么，一眼看到</strong>执行时显示当前步骤，完成后收敛。</p></div><div><span>03</span><p><strong>细节保留，异常露出</strong>逐项展开，失败不会藏在折叠里。</p></div></div>
      <p className="demo-footnote">仅展示交互方案 · 所有任务和执行记录均为模拟数据</p>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Demo />);
