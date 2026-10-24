import type { ComponentProps, ElementType } from 'react';
import { cn } from '@/lib/utils.js';

const surfaces = { card: 'glass-surface', subtle: 'glass-subtle', input: 'glass-control', overlay: 'glass-overlay', panel: 'surface-panel' };

/** A material, not a layout: the owner supplies spacing, dimensions and scrolling. */
export function Surface<T extends ElementType = 'div'>({ as, tone = 'card', className, ...props }: {
  as?: T;
  tone?: keyof typeof surfaces;
  className?: string;
} & Omit<ComponentProps<T>, 'as' | 'className' | 'tone'>) {
  const Comp: ElementType = as ?? 'div';
  return <Comp data-slot="surface" data-surface={tone} className={cn(surfaces[tone], className)} {...props} />;
}
