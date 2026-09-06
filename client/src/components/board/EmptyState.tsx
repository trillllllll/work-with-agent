import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button.js';

type EmptyStateProps = {
  icon?: React.ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
};

export function EmptyState({ icon, title, description, actionLabel, onAction, secondaryActionLabel, onSecondaryAction }: EmptyStateProps) {
  return (
    <div className="grid min-h-[55vh] place-items-center py-16 text-center">
      <div>
        <div className="mx-auto grid size-14 place-items-center rounded-xl border border-primary/15 bg-accent text-primary">
          {icon ?? <Sparkles className="size-6" />}
        </div>
        <h2 className="mt-4 text-xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1.5 mb-5 text-sm text-muted-foreground">{description}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {actionLabel && onAction && <Button onClick={onAction}>{actionLabel}</Button>}
          {secondaryActionLabel && onSecondaryAction && (
            <Button variant="outline" className="lg:hidden" onClick={onSecondaryAction}>{secondaryActionLabel}</Button>
          )}
        </div>
      </div>
    </div>
  );
}
