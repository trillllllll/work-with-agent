import { useId, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { Button } from './button.js';
import { Surface } from './surface.js';

type Choice = { id: string; label: string; description?: string; icon?: ReactNode };

export function ChoiceList({ label, options, value, onChange, disabled }: {
  label: string;
  options: Choice[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const labelId = useId();
  return <div className="grid min-w-0 gap-1.5">
    <span id={labelId} className="text-xs font-medium text-muted-foreground">{label}</span>
    <RadioGroup.Root asChild aria-labelledby={labelId} orientation="vertical" value={value} onValueChange={onChange} disabled={disabled}>
      <Surface tone="sheet" className="workspace-rows">
        {options.map((option) => <RadioGroup.Item key={option.id} value={option.id} asChild>
          <Button type="button" size="bare" variant="row" data-selected={option.id === value || undefined}
            className="workspace-row flex min-h-11 w-full items-center gap-3 px-2 py-2 text-left">
            {option.icon && <span aria-hidden="true" className="shrink-0 text-muted-foreground">{option.icon}</span>}
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <span className="block text-sm font-medium">{option.label}</span>
              {option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}
            </span>
            <RadioGroup.Indicator><Check aria-hidden="true" className="size-4 shrink-0 text-brand-link" /></RadioGroup.Indicator>
          </Button>
        </RadioGroup.Item>)}
      </Surface>
    </RadioGroup.Root>
  </div>;
}
