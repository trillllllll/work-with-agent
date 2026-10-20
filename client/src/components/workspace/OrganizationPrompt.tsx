import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { organizationMcpPrompt } from '@/lib/organization-prompt.js';
import { Button } from '@/components/ui/button.js';

export function OrganizationPrompt({ id, purpose }: { id: string; purpose: string }) {
  const { t } = useTranslation('workspace');
  const [copied, setCopied] = useState(false);
  const prompt = organizationMcpPrompt({ id, purpose });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      toast.error(t('organization.copyFailed'));
    }
  };
  return <div className="space-y-2"><p className="text-xs text-muted-foreground">{t('organization.hint')}</p><pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs" aria-label={t('organization.promptLabel', { id })}>{prompt}</pre><Button type="button" variant="outline" size="sm" aria-label={t('organization.copyLabel', { id })} onClick={() => void copy()}>{copied ? t('organization.copied') : t('organization.copy')}</Button></div>;
}
