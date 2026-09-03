import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';

type DialogProps = {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
};

const focusableSelector = [
  '[data-dialog-initial]',
  '[autofocus]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[href]',
].join(',');

function getFocusable(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    const styles = window.getComputedStyle(element);
    return styles.visibility !== 'hidden' && styles.display !== 'none';
  });
}

export function Dialog({ title, description, onClose, children }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    const initialFocus = dialog ? getFocusable(dialog)[0] : null;
    initialFocus?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = getFocusable(dialog);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropClick}>
      <section
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-heading">
          <div>
            <span className="modal-kicker">工作台操作</span>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <button className="close-button" type="button" title="关闭" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

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
    <Dialog title={title} description={description} onClose={onCancel}>
      <div className="confirm-copy">
        <p>你即将删除</p>
        <strong>{itemName}</strong>
        <p className="confirm-warning">此操作无法撤销。</p>
      </div>
      <div className="modal-actions">
        <button className="secondary" type="button" data-dialog-initial disabled={busy} onClick={onCancel}>取消</button>
        <button className="danger-button" type="button" disabled={busy} onClick={onConfirm}>{busy ? '正在删除…' : '确认删除'}</button>
      </div>
    </Dialog>
  );
}
