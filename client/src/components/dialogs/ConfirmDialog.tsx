import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';

type ConfirmDialogProps = {
  title: string;
  itemName: string;
  description: string;
  busy?: boolean;
  /** Replaces the default confirm label. Omitted callers keep "确认". */
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({ title, itemName, description, busy = false, confirmLabel, onCancel, onConfirm }: ConfirmDialogProps) {
  const { t } = useTranslation('settings');
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent showCloseButton={false} surface="glass">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <p className="text-base font-semibold break-all text-foreground">{itemName}</p>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>{t('actions.cancel')}</Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>{busy ? t('confirmDialog.processing') : (confirmLabel ?? t('actions.confirm'))}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
