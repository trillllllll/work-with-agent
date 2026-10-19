import { useEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
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
  model?: string;
  onStop?: () => void;
  stopping?: boolean;
};

export function ChatComposer({ input, busy, reference, onChange, onSend, onCancelReference, toolbar, model, onStop, stopping }: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  useEffect(() => { const focus = () => textareaRef.current?.focus(); window.addEventListener('wwa-focus-assistant', focus); return () => window.removeEventListener('wwa-focus-assistant', focus); }, []);
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
          <span>正在调整：{reference.title}</span>
          <button type="button" className="shrink-0" onClick={onCancelReference}>取消引用</button>
        </div>
      )}
      <div className="assistant-input-box rounded-2xl border bg-muted/40 p-3 focus-within:border-foreground/40">
        <Textarea
          ref={textareaRef}
          aria-label="向 AI 提问"
          value={input}
          rows={1}
          placeholder="例如：创建任务：整理 API 文档"
          className="max-h-[120px] min-h-12 w-full resize-none rounded-none border-0 bg-transparent px-1 py-1 text-[13px] shadow-none focus-visible:ring-0"
          onChange={(event) => { onChange(event.target.value); requestAnimationFrame(resize); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={onKeyDown}
        />
        <div className="mt-2 flex min-w-0 items-center gap-2">
          {toolbar}
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={model}>{model || '未配置模型'}</span>
          {busy ? <Button type="button" size="icon" className="size-8 rounded-full" onClick={onStop} disabled={stopping} aria-label="停止生成"><Square className="size-3 fill-current" /></Button> : <Button type="submit" size="icon" className="size-8 rounded-full" disabled={!input.trim()} aria-label="发送"><ArrowUp /></Button>}
        </div>
      </div>
      <p className="text-center text-[10px] text-muted-foreground">{stopping ? '正在停止…' : '修改前会先预览，确认后才执行'}</p>
    </form>
  );
}
