import { Surface } from '@/components/ui/surface.js';
import { useEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { isCompositionKey } from '@/lib/todo.js';
import { Textarea } from '@/components/ui/textarea.js';

type ChatComposerProps = {
  input: string;
  busy: boolean;
  reference?: { id: string; title: string } | null;
  onChange: (value: string) => void;
  onSend: (event: FormEvent) => void;
  onCancelReference?: () => void;
  toolbar?: ReactNode;
  contextUsage?: ReactNode;
  model?: string;
  onStop?: () => void;
  stopping?: boolean;
};

export function ChatComposer({ input, busy, reference, onChange, onSend, onCancelReference, toolbar, contextUsage, model, onStop, stopping }: ChatComposerProps) {
  const { t } = useTranslation('chat');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  useEffect(() => { const focus = () => textareaRef.current?.focus(); window.addEventListener('dovun-focus-assistant', focus); return () => window.removeEventListener('dovun-focus-assistant', focus); }, []);
  useEffect(() => { if (reference) textareaRef.current?.focus(); }, [reference?.id]);
  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };
  useEffect(resize, [input]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !composing.current && !isCompositionKey(event.nativeEvent)) {
      event.preventDefault();
      if (input.trim() && !busy) onSend(event);
    }
  };
  return (
    <form className="assistant-composer flex shrink-0 flex-col gap-2 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2" onSubmit={onSend}>
      {reference && (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span>{t('composer.adjusting', { title: reference.title })}</span>
          <Button variant="plain" size="bare" type="button" className="shrink-0" onClick={onCancelReference}>{t('composer.removeReference')}</Button>
        </div>
      )}
      <Surface as="div" tone="input" className="assistant-input-box p-3">
        <Textarea variant="inline"
          ref={textareaRef}
          aria-label={t('composer.askAi')}
          value={input}
          rows={1}
          placeholder={t('composer.placeholder')}
          className="max-h-[120px] min-h-12 w-full resize-none px-1 py-1 text-[13px]"
          onChange={(event) => { onChange(event.target.value); requestAnimationFrame(resize); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={onKeyDown}
        />
        <div className="mt-2 flex min-w-0 items-center gap-2">
          {toolbar}
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={model}>{model || t('status.noModel')}</span>
          {contextUsage}
          {busy ? <Button type="button" size="icon" className="size-8 rounded-full" onClick={onStop} disabled={stopping} aria-label={t('composer.stop')}><Square className="size-3 fill-current" /></Button> : <Button type="submit" size="icon" className="size-8 rounded-full" disabled={!input.trim()} aria-label={t('composer.send')}><ArrowUp /></Button>}
        </div>
      </Surface>
      <p className="text-center text-[10px] text-muted-foreground">{stopping ? t('composer.stopping') : t('composer.previewHint')}</p>
    </form>
  );
}
