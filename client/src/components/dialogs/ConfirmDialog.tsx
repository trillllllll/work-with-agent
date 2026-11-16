import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';

type ConfirmDialogProps = {
  title: string;
  /** Emphasized subject line. Omitted for prompts that only carry a description. */
  itemName?: string;
  description: string;
  busy?: boolean;
  /** Replaces the default confirm label. Omitted callers keep "确认". */
  confirmLabel?: string;
  /** Confirm button tone; destructive (red) is the default for dangerous operations. */
  tone?: 'destructive' | 'default';
  /** Extra content between the item name and the actions. Kept out of the description paragraph. */
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({ title, itemName, description, busy = false, confirmLabel, tone = 'destructive', children, onCancel, onConfirm }: ConfirmDialogProps) {
  const { t } = useTranslation('settings');
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent showCloseButton={false} surface="glass">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap">{description}</DialogDescription>
        </DialogHeader>
        {itemName && <p className="text-base font-semibold break-all text-foreground">{itemName}</p>}
        {children}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>{t('actions.cancel')}</Button>
          <Button variant={tone} disabled={busy} onClick={onConfirm}>{busy ? t('confirmDialog.processing') : (confirmLabel ?? t('actions.confirm'))}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
