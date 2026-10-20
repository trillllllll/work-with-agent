import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';

const quick = ['inaccurate', 'unneeded', 'duplicate', 'weakEvidence'] as const;

export function RejectPanel({ busy, conflict, onCancel, onConfirm }: { busy: boolean; conflict: boolean; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const { t } = useTranslation('proposals');
  const [reason, setReason] = useState('');
  const fill = (label: string) => {
    setReason((current) => {
      if (!current.trim()) return label;
      if (current.includes(label)) return current;
      return `${current}${t('listSeparator')}${label}`;
    });
  };
  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">{t('reject.optional')}</div>
      <div className="flex flex-wrap gap-2">
        {quick.map((id) => {
          const label = t(`reject.quick.${id}`);
          return <Button key={id} type="button" size="sm" variant="outline" onClick={() => fill(label)}>{label}</Button>;
        })}
      </div>
      <Textarea aria-label={t('reject.optional')} placeholder={t('reject.placeholder')} value={reason} onChange={(event) => setReason(event.target.value)} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>{t('edit.cancel')}</Button>
        <Button type="button" variant="destructive" disabled={busy || conflict} onClick={() => onConfirm(reason.trim())}>{t('reject.confirm')}</Button>
      </div>
    </div>
  );
}
