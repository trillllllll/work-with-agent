import type { ComponentProps } from 'react';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/utils.js';

/** Domain tag colors stay data-driven; read-only and clickable tags share one recipe. */
export function TagChip({ asChild = false, className, ...props }: ComponentProps<'span'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';
  return <Comp data-slot="tag-chip" className={cn('task-tag-chip', className)} {...props} />;
}
