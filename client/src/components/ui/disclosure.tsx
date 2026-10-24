import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.js';
import { Surface } from './surface.js';

/** Native disclosures preserve open/default-open, keyboard behavior and persisted DOM. */
export function Disclosure({ tone, ...props }: ComponentProps<'details'> & { tone?: 'card' | 'subtle' }) {
  return tone ? <Surface as="details" tone={tone} data-slot="disclosure" {...props} /> : <details data-slot="disclosure" {...props} />;
}

export function DisclosureTrigger({ className, ...props }: ComponentProps<'summary'>) {
  return <summary data-slot="disclosure-trigger" className={cn('surface-action surface-action-row cursor-pointer', className)} {...props} />;
}
