import { useRef, type FormEvent, type KeyboardEvent } from 'react';
import { Loader2, SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';

type ChatComposerProps = {
  input: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSend: (event: FormEvent) => void;
};

export function ChatComposer({ input, busy, onChange, onSend }: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    <form className="flex shrink-0 items-end gap-2 border-t p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]" onSubmit={onSend}>
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
    </form>
  );
}
