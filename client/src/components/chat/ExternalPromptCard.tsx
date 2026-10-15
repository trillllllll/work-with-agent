import { useState } from 'react';
import type { ExternalPromptPart } from '@/chat.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.js';

const titles: Record<string, string> = {
  web_research: '需要具备联网能力的 AI',
  local_execution: '需要具备本机执行能力的 AI',
  external_application: '需要能操作外部应用的 AI',
  other: '需要其他工具能力的 AI',
};

export function ExternalPromptCard({ part }: { part: ExternalPromptPart }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const title = part.title || titles[part.capability] || titles.other;
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard');
      await navigator.clipboard.writeText(part.prompt);
      setManual(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setManual(true);
      setOpen(true);
    }
  };
  return (
    <section className="task-batch-card" data-testid="external-prompt-card" aria-label={title}>
      <h2 className="task-batch-title">{title}</h2>
      <p className="task-batch-summary">{part.limitation}</p>
      <p className="task-batch-summary">下面已整理好查询要求，可以复制到支持对应能力的 AI 中。</p>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="review-tech-trigger">{open ? '收起提示词' : '查看提示词'}</CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="external-prompt-body" data-testid="external-prompt-body">{part.prompt}</pre>
        </CollapsibleContent>
      </Collapsible>
      {manual && (
        <label className="task-batch-summary">
          手动复制
          <textarea className="external-prompt-manual" readOnly value={part.prompt} aria-label="手动复制" />
        </label>
      )}
      <div className="task-batch-actions">
        <button type="button" className="task-batch-primary" onClick={() => void copy()}>{copied ? '已复制' : '复制提示词'}</button>
      </div>
      <p className="task-batch-summary">拿到结果后可以粘贴回来，我可以继续整理成资料或任务。</p>
    </section>
  );
}
