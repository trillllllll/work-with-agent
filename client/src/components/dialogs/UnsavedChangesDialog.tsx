import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';

type UnsavedChangesDialogProps = {
  busy?: boolean;
  /** Hide the save option when the draft cannot be saved yet (validation, conflict). */
  canSave?: boolean;
  /** Omit when the editor has no save action; the dialog then offers keep/discard only. */
  onSave?: () => void;
  onKeep: () => void;
  onDiscard: () => void;
};

/** Shared three-option guard for editors with unsaved work; mirrors the task detail leave dialog. */
export function UnsavedChangesDialog({ busy = false, canSave = true, onSave, onKeep, onDiscard }: UnsavedChangesDialogProps) {
  const { t } = useTranslation('common');
  return <Dialog open onOpenChange={(open) => { if (!open) onKeep(); }}>
    <DialogContent showCloseButton={false} surface="glass">
      <DialogHeader>
        <DialogTitle>{t('unsaved.title')}</DialogTitle>
        <DialogDescription>{t('unsaved.description')}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={onKeep}>{t('unsaved.keepEditing')}</Button>
        <Button variant="outline" disabled={busy} onClick={onDiscard}>{t('unsaved.discard')}</Button>
        {onSave && canSave && <Button disabled={busy} onClick={onSave}>{busy ? t('unsaved.saving') : t('unsaved.saveAndContinue')}</Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
