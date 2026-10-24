import { Surface } from '@/components/ui/surface.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import type { Approval } from '@/chat.js';
import { api, toolLabels } from '@/lib/api.js';
import { usePlatformAction } from '@/lib/platform.js';
import { cn } from '@/lib/utils.js';
import { Button } from '@/components/ui/button.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.js';

function formatValue(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function truncate(text: string, max = 80) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function ApprovalCard({ approval, pending, onApprove, onReject }: { approval: Approval; pending: boolean; onApprove: (id: string) => void; onReject: (id: string) => void }) {
  const { t } = useTranslation('chat');
  const { run, busy } = usePlatformAction();
  const [open, setOpen] = useState(false);
  const entries = Object.entries(approval.arguments ?? {});
  const totalLength = JSON.stringify(approval.arguments ?? {}).length;
  const collapsible = entries.length > 3 || totalLength > 200;

  const params = (
    <dl className="mt-2 flex flex-col gap-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-2 text-[11px]">
          <dt className="shrink-0 font-mono text-muted-foreground">{key}</dt>
          <dd className="min-w-0 truncate font-mono" title={formatValue(value)}>{truncate(formatValue(value))}</dd>
        </div>
      ))}
      {!entries.length && <p className="text-[11px] text-muted-foreground">{t('approval.noParams')}</p>}
    </dl>
  );

  return (
    <Surface as="div" tone="subtle" className="rounded-xl border-warning-border bg-warning-bg/75 p-3">
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-3.5 shrink-0 text-warning" />
        <span className="text-[11px] font-bold tracking-[0.06em] text-warning uppercase">{t('approval.needsReview')}</span>
      </div>
      <strong className="mt-1.5 block text-[13px] font-semibold">{toolLabels[approval.toolName] ?? approval.toolName}</strong>
      {approval.resultState === 'unreadable' && <p className="mt-1.5 text-[12px] text-destructive">{t('approval.unreadableResult')}</p>}
      {collapsible ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
            {open ? t('approval.collapseParams') : t('approval.viewParams', { count: entries.length })}
          </CollapsibleTrigger>
          <CollapsibleContent>{params}</CollapsibleContent>
        </Collapsible>
      ) : (
        params
      )}
      {!approval.toolName.startsWith('execute_') && <Button className="mt-3" size="sm" variant="outline" disabled={busy || pending} onClick={() => void run(async () => { const result = await api(`/api/agent/approvals/${approval.approvalId}/preview`, { method: 'POST', body: '{}' }); window.location.hash = '/proposals'; return result; }, t('approval.checkImpact'))}>{t('approval.repreview')}</Button>}
      <div className="mt-3 flex justify-end gap-2 max-md:grid max-md:w-full max-md:grid-cols-2">
        <Button variant="outline" size="sm" disabled={pending} onClick={() => onReject(approval.approvalId)}>{t('actions.reject')}</Button>
        <Button size="sm" disabled={pending} onClick={() => onApprove(approval.approvalId)}>{t('approval.approve')}</Button>
      </div>
    </Surface>
  );
}
