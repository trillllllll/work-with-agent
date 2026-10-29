import { AssistantProcess } from './AssistantProcess.js';
import { isProcessTool } from './assistant-process.js';
import { CitationContext } from './citation-context.js';
import type { AssistantSource } from '../../../../server/src/domain/assistant-source.js';
import { Surface } from '@/components/ui/surface.js';
import { MessageBlocks } from './MessageBlocks.js';
import { ContextSummary } from './ContextSummary.js';
import { SourceLinks, SourcePreview } from './SourceLinks.js';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Copy } from 'lucide-react';
import type { Approval, ChatMessage, ToolActivity } from '@/chat.js';
import { approvalsOnMessage, isReadOnlyTool } from '@/chat.js';
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
  const argumentsLabel = t('messageItem.arguments'), resultLabel = t('messageItem.result');
  const payload = useMemo(() => payloadText(activity, argumentsLabel, resultLabel), [activity, argumentsLabel, resultLabel]);
  if (isAppChangeApproval(approval) && approval) return null;
  if (isTaskBatchApproval(approval) && approval) return <TaskBatchCard approval={approval} executing={executing} unknown={unknown} onApprove={onApprove} onReject={onReject} />;
  if (activity.name === 'load_skill') return <SkillUsageRow activity={activity} />;
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
    <Surface as="div" tone="subtle" className="rounded-lg">
      {payload ? (
        <Button variant="row" size="bare" type="button" aria-expanded={open} aria-label={`${label} ${activity.preview}`} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]" onClick={() => setOpen((value) => !value)}>
          {header}
        </Button>
      ) : (
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">{header}</div>
      )}
      {open && payload && <pre className="max-h-24 overflow-auto border-t border-border/70 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">{payload}</pre>}
      {activity.status === 'pending' && approval && (
        <div className="px-2 pb-2">
          <ApprovalCard approval={approval} pending={pending} onApprove={onApprove} onReject={onReject} />
        </div>
      )}
    </Surface>
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
    <Surface as="div" tone="subtle" className="rounded-lg" data-testid="skill-usage" data-skill-revision={skill?.revision ?? ''}>
      {body ? <Button variant="row" size="bare" type="button" aria-expanded={open} aria-label={t('messageItem.skillUsedLabel', { preview: activity.preview })} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]" onClick={() => setOpen((value) => !value)}>{header}</Button>
        : <div className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">{header}</div>}
      {open && body && <div className="max-h-80 overflow-auto border-t border-border/70 px-3 py-2" data-testid="skill-usage-body">{skill?.description && <p className="mb-2 text-[11px] text-muted-foreground">{skill.description}</p>}<MarkdownView content={body} /></div>}
    </Surface>
  );
}

function looksLikeJson(content: string) {
  const trimmed = content.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

export function MessageItem({ message, processMessages, hideProcess = false, processActive = false, approvals = [], approvalPending = false, executingApprovalId = '', unknownApprovalIds = [], unresolvedApprovalIds = [], phase = '', onApprove = () => undefined, onReject = () => undefined, onChanged = () => undefined, onRepreviewed }: { message: ChatMessage; processMessages?: ChatMessage[]; hideProcess?: boolean; processActive?: boolean; approvals?: Approval[]; approvalPending?: boolean; executingApprovalId?: string; unknownApprovalIds?: string[]; unresolvedApprovalIds?: string[]; phase?: '' | 'approve' | 'reject'; onApprove?: (id: string) => void; onReject?: (id: string) => void; onChanged?: () => void; onRepreviewed?: (body: { approvalId?: string; previewHash?: string; supersedesApprovalId?: string; approval?: { id: string; status: string; toolName: string; conversationId?: string | null; envelope?: unknown } }) => void }) {
  const { t } = useTranslation('chat');
  const [selectedSource, setSelectedSource] = useState<AssistantSource | null>(null);
  const role = message.role;
  if (role === 'tool') return null;
  const roleLabels: Record<string, string> = { user: t('messageItem.role.user'), assistant: t('messageItem.role.assistant'), tool: t('messageItem.role.tool'), system: t('messageItem.role.system') };
  const label = roleLabels[role] ?? role;
  const streaming = message.status === 'streaming';
  const failed = message.status === 'failed';
  const content = message.content || (streaming && !message.reasoning?.text && !message.tools?.length ? t('messageItem.streaming') : '');
  const approvalFor = (activity: ToolActivity) => approvals.find((item) => item.approvalId === activity.approvalId || item.toolCallId === activity.toolCallId);
  const tools = (message.tools ?? []).filter(tool => !isProcessTool(tool));
  const process = processMessages ?? [message];
  const hasProcess = !hideProcess && process.some(item => item.reasoning?.text || item.tools?.some(isProcessTool));
  if (role === 'assistant' && !content && !failed && tools.length === 0 && !hasProcess && !message.parts?.length && !message.blocks?.length && !message.sources?.length) return null;

  return (
    <CitationContext.Provider value={{ sources: message.citationSources ?? message.sources ?? [], onSelect: setSelectedSource }}><div
      className={cn(
        'assistant-message min-w-0 rounded-xl px-3 py-2.5',
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
      {!hideProcess && <AssistantProcess messages={process} runActive={processActive} renderTool={(activity) => <ToolCallRow activity={activity} pending={false} executing={false} unknown={false} unresolved={false} phase="" onApprove={onApprove} onReject={onReject} onChanged={onChanged} />} />}
      {tools.length > 0 && <div className="flex flex-col gap-1.5">
        {tools.map(activity => <ToolCallRow key={activity.toolCallId} activity={activity} approval={approvalFor(activity)} pending={approvalPending} executing={approvalFor(activity)?.approvalId === executingApprovalId} unknown={Boolean(approvalFor(activity) && unknownApprovalIds.includes(approvalFor(activity)!.approvalId))} unresolved={Boolean(approvalFor(activity) && unresolvedApprovalIds.includes(approvalFor(activity)!.approvalId))} phase={phase} onApprove={onApprove} onReject={onReject} onChanged={onChanged} />)}
      </div>}
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
      <SourceLinks sources={message.sources ?? []} onSelect={setSelectedSource} />
      {approvalsOnMessage(message, approvals).filter(isAppChangeApproval).map((approval) => <ReviewCard key={approval.approvalId} approval={approval} phase={approval.approvalId === executingApprovalId ? phase : ''} unknown={unknownApprovalIds.includes(approval.approvalId)} unresolved={unresolvedApprovalIds.includes(approval.approvalId)} onApprove={onApprove} onReject={onReject} onChanged={onChanged} onRepreviewed={onRepreviewed} />)}
      {message.parts?.map((part) => part.type === 'worktree_cleanup' ? <WorktreeCleanupChatCard key={part.id} cleanupId={part.cleanupId} /> : <ExternalPromptCard key={part.id} part={part} />)}
    {selectedSource && <SourcePreview source={selectedSource} onClose={() => setSelectedSource(null)} />}
    </div></CitationContext.Provider>
  );
}
