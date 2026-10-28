import { useEffect, useState } from 'react';
import { Brain, ChevronRight, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import type { AssistantReasoning } from '../../../../server/src/domain/assistant-reasoning.js';
export function ReasoningDisclosure({ reasoning, streaming }: { reasoning: AssistantReasoning; streaming: boolean }) {
  const { t } = useTranslation('chat');
  const active = streaming && reasoning.status === 'streaming';
  const interrupted = reasoning.status === 'interrupted' || (!streaming && reasoning.status === 'streaming');
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!active) { setOpen(false); return; } setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  const end = reasoning.endedAt ? Date.parse(reasoning.endedAt) : active ? now : NaN;
  const seconds = Math.max(0, Math.floor((end - Date.parse(reasoning.startedAt)) / 1000));
  if (!reasoning.text) return null;
  return <Disclosure open={open} onToggle={event => setOpen(event.currentTarget.open)} className="assistant-reasoning" data-testid="assistant-reasoning" data-state={active ? 'streaming' : interrupted ? 'interrupted' : 'completed'}>
    <DisclosureTrigger className="assistant-reasoning-trigger">
      {active ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Brain className="size-3.5" />}
      <span>{t(active ? 'reasoning.active' : interrupted ? 'reasoning.interrupted' : 'reasoning.completed')}</span>
      {Number.isFinite(seconds) && <small>{t('reasoning.seconds', { count: seconds })}</small>}
      <span className="ml-auto text-[10px]">{t(open ? 'reasoning.collapse' : 'reasoning.expand')}</span><ChevronRight className={open ? 'size-3 rotate-90' : 'size-3'} />
    </DisclosureTrigger>
    <div className="assistant-reasoning-body"><p className="mb-2 text-[10px]">{t('reasoning.providerContent')}</p><div className="whitespace-pre-wrap break-words">{reasoning.text}</div>{reasoning.truncated && <p className="mt-2">{t('reasoning.truncated')}</p>}{interrupted && <p className="mt-2">{t('reasoning.incomplete')}</p>}</div>
  </Disclosure>;
}
