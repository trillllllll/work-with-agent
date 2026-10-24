import { Radio } from '@/components/ui/checkbox.js';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils.js';
import { hostInitials, hostLabel } from '@/lib/connection-status.js';

export const connectionHostIds = ['codex', 'claude', 'grok'] as const;

type HostPickerProps = {
  value: string;
  locked?: boolean;
  onChange: (host: string) => void;
};

export function HostPicker({ value, locked = false, onChange }: HostPickerProps) {
  const { t } = useTranslation('workspace');
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{t('connections.hostLabel')}</p>
        {locked && <p className="text-xs text-muted-foreground">{t('connections.hostLocked')}</p>}
      </div>
      <div role="radiogroup" aria-label={t('connections.hostLabel')} className="mt-2 grid gap-2 sm:grid-cols-3">
        {connectionHostIds.map((id) => {
          const selected = value === id;
          return (
            <label key={id} className={cn('relative flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', selected ? 'border-primary bg-muted text-foreground' : 'border-border hover:bg-muted/60', locked && 'cursor-not-allowed opacity-70')}>
              <Radio  name="connection-host" className="sr-only" value={id} checked={selected} disabled={locked} onChange={() => onChange(id)} />
              <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-[10px] font-semibold">{hostInitials(id)}</span>
              {hostLabel(id)}
            </label>
          );
        })}
      </div>
    </div>
  );
}
