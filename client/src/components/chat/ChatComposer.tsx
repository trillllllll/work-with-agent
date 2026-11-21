import { Surface } from '@/components/ui/surface.js';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { isCompositionKey } from '@/lib/todo.js';
import { Textarea } from '@/components/ui/textarea.js';

const LINE_HEIGHT = 20;
const INPUT_PAD = 8;
const EXPANDED_LINES = 3;
const MAX_LINES = 8;

type ChatComposerProps = {
  input: string;
  busy: boolean;
  reference?: { id: string; title: string } | null;
  onChange: (value: string) => void;
  onSend: (event: FormEvent) => void;
  onCancelReference?: () => void;
  toolbar?: ReactNode;
  contextUsage?: ReactNode;
  model?: ReactNode;
  onStop?: () => void;
  stopping?: boolean;
  placeholder?: string;
  maxLength?: number;
  actionsDisabled?: boolean;
  allowSendWhileBusy?: boolean;
  listenForAssistantFocus?: boolean;
  labels?: { input?: string; send?: string; stop?: string };
};

export function ChatComposer({
  input, busy, reference, onChange, onSend, onCancelReference, toolbar, contextUsage, model, onStop, stopping,
  placeholder, maxLength, actionsDisabled, allowSendWhileBusy, labels, listenForAssistantFocus = true,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [focused, setFocused] = useState(false);
  const [justSent, setJustSent] = useState(false);
  const expanded = (focused || input.trim().length > 0) && !justSent;
  // Collapsing on blur resizes the thread. When a pointer press caused the blur, wait until it is
  // released so the press and release land on the same control and its click is not lost.
  const pointerDown = useRef(false);
  const cancelCollapse = useRef(() => {});
  useEffect(() => {
    const down = () => { pointerDown.current = true; };
    const up = () => { pointerDown.current = false; };
    // A native context menu or the window losing focus can swallow the release; do not stay "pressed".
    // Element blurs also reach a window capture listener, so only the window's own blur counts.
    const windowBlur = (event: FocusEvent) => { if (event.target === window) up(); };
    const reset = ['pointerup', 'pointercancel', 'contextmenu'] as const;
    window.addEventListener('pointerdown', down, true);
    for (const type of reset) window.addEventListener(type, up, true);
    window.addEventListener('blur', windowBlur);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      for (const type of reset) window.removeEventListener(type, up, true);
      window.removeEventListener('blur', windowBlur);
      cancelCollapse.current();
    };
  }, []);
  const handleBlur = () => {
    cancelCollapse.current();
    if (!pointerDown.current) { setFocused(false); return; }
    let timer = 0;
    const stopListening = () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    };
    function release() {
      stopListening();
      timer = window.setTimeout(() => { if (document.activeElement !== textareaRef.current) setFocused(false); }, 0);
    }
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    cancelCollapse.current = () => { stopListening(); window.clearTimeout(timer); };
  };
  useEffect(() => {
    if (!listenForAssistantFocus) return;
    const focus = () => textareaRef.current?.focus();
    window.addEventListener('dovun-focus-assistant', focus);
    return () => window.removeEventListener('dovun-focus-assistant', focus);
  }, [listenForAssistantFocus]);
  useEffect(() => { if (reference) textareaRef.current?.focus(); }, [reference?.id]);
  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const min = (expanded ? EXPANDED_LINES : 1) * LINE_HEIGHT + INPUT_PAD;
    const max = MAX_LINES * LINE_HEIGHT + INPUT_PAD;
    el.style.height = `${Math.max(min, Math.min(el.scrollHeight, max))}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  };
  useEffect(resize, [input, expanded]);
  const showSend = !busy || allowSendWhileBusy;
  const canSend = showSend && !actionsDisabled && !!input.trim();
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !composing.current && !isCompositionKey(event.nativeEvent)) {
      event.preventDefault();
      if (canSend) handleSubmit(event);
    }
  };
  const handleSubmit = (event: FormEvent) => {
    if (actionsDisabled) { event.preventDefault(); return; }
    if (canSend) setJustSent(true);
    onSend(event);
  };
  return (
    <form className="assistant-composer flex shrink-0 flex-col gap-2 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2" onSubmit={handleSubmit}>
      {reference && (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span>{t('composer.adjusting', { title: reference.title })}</span>
          <Button variant="plain" size="bare" type="button" className="shrink-0" onClick={onCancelReference}>{t('composer.removeReference')}</Button>
        </div>
      )}
      <Surface as="div" tone="input" className="assistant-input-box p-3">
        <Textarea variant="inline"
          ref={textareaRef}
          aria-label={labels?.input ?? t('composer.askAi')}
          value={input}
          rows={1}
          maxLength={maxLength}
          placeholder={placeholder ?? t('composer.placeholder')}
          className="w-full resize-none px-1 py-1 text-[13px] leading-5 transition-[height] duration-150 ease-out"
          onFocus={() => { cancelCollapse.current(); setFocused(true); setJustSent(false); }}
          onBlur={handleBlur}
          onChange={(event) => { setJustSent(false); onChange(event.target.value); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={onKeyDown}
        />
        <div className="mt-2 flex min-w-0 items-center gap-2">
          {toolbar}
          <span className="flex min-w-0 flex-1 items-center truncate text-[11px] text-muted-foreground">{model}</span>
          {contextUsage}
          {busy && <Button type="button" size="icon" className="size-8 rounded-full" onClick={onStop} disabled={stopping || actionsDisabled} aria-label={labels?.stop ?? t('composer.stop')} title={labels?.stop}><Square className="size-3 fill-current" /></Button>}
          {showSend && <Button type="submit" size="icon" className="size-8 rounded-full" disabled={!canSend} aria-label={labels?.send ?? t('composer.send')} title={labels?.send}><ArrowUp /></Button>}
        </div>
      </Surface>
      {stopping && <p className="text-center text-[10px] text-muted-foreground">{t('composer.stopping')}</p>}
    </form>
  );
}
