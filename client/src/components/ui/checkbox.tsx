import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.js';

/** Native form semantics, including labels, onChange, indeterminate refs and form reset. */
export function Checkbox({ className, shape = 'square', ...props }: Omit<ComponentProps<'input'>, 'type'> & { shape?: 'square' | 'round' }) {
  return <input type="checkbox" data-slot="checkbox" data-shape={shape} className={cn('surface-choice', className)} {...props} />;
}

export function Radio({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <input type="radio" data-slot="radio" className={cn('surface-choice', className)} {...props} />;
}
