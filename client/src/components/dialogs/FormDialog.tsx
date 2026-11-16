import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';

type FormDialogProps = {
  title: string;
  description?: string;
  onClose: () => void;
  /** Return true to veto this close attempt (Esc or overlay); the caller owns the follow-up UI. */
  confirmClose?: () => boolean;
  children: ReactNode;
};

export function FormDialog({ title, description, onClose, confirmClose, children }: FormDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !confirmClose?.()) onClose(); }}>
      <DialogContent surface="glass" className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b glass-divider px-5 py-4">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
