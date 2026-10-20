import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label.js';
import { Switch } from '@/components/ui/switch.js';

export const connectionOperationIds = ['task.create', 'task.content', 'task.schedule', 'task.complete', 'task.result'] as const;

const labelKey: Record<(typeof connectionOperationIds)[number], string> = {
  'task.create': 'connections.operations.create',
  'task.content': 'connections.operations.content',
  'task.schedule': 'connections.operations.schedule',
  'task.complete': 'connections.operations.complete',
  'task.result': 'connections.operations.result',
};

type AutoActionSwitchesProps = {
  value: string[];
  onChange: (next: string[]) => void;
};

export function AutoActionSwitches({ value, onChange }: AutoActionSwitchesProps) {
  const { t } = useTranslation('workspace');
  const prefix = useId();
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(value);
    if (checked) next.add(id);
    else next.delete(id);
    onChange(connectionOperationIds.filter((item) => next.has(item)));
  };
  return (
    <div>
      <p className="text-sm font-medium">{t('connections.autoSummary')}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t('connections.autoHint')}</p>
      <ul className="mt-2">
        {connectionOperationIds.map((id) => (
          <li key={id} className="flex items-center justify-between gap-3 border-b border-[var(--glass-divider)] py-2 last:border-b-0">
            <Label htmlFor={`${prefix}-${id}`} className="font-normal">{t(labelKey[id])}</Label>
            <Switch id={`${prefix}-${id}`} checked={value.includes(id)} onCheckedChange={(checked) => toggle(id, checked === true)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
