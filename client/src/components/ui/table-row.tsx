import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.js';

/** Data selection is separate from cell content and domain-specific status colors. */
export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr data-slot="table-row" className={cn('surface-data-row', className)} {...props} />;
}
