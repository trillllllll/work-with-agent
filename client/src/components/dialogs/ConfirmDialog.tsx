import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';

type ConfirmDialogProps = {
  title: string;
  itemName: string;
  description: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({ title, itemName, description, busy = false, onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent showCloseButton={false} surface="glass" className="max-md:max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <p className="text-base font-semibold break-all text-foreground">{itemName}</p>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>{busy ? '正在处理…' : '确认'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
