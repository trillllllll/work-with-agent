import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCheck, ChevronRight, CircleAlert, LoaderCircle, Wrench } from 'lucide-react';
import type { ChatMessage, ToolActivity } from '@/chat.js';
import { toolLabels } from '@/lib/api.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { ReasoningDisclosure } from './ReasoningDisclosure.js';
import { isProcessTool, processPreview, processState } from './assistant-process.js';

export function AssistantProcess({ messages, runActive = false, renderTool }: { messages: ChatMessage[]; runActive?: boolean; renderTool: (tool: ToolActivity) => ReactNode }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const peekRef = useRef<HTMLDivElement>(null);
  const hoveringRef = useRef(false);
  const state = processState(messages, runActive);
  const preview = processPreview(messages, runActive);
  const active = state.processing;
  const warning = state.failed > 0 || state.interrupted;
  const completed = !active && !warning;
  const showPeek = !open && !completed && preview.length > 0;
  const latestPreviewId = preview[preview.length - 1]?.id;
  function scrollToLatest() {
    const viewport = peekRef.current;
    if (!viewport) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' });
  }
  useEffect(() => {
    if (showPeek && !hoveringRef.current) scrollToLatest();
  }, [showPeek, preview.length, latestPreviewId]);
  if (!state.tools.length && !state.reasoning.length) return null;
  const counts = [state.queries ? t('process.queries', { count: state.queries }) : '', state.reasoning.length ? t('process.thoughts', { count: state.reasoning.length }) : '', state.skills ? t('process.skills', { count: state.skills }) : ''].filter(Boolean).join(' · ');
  return <div className="assistant-process" data-state={warning ? 'interrupted' : active ? 'streaming' : 'completed'}>
    <Disclosure className="assistant-process-disclosure" open={open} onToggle={event => setOpen(event.currentTarget.open)} data-testid="assistant-process" data-state={warning ? 'interrupted' : active ? 'streaming' : 'completed'}>
      <DisclosureTrigger className="assistant-process-trigger">
        {active ? <LoaderCircle className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : warning ? <Wrench className="size-3.5 shrink-0" /> : <CheckCheck className="size-3.5 shrink-0 text-success" />}
        <span className="assistant-process-title">{t('process.title')}</span>
        {counts && <span className="assistant-process-summary">{counts}</span>}
        <ChevronRight className={open ? 'assistant-process-chevron rotate-90' : 'assistant-process-chevron'} />
      </DisclosureTrigger>
      <div className="assistant-process-body">
        <p className="assistant-process-caption">{t('process.title')}<span>{t('process.order')}</span></p>
        <p className="assistant-process-counts">{counts}</p>
        <ol className="assistant-process-steps">
          {messages.map((message, index) => <li key={message.id ?? index}>
            {message.reasoning?.text && <ReasoningDisclosure reasoning={message.reasoning} streaming={message.status === 'streaming'} />}
            {(message.tools ?? []).filter(isProcessTool).map(tool => <div className="assistant-process-step" key={tool.toolCallId}>
              <span className="assistant-process-step-icon">{tool.status === 'error' ? <CircleAlert className="text-warning" /> : tool.status === 'running' && active ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : tool.status === 'running' ? <CircleAlert /> : <CheckCheck />}</span>
              {renderTool(tool)}
            </div>)}
          </li>)}
        </ol>
      </div>
    </Disclosure>
    {showPeek && <div
      className="assistant-process-peek"
      ref={peekRef}
      data-testid="assistant-process-peek"
      aria-label={t('process.preview')}
      onMouseEnter={() => { hoveringRef.current = true; }}
      onMouseLeave={() => { hoveringRef.current = false; scrollToLatest(); }}
    >
      <ol className="assistant-process-peek-track">
        {preview.map(entry => {
          const label = entry.kind === 'reasoning' ? t(entry.active ? 'reasoning.active' : 'reasoning.completed')
            : entry.kind === 'responding' ? t('process.responding') : toolLabels[entry.tool.name] ?? entry.tool.name;
          const detail = entry.kind === 'tool' ? entry.active ? t('messageItem.inProgress') : entry.tool.preview : '';
          return <li className={entry.active ? 'assistant-process-peek-line active' : 'assistant-process-peek-line'} data-state={entry.active ? 'active' : 'completed'} key={entry.id}>
            <span className="assistant-process-peek-dot" />
            <span className="assistant-process-peek-label">{label}</span>
            {detail && <span className="assistant-process-peek-detail">{detail}</span>}
          </li>;
        })}
      </ol>
    </div>}
  </div>;
}
