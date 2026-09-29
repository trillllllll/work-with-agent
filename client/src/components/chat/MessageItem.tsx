import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Approval, ChatMessage, ToolActivity } from '@/chat.js';
import { groupToolActivities, isReadOnlyTool } from '@/chat.js';
import { toolLabels } from '@/lib/api.js';
import { cn } from '@/lib/utils.js';
import { ApprovalCard } from './ApprovalCard.js';
import { MarkdownView } from './MarkdownView.js';

const roleLabels: Record<string, string> = { user: '你', assistant: 'Agent', tool: 'Tool', system: '系统' };

function payloadText(activity: ToolActivity) {
  const parts: string[] = [];
  if (Object.keys(activity.arguments).length) parts.push(`参数\n${JSON.stringify(activity.arguments, null, 2)}`);
  if (activity.result !== undefined) parts.push(`结果\n${JSON.stringify(activity.result, null, 2)}`);
  const text = parts.join('\n\n');
  if (!text) return '';
  return text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text;
}

function statusText(activity: ToolActivity) {
  if (activity.status === 'running') return '进行中';
  if (activity.status === 'pending') return '等待审核';
  if (activity.status === 'done' && !isReadOnlyTool(activity.name)) return '已执行';
  return '';
}

function ToolCallRow({ activity, approval, pending, onApprove, onReject }: { activity: ToolActivity; approval?: Approval; pending: boolean; onApprove: (id: string) => void; onReject: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const payload = payloadText(activity);
  const label = toolLabels[activity.name] ?? activity.name;
  const failed = activity.status === 'error';
  const header = (
    <>
      {payload ? <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} /> : <span className="size-3.5 shrink-0" />}
      <span className="shrink-0 font-medium">{label}</span>
      <span className={cn('min-w-0 flex-1 truncate', failed ? 'text-destructive' : 'text-muted-foreground')}>{activity.preview}</span>
      {statusText(activity) && <span className="shrink-0 text-[11px] text-muted-foreground">{statusText(activity)}</span>}
    </>
  );
  return (
    <div className="rounded-lg border border-border/80 bg-muted/40">
      {payload ? (
        <button type="button" aria-expanded={open} aria-label={`${label} ${activity.preview}`} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]" onClick={() => setOpen((value) => !value)}>
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">{header}</div>
      )}
      {open && payload && <pre className="max-h-24 overflow-auto border-t border-border/70 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">{payload}</pre>}
      {activity.status === 'pending' && approval && (
        <div className="px-2 pb-2">
          <ApprovalCard approval={approval} pending={pending} onApprove={onApprove} onReject={onReject} />
        </div>
      )}
    </div>
  );
}

function ToolRun({ activities, approvalFor, pending, onApprove, onReject }: { activities: ToolActivity[]; approvalFor: (activity: ToolActivity) => Approval | undefined; pending: boolean; onApprove: (id: string) => void; onReject: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border/80 bg-muted/40">
      <button type="button" aria-expanded={open} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]" onClick={() => setOpen((value) => !value)}>
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="font-medium">查询了 {activities.length} 项</span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 border-t border-border/70 p-1.5">
          {activities.map((activity) => <ToolCallRow key={activity.toolCallId} activity={activity} approval={approvalFor(activity)} pending={pending} onApprove={onApprove} onReject={onReject} />)}
        </div>
      )}
    </div>
  );
}

function looksLikeJson(content: string) {
  const trimmed = content.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

export function MessageItem({ message, approvals = [], approvalPending = false, onApprove = () => undefined, onReject = () => undefined }: { message: ChatMessage; approvals?: Approval[]; approvalPending?: boolean; onApprove?: (id: string) => void; onReject?: (id: string) => void }) {
  const role = message.role;
  if (role === 'tool') return null;
  const label = roleLabels[role] ?? role;
  const streaming = message.status === 'streaming';
  const failed = message.status === 'failed';
  const content = message.content || (streaming ? '正在输出…' : '');
  const approvalFor = (activity: ToolActivity) => approvals.find((item) => item.approvalId === activity.approvalId || item.toolCallId === activity.toolCallId);
  const groups = groupToolActivities(message.tools ?? []);
  if (role === 'assistant' && !content && !failed && groups.length === 0) return null;

  return (
    <div
      className={cn(
        'rounded-xl px-3 py-2.5',
        role === 'user' && 'border-l-2 border-primary/60 bg-primary/[0.08]',
        failed && 'border-l-2 border-destructive/50 bg-destructive/10',
        role === 'system' && 'bg-transparent px-1 py-1.5'
      )}
    >
      {(content || role !== 'assistant') && (
        <span className={cn('mb-1 block text-[11px] font-bold tracking-wide', failed ? 'text-destructive' : 'text-muted-foreground')}>
          {label}{failed ? '（输出失败）' : ''}
        </span>
      )}
      {content && (role === 'system' && !streaming ? (
        looksLikeJson(content) ? (
          <pre className="glass-subtle overflow-x-auto rounded-lg p-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">{content}</pre>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">{content}</p>
        )
      ) : streaming ? (
        <p className="streaming-caret text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">{content}</p>
      ) : (
        <MarkdownView content={content} />
      ))}
      {groups.length > 0 && (
        <div className={cn('flex flex-col gap-1.5', content && 'mt-2')}>
          {groups.map((group) => group.kind === 'run' ? (
            <ToolRun key={group.activities.map((item) => item.toolCallId).join('-')} activities={group.activities} approvalFor={approvalFor} pending={approvalPending} onApprove={onApprove} onReject={onReject} />
          ) : (
            <ToolCallRow key={group.activity.toolCallId} activity={group.activity} approval={approvalFor(group.activity)} pending={approvalPending} onApprove={onApprove} onReject={onReject} />
          ))}
        </div>
      )}
    </div>
  );
}
