import { Check, ChevronRight, FileText, LoaderCircle, RotateCcw, Terminal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { Surface } from '@/components/ui/surface.js';
import { MarkdownView } from '@/components/shared/MarkdownView.js';
import type { HarnessId, StreamMessage } from './fixtures.js';
import { streamView } from './stream.js';

function CommandOutput({ output, running, stopped }: { output: string; running: boolean; stopped: boolean }) {
  // Follow a live command on first appearance. Opening history or a later chunk respects the reader's choice.
  const [open, setOpen] = useState(running && !stopped);
  const state = running ? (stopped ? '已停止' : '执行中') : '已完成';
  return <Disclosure open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="harness-command">
    <DisclosureTrigger className="harness-tool-line">
      <Terminal className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-sm">运行手机会话检查</span>
      <span className="text-xs text-muted-foreground">{state}</span>
      <ChevronRight className={open ? 'size-3.5 rotate-90' : 'size-3.5'} aria-hidden="true" />
    </DisclosureTrigger>
    <Surface tone="subtle" className="harness-terminal">
      <div className="harness-command-text"><span aria-hidden="true">$ </span><code>npm test -- mobile-sessions</code></div>
      {output ? <pre aria-label="命令输出">{output.trimEnd()}</pre>
        : <p className="text-xs text-muted-foreground">{stopped ? '没有收到输出' : '等待命令输出…'}</p>}
    </Surface>
  </Disclosure>;
}

export function StreamReply({ message, harness, name, icon, now, replay }: {
  message: StreamMessage; harness: HarnessId; name: string; icon: ReactNode; now: number; replay?: () => void;
}) {
  const view = streamView(message, harness, now);
  const stopped = message.stoppedAt !== undefined;
  const live = !view.complete && !stopped;
  const status = stopped ? '已停止' : view.complete ? '已完成' : view.test === 'running' ? '正在运行检查'
    : view.read === 'running' ? '正在读取文件' : view.intro || view.answer ? '正在回复' : '等待回复';
  return <li className="assistant-message harness-stream-turn" data-role="assistant" aria-busy={live}>
    <div className="harness-byline">
      {icon}<span className="font-medium text-foreground">{name}</span>
      <span aria-hidden="true">·</span>
      <span role="status" className="inline-flex items-center gap-1.5">
        {live && <span className="harness-live-dot" aria-hidden="true" />}{status}
      </span>
    </div>
    {message.script === 'checks' && <div hidden={!view.intro}>
      <MarkdownView content={view.intro} streaming={live && !view.read} revealAdditions className="harness-prose" />
    </div>}
    {view.read && <div className="harness-operation-list">
      <div className="harness-tool-line">
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1"><span className="block text-sm">读取会话页</span><code className="harness-file-name">HarnessSessions.tsx</code></div>
        {view.read === 'done' ? <Check className="size-3.5 text-success" aria-label="读取完成" />
          : stopped ? <span className="text-xs text-muted-foreground">已停止</span> : <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-label="读取中" />}
      </div>
      {view.test && <CommandOutput output={view.output} running={view.test === 'running'} stopped={stopped} />}
    </div>}
    <div hidden={!view.answer}>
      <MarkdownView content={view.answer} streaming={live} revealAdditions responsiveTables className="harness-prose" />
    </div>
    {!live && replay && <Button type="button" variant="chip" size="bare" className="harness-replay" onClick={replay}>
      <RotateCcw className="size-3.5" aria-hidden="true" />重播演示
    </Button>}
  </li>;
}
