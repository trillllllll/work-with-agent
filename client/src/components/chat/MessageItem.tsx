import type { ChatMessage } from '@/chat.js';
import { cn } from '@/lib/utils.js';
import { MarkdownView } from './MarkdownView.js';

const roleLabels: Record<string, string> = { user: '你', assistant: 'Agent', tool: 'Tool', system: '系统' };

function looksLikeJson(content: string) {
  const trimmed = content.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

export function MessageItem({ message }: { message: ChatMessage }) {
  const role = message.role;
  const label = roleLabels[role] ?? role;
  const streaming = message.status === 'streaming';
  const failed = message.status === 'failed';
  const content = message.content || (streaming ? '正在输出…' : '');

  return (
    <div
      className={cn(
        'rounded-xl px-3 py-2.5',
        role === 'user' && 'border-l-2 border-primary/60 bg-primary/[0.08]',
        failed && 'border-l-2 border-destructive/50 bg-destructive/10',
        (role === 'tool' || role === 'system') && 'bg-transparent px-1 py-1.5'
      )}
    >
      <span className={cn('mb-1 block text-[11px] font-bold tracking-wide', failed ? 'text-destructive' : 'text-muted-foreground')}>
        {label}{failed ? '（输出失败）' : ''}
      </span>
      {(role === 'tool' || role === 'system') && !streaming ? (
        looksLikeJson(content) ? (
          <pre className="glass-subtle overflow-x-auto rounded-lg p-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">{content}</pre>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">{content}</p>
        )
      ) : streaming ? (
        <p className="streaming-caret text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">{content}</p>
      ) : (
        <MarkdownView content={content} />
      )}
    </div>
  );
}
