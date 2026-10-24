import { useRef, type ReactElement, type ReactNode } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuItem } from './dropdown-menu.js';

/** Shared controlled menu composition: roving focus, Escape and trigger restoration. */
export function ActionMenu({ open, onOpenChange, trigger, children }: { open: boolean; onOpenChange: (open: boolean) => void; trigger: ReactElement; children: ReactNode }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
    <DropdownMenuTrigger ref={triggerRef} asChild>{trigger}</DropdownMenuTrigger>
    <DropdownMenuContent align="end" onInteractOutside={event => {
      // A closing menu can remain mounted for its exit animation. Its old
      // DismissableLayer must not dismiss a new opening from the same trigger.
      if (event.target instanceof Node && triggerRef.current?.contains(event.target)) event.preventDefault();
    }} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()}>{children}</DropdownMenuContent>
  </DropdownMenu>;
}

export { DropdownMenuItem as ActionMenuItem };
