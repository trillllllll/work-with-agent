import { Surface } from '@/components/ui/surface.js';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { hostInitials, hostLabel } from '@/lib/connection-status.js';
import { connectionHostIds } from './HostPicker.js';

type ConnectionEmptyProps = {
  onConnect: (host: string) => void;
};

export function ConnectionEmpty({ onConnect }: ConnectionEmptyProps) {
  const { t } = useTranslation('workspace');
  const steps = [
    { title: t('connections.emptyStep1Title'), hint: t('connections.emptyStep1Hint') },
    { title: t('connections.emptyStep2Title'), hint: t('connections.emptyStep2Hint') },
    { title: t('connections.emptyStep3Title'), hint: t('connections.emptyStep3Hint') },
  ];
  return (
    <Surface as="div" tone="subtle" className="rounded-xl px-5 py-8 text-center">
      <h2 className="text-lg font-semibold">{t('connections.emptyTitle')}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{t('connections.emptyDescription')}</p>
      <ol className="mt-6 grid gap-3 text-left sm:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="rounded-xl border border-border bg-muted/40 px-3 py-3">
            <p className="text-xs text-muted-foreground">{index + 1}</p>
            <p className="mt-1 text-sm font-medium">{step.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{step.hint}</p>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {connectionHostIds.map((id) => (
          <Button key={id} type="button" variant="outline" onClick={() => onConnect(id)}>
            <span aria-hidden="true" className="grid size-5 place-items-center rounded-md bg-muted text-[10px] font-semibold">{hostInitials(id)}</span>
            {t('connections.connectHost', { label: hostLabel(id) })}
          </Button>
        ))}
      </div>
    </Surface>
  );
}
