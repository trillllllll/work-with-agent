import { MessageBlocks } from './MessageBlocks.js';
import { ContextSummary } from './ContextSummary.js';
import { SourceLinks } from './SourceLinks.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Copy } from 'lucide-react';
import type { Approval, ChatMessage, ToolActivity } from '@/chat.js';
import { approvalsOnMessage, groupToolActivities, isReadOnlyTool } from '@/chat.js';
import { toolLabels } from '@/lib/api.js';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';
import { ApprovalCard } from './ApprovalCard.js';
import { ExternalPromptCard } from './ExternalPromptCard.js';
import { WorktreeCleanupChatCard } from '@/components/orchestration/WorktreesPage.js';
import { isAppChangeApproval, ReviewCard } from './ReviewCard.js';
import { isTaskBatchApproval, TaskBatchCard } from './TaskBatchCard.js';
import { MarkdownView } from '@/components/shared/MarkdownView.js';

function payloadText(activity: ToolActivity, argumentsLabel: string, resultLabel: string) {
  const parts: string[] = [];
  if (Object.keys(activity.arguments).length) parts.push(`${argumentsLabel}\n${JSON.stringify(activity.arguments, null, 2)}`);
  if (activity.result !== undefined) parts.push(`${resultLabel}\n${JSON.stringify(activity.result, null, 2)}`);
  const text = parts.join('\n\n');
  if (!text) return '';
  return text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text;
}

function statusText(activity: ToolActivity, labels: { inProgress: string; waitingReview: string; executed: string }) {
  if (activity.status === 'running') return labels.inProgress;
  if (activity.status === 'pending') return labels.waitingReview;
  if (activity.status === 'done' && !isReadOnlyTool(activity.name, activity.arguments)) return labels.executed;
  return '';
}

function ToolCallRow({ activity, approval, pending, executing, unknown, unresolved, phase, onApprove, onReject, onChanged }: { activity: ToolActivity; approval?: Approval; pending: boolean; executing: boolean; unknown: boolean; unresolved: boolean; phase: '' | 'approve' | 'reject'; onApprove: (id: string) => void; onReject: (id: string) => void; onChanged: () => void }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  if (isAppChangeApproval(approval) && approval) return null;
  if (isTaskBatchApproval(approval) && approval) return <TaskBatchCard approval={approval} executing={executing} unknown={unknown} onApprove={onApprove} onReject={onReject} />;
  if (activity.name === 'load_skill') return <SkillUsageRow activity={activity} />;
  const payload = payloadText(activity, t('messageItem.arguments'), t('messageItem.result'));
  const label = toolLabels[activity.name] ?? activity.name;
  const failed = activity.status === 'error';
  const state = statusText(activity, { inProgress: t('messageItem.inProgress'), waitingReview: t('messageItem.waitingReview'), executed: t('messageItem.executed') });
  const header = (
    <>
      {payload ? <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} /> : <span className="size-3.5 shrink-0" />}
      <span className="shrink-0 font-medium">{label}</span>
      <span className={cn('min-w-0 flex-1 truncate', failed ? 'text-destructive' : 'text-muted-foreground')}>{activity.preview}</span>
      {state && <span className="shrink-0 text-[11px] text-muted-foreground">{state}</span>}
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

type LoadedSkill = { skillId?: string; name?: string; revision?: number; description?: string; instructions?: string };

/** 「使用技能：名称 vN」. The body comes from the stored tool result, so later edits never change an old conversation. */
function SkillUsageRow({ activity }: { activity: ToolActivity }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const skill = activity.result && typeof activity.result === 'object' ? activity.result as LoadedSkill : null;
  const body = activity.status === 'done' && typeof skill?.instructions === 'string' ? skill.instructions : '';
  const failed = activity.status === 'error';
  const header = <>
    {body ? <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} /> : <span className="size-3.5 shrink-0" />}
    <span className="shrink-0 font-medium">{failed ? t('messageItem.skillReadFailed') : activity.status === 'running' ? t('messageItem.skillReading') : t('messageItem.skillUsed')}</span>
    <span className={cn('min-w-0 flex-1 truncate', failed ? 'text-destructive' : 'text-foreground')}>{activity.status === 'running' ? (typeof activity.arguments.name === 'string' ? activity.arguments.name : '') : activity.preview}</span>
  </>;
  return (
    <div className="rounded-lg border border-border/80 bg-muted/40" data-testid="skill-usage" data-skill-revision={skill?.revision ?? ''}>
      {body ? <button type="button" aria-expanded={open} aria-label={t('messageItem.skillUsedLabel', { preview: activity.preview })} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]" onClick={() => setOpen((value) => !value)}>{header}</button>
        : <div className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">{header}</div>}
      {open && body && <div className="max-h-80 overflow-auto border-t border-border/70 px-3 py-2" data-testid="skill-usage-body">{skill?.description && <p className="mb-2 text-[11px] text-muted-foreground">{skill.description}</p>}<MarkdownView content={body} /></div>}
    </div>
  );
}

function ToolRun({ activities, approvalFor, pending, executingApprovalId, unknownApprovalIds, unresolvedApprovalIds, phase, onApprove, onReject, onChanged }: { activities: ToolActivity[]; approvalFor: (activity: ToolActivity) => Approval | undefined; pending: boolean; executingApprovalId: string; unknownApprovalIds: string[]; unresolvedApprovalIds: string[]; phase: '' | 'approve' | 'reject'; onApprove: (id: string) => void; onReject: (id: string) => void; onChanged: () => void }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border/80 bg-muted/40">
      <button type="button" aria-expanded={open} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]" onClick={() => setOpen((value) => !value)}>
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="font-medium">{t('messageItem.lookupCount', { count: activities.length })}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 border-t border-border/70 p-1.5">
          {activities.map((activity) => {
            const approval = approvalFor(activity);
            return <ToolCallRow key={activity.toolCallId} activity={activity} approval={approval} pending={pending} executing={approval?.approvalId === executingApprovalId} unknown={Boolean(approval && unknownApprovalIds.includes(approval.approvalId))} unresolved={Boolean(approval && unresolvedApprovalIds.includes(approval.approvalId))} phase={phase} onApprove={onApprove} onReject={onReject} onChanged={onChanged} />;
          })}
        </div>
      )}
    </div>
  );
}

function looksLikeJson(content: string) {
  const trimmed = content.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

export function MessageItem({ message, approvals = [], approvalPending = false, executingApprovalId = '', unknownApprovalIds = [], unresolvedApprovalIds = [], phase = '', onApprove = () => undefined, onReject = () => undefined, onChanged = () => undefined, onRepreviewed }: { message: ChatMessage; approvals?: Approval[]; approvalPending?: boolean; executingApprovalId?: string; unknownApprovalIds?: string[]; unresolvedApprovalIds?: string[]; phase?: '' | 'approve' | 'reject'; onApprove?: (id: string) => void; onReject?: (id: string) => void; onChanged?: () => void; onRepreviewed?: (body: { approvalId?: string; previewHash?: string; supersedesApprovalId?: string; approval?: { id: string; status: string; toolName: string; conversationId?: string | null; envelope?: unknown } }) => void }) {
  const { t } = useTranslation('chat');
  const role = message.role;
  if (role === 'tool') return null;
  const roleLabels: Record<string, string> = { user: t('messageItem.role.user'), assistant: t('messageItem.role.assistant'), tool: t('messageItem.role.tool'), system: t('messageItem.role.system') };
  const label = roleLabels[role] ?? role;
  const streaming = message.status === 'streaming';
  const failed = message.status === 'failed';
  const content = message.content || (streaming ? t('messageItem.streaming') : '');
  const approvalFor = (activity: ToolActivity) => approvals.find((item) => item.approvalId === activity.approvalId || item.toolCallId === activity.toolCallId);
  const groups = groupToolActivities(message.tools ?? []);
  if (role === 'assistant' && !content && !failed && groups.length === 0 && !message.parts?.length && !message.blocks?.length) return null;

  return (
    <div
      className={cn(
        'rounded-xl px-3 py-2.5',
        role === 'user' && 'ml-auto max-w-[90%] rounded-2xl bg-muted/70',
        failed && 'border-2 border-destructive/50 bg-destructive/10',
        role === 'system' && 'bg-transparent px-1 py-1.5'
      )}
    >
      {(content || role !== 'assistant') && (
        <span className={cn('mb-1 block text-[11px] font-bold tracking-wide', failed ? 'text-destructive' : 'text-muted-foreground')}>
          {label}{failed ? t('messageItem.outputFailed') : ''}
        </span>
      )}
      {message.blocks?.length ? <MessageBlocks blocks={message.blocks} /> : content && (role === 'system' && !streaming ? (
        looksLikeJson(content) ? (
          <pre className="glass-subtle overflow-x-auto rounded-lg p-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">{content}</pre>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">{content}</p>
        )
      ) : streaming ? (
        <p className="streaming-caret text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">{content}</p>
      ) : (
        <MarkdownView content={content} diagrams={!failed && (role === 'user' || role === 'assistant')} />
      ))}
      {message.role === 'assistant' && content && !streaming && <Button variant="ghost" size="icon-xs" className="mt-2 text-muted-foreground" aria-label={t('messageItem.copyReply')} onClick={() => void navigator.clipboard.writeText(message.content).then(() => toast.success(t('messageItem.replyCopied')), () => toast.error(t('clipboard.copyFailed')))}><Copy /></Button>}
      {message.role === 'user' && <ContextSummary context={message.context} />}
      <SourceLinks sources={message.sources ?? []} />
      {groups.length > 0 && (
        <div className={cn('flex flex-col gap-1.5', content && 'mt-2')}>
          {groups.map((group) => group.kind === 'run' ? (
            <ToolRun key={group.activities.map((item) => item.toolCallId).join('-')} activities={group.activities} approvalFor={approvalFor} pending={approvalPending} executingApprovalId={executingApprovalId} unknownApprovalIds={unknownApprovalIds} unresolvedApprovalIds={unresolvedApprovalIds} phase={phase} onApprove={onApprove} onReject={onReject} onChanged={onChanged} />
          ) : (
            <ToolCallRow key={group.activity.toolCallId} activity={group.activity} approval={approvalFor(group.activity)} pending={approvalPending} executing={approvalFor(group.activity)?.approvalId === executingApprovalId} unknown={Boolean(approvalFor(group.activity) && unknownApprovalIds.includes(approvalFor(group.activity)!.approvalId))} unresolved={Boolean(approvalFor(group.activity) && unresolvedApprovalIds.includes(approvalFor(group.activity)!.approvalId))} phase={phase} onApprove={onApprove} onReject={onReject} onChanged={onChanged} />
          ))}
        </div>
      )}
      {approvalsOnMessage(message, approvals).filter(isAppChangeApproval).map((approval) => <ReviewCard key={approval.approvalId} approval={approval} phase={approval.approvalId === executingApprovalId ? phase : ''} unknown={unknownApprovalIds.includes(approval.approvalId)} unresolved={unresolvedApprovalIds.includes(approval.approvalId)} onApprove={onApprove} onReject={onReject} onChanged={onChanged} onRepreviewed={onRepreviewed} />)}
      {message.parts?.map((part) => part.type === 'worktree_cleanup' ? <WorktreeCleanupChatCard key={part.id} cleanupId={part.cleanupId} /> : <ExternalPromptCard key={part.id} part={part} />)}
    </div>
  );
}
