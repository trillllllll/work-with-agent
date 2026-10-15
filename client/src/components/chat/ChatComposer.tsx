import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import { Loader2, SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';

type ChatComposerProps = {
  input: string;
  busy: boolean;
  reference?: { id: string; title: string } | null;
  onChange: (value: string) => void;
  onSend: (event: FormEvent) => void;
  onCancelReference?: () => void;
};

export function ChatComposer({ input, busy, reference, onChange, onSend, onCancelReference }: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (reference) textareaRef.current?.focus(); }, [reference?.id]);
  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (input.trim() && !busy) onSend(event);
    }
  };
  return (
    <form className="flex shrink-0 flex-col gap-2 border-t glass-divider p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]" onSubmit={onSend}>
      {reference && (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span>正在调整：{reference.title}</span>
          <button type="button" className="shrink-0" onClick={onCancelReference}>取消引用</button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={input}
          rows={1}
          placeholder="例如：创建任务：整理 API 文档"
          className="max-h-[120px] min-h-9 flex-1 resize-none py-2 text-[13px]"
          onChange={(event) => { onChange(event.target.value); requestAnimationFrame(resize); }}
          onKeyDown={onKeyDown}
        />
        <Button type="submit" size="icon" className="size-9 shrink-0" disabled={busy || !input.trim()} aria-label="发送">
          {busy ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
        </Button>
      </div>
    </form>
  );
}
