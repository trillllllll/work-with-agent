import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.js';

/** Shares the input material with Radix Select, while keeping native option/form APIs. */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select data-slot="native-select" className={cn('glass-control h-9 max-w-full min-w-0 px-3 text-sm disabled:cursor-not-allowed', className)} {...props} />;
}
