import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCheck, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import type { ChatMessage, ToolActivity } from '@/chat.js';
import { toolLabels } from '@/lib/api.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { ReasoningDisclosure } from './ReasoningDisclosure.js';
import { isProcessTool, processState } from './assistant-process.js';

export function AssistantProcess({ messages, runActive = false, renderTool }: { messages: ChatMessage[]; runActive?: boolean; renderTool: (tool: ToolActivity) => ReactNode }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const state = processState(messages, runActive);
  if (!state.tools.length && !state.reasoning.length) return null;
  const active = state.processing;
  const warning = state.failed > 0 || state.interrupted;
  const title = state.failed ? t('process.failed', { count: state.failed }) : state.interrupted ? t('process.interrupted')
    : state.runningTool ? (toolLabels[state.runningTool.name] ?? state.runningTool.name)
    : state.thinking ? t('reasoning.active') : active ? t('process.responding') : t(state.queries ? 'process.completed' : 'process.finished');
  const counts = [state.queries ? t('process.queries', { count: state.queries }) : '', state.reasoning.length ? t('process.thoughts', { count: state.reasoning.length }) : '', state.skills ? t('process.skills', { count: state.skills }) : ''].filter(Boolean).join(' · ');
  return <Disclosure className="assistant-process" open={open} onToggle={event => setOpen(event.currentTarget.open)} data-testid="assistant-process" data-state={warning ? 'interrupted' : active ? 'streaming' : 'completed'}>
    <DisclosureTrigger className="assistant-process-trigger">
      {warning ? <CircleAlert className="size-3.5 shrink-0 text-warning" /> : active ? <LoaderCircle className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : <CheckCheck className="size-3.5 shrink-0 text-success" />}
      <span className="assistant-process-title">{title}</span><small>{counts}</small><ChevronRight className={open ? 'assistant-process-chevron rotate-90' : 'assistant-process-chevron'} />
    </DisclosureTrigger>
    <div className="assistant-process-body">
      <p className="assistant-process-caption">{t('process.title')}<span>{t('process.order')}</span></p>
      <ol className="assistant-process-steps">
        {messages.map((message, index) => <li key={message.id ?? index}>
          {message.reasoning?.text && <ReasoningDisclosure reasoning={message.reasoning} streaming={message.status === 'streaming'} />}
          {(message.tools ?? []).filter(isProcessTool).map(tool => <div className="assistant-process-step" key={tool.toolCallId}>
            <span className="assistant-process-step-icon">{tool.status === 'error' ? <CircleAlert className="text-warning" /> : tool.status === 'running' && active ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : tool.status === 'running' ? <CircleAlert /> : <CheckCheck />}</span>
            {renderTool(tool)}
          </div>)}
        </li>)}
      </ol>
      {warning && <p className="assistant-process-warning" role="status">{t(state.failed ? 'process.incomplete' : 'process.stopped')}</p>}
    </div>
  </Disclosure>;
}
