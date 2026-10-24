import { Surface } from '@/components/ui/surface.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Button } from '@/components/ui/button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExternalPromptPart } from '@/chat.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.js';

const capabilities = new Set(['web_research', 'local_execution', 'external_application', 'other']);

export function ExternalPromptCard({ part }: { part: ExternalPromptPart }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const title = part.title || (capabilities.has(part.capability) ? t(`externalPrompt.capability.${part.capability}`) : t('externalPrompt.capability.other'));
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
    <Surface as="section" tone="card" className="task-batch-card" data-testid="external-prompt-card" aria-label={title}>
      <h2 className="task-batch-title">{title}</h2>
      <p className="task-batch-summary">{part.limitation}</p>
      <p className="task-batch-summary">{t('externalPrompt.ready')}</p>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="review-tech-trigger">{open ? t('externalPrompt.collapse') : t('externalPrompt.view')}</CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="external-prompt-body" data-testid="external-prompt-body">{part.prompt}</pre>
        </CollapsibleContent>
      </Collapsible>
      {manual && (
        <label className="task-batch-summary">
          {t('externalPrompt.manualCopy')}
          <Textarea className="external-prompt-manual" readOnly value={part.prompt} aria-label={t('externalPrompt.manualCopy')} />
        </label>
      )}
      <div className="task-batch-actions">
        <Button variant="default" size="bare" type="button" className="task-batch-primary" onClick={() => void copy()}>{copied ? t('externalPrompt.copied') : t('externalPrompt.copy')}</Button>
      </div>
      <p className="task-batch-summary">{t('externalPrompt.pasteBack')}</p>
    </Surface>
  );
}
