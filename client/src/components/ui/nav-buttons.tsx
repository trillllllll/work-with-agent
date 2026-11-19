import type { ReactNode } from 'react';
import { ArrowLeft, X } from 'lucide-react';

import { Button } from '@/components/ui/button';

/** Unified leading actions: back and close share geometry (ghost round button, 36px, size-4 icon,
 * muted foreground that brightens on hover) and differ only in glyph — × leaves, ← goes back. */

/** Icon-only close for dialog and panel headers; the label is the localized aria-label. */
export function CloseIconButton({ label, onClick }: {
  label: string;
  onClick?: () => void;
}) {
  return <Button type="button" variant="ghost" size="icon" aria-label={label} onClick={onClick} className="shrink-0 rounded-full text-foreground/70 hover:text-foreground"><X /></Button>;
}

/** Back affordance with an optional label; without one it matches the close button geometry. */
export function BackButton({ label, onClick, className, children }: {
  /** Localized visible text; omit for the icon-only variant (keep an aria-label via children). */
  label?: string;
  onClick?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return <Button type="button" variant="ghost" onClick={onClick} className={`h-9 min-w-0 gap-1.5 rounded-full px-2.5 text-sm font-medium text-foreground/70 hover:text-foreground ${className ?? ''}`}>
    <ArrowLeft className="size-4 shrink-0" />
    {label && <span className="truncate">{label}</span>}
    {children}
  </Button>;
}
