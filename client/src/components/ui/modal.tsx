import { useRef, type ComponentProps, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogPortal } from './dialog.js';
import { cn } from '@/lib/utils.js';

/** Controlled, triggerless dialogs share the same portal, material and focus behavior. */
export function Modal({ title, onClose, children, modal = true, workspace = false, className, onCloseAutoFocus, onInteractOutside, ...props }: Omit<ComponentProps<typeof DialogContent>, 'title'> & {
  title: ReactNode;
  onClose: () => void;
  modal?: boolean;
  /** Keep the assistant usable, and center within the remaining workspace. */
  workspace?: boolean;
}) {
  const opener = useRef(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return <Dialog open modal={workspace ? false : modal} onOpenChange={open => { if (!open) onClose(); }}>
    {workspace && <DialogPortal><div className="surface-modal-backdrop" data-workspace-dialog-overlay="" aria-hidden="true" /></DialogPortal>}
    <DialogContent showCloseButton={false} aria-describedby={undefined} onCloseAutoFocus={event => {
      onCloseAutoFocus?.(event);
      if (!event.defaultPrevented && opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); }
    }} onInteractOutside={event => { onInteractOutside?.(event); if (workspace) event.preventDefault(); }} data-workspace-dialog={workspace || undefined} className={cn('max-h-[min(720px,calc(100dvh-32px))] w-[min(560px,calc(100vw-32px))] max-w-none overflow-y-auto p-4', workspace && 'z-[var(--layer-workspace-dialog)]', className)} {...props}>
      <DialogTitle className="sr-only">{title}</DialogTitle>
      {children}
    </DialogContent>
  </Dialog>;
}
